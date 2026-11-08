# 架构设计（ARCHITECTURE）

## 1. 总体结构

```
┌─────────────────────────────────────────────────────────────┐
│  Electron 渲染进程（Vue 3）                                  │
│  App.vue / AssignmentTable / SettingsPanel / SourceStatus    │
│  — 无 Node 权限、无凭证、CSP 限制 —                            │
└──────────────────────┬──────────────────────────────────────┘
                       │ contextBridge 白名单 IPC
┌──────────────────────┴──────────────────────────────────────┐
│  Electron 主进程                                             │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │ SyncEngine   │  │  AppStore     │  │ ReminderPlanner  │  │
│  │ 编排/缓存    │  │ electron-store│  │ 纯逻辑/可注入时钟 │  │
│  └──────┬───────┘  └───────────────┘  └──────────────────┘  │
│         │                                                    │
│  ┌──────┴──────────────────────────────┐                    │
│  │ AssignmentSource 适配器              │                    │
│  │  ├─ HwAssignmentSource   ✅ 已验证    │                    │
│  │  └─ UlearningSource      ❌ 未验证    │                    │
│  └──────┬──────────────────────────────┘                    │
└─────────┼───────────────────────────────────────────────────┘
          │ Playwright（channel: 'msedge'）
┌─────────┴───────────────────────────────────────────────────┐
│  受控 Microsoft Edge 实例（应用专属 userDataDir）             │
│  用户在此手工登录学校平台                                     │
│  — 与用户日常浏览器完全隔离，不共享 Cookie —                   │
└─────────────────────────────────────────────────────────────┘
```

## 2. 为什么用受控浏览器而不是直接 HTTP 请求

这是本项目最关键的架构决策，依据来自**实测**（见 PLATFORM_FINDINGS）：

1. **hw 平台**：登录走中央认证 CAS OAuth2，密码在前端加盐加密；会话是服务端 session cookie，
   浏览器关闭即失效。纯 HTTP 客户端需要复刻整套认证流程，风险高且脆弱。
2. **优学院 LMS**：使用 `AUTHORIZATION` cookie + 自定义请求头，401 时按业务 code 跳转超时页。
3. 需求明确要求"**不要关闭或绕过验证码/MFA**"。用真实浏览器让用户手工登录，
   是唯一既合规又稳健的方式。

因此：**Playwright Core + `channel: 'msedge'`（调用本机已安装的 Edge，不下载 Chromium）**，
使用应用专属 `userDataDir`，绝不触碰用户日常浏览器的 Cookie。

## 3. 数据流

### 同步
```
用户点「立即同步」/ 定时器触发
  → SyncEngine.syncAll()
      → 并发对每个平台 syncOne()
          → source.checkSession()
              → 未连接？ → 记 failed，保留旧缓存，结束
          → source.listAssignments()
              → 成功 → store.replaceAssignments() + lastSuccess
              → 空数组 → outcome = 'empty'（确认无作业）
              → 抛错 → classifyFailure() → 保留旧缓存 + 标记 stale
      → broadcast 快照给渲染进程
```

### 关键不变式

| 不变式 | 实现位置 |
|---|---|
| 一个平台失败不影响另一个 | `SyncEngine.do()` 用 `Promise.all` + 单个 `syncOne` 内部全捕获 |
| 失败不清空缓存 | `syncOne` 的 catch 分支只 `markSession`，不碰 `assignments` |
| "空"与"失败"严格区分 | `SyncOutcome` 是 discriminated union：`empty` vs `failed` |
| 并发同步不重复请求 | `SyncEngine.running` 复用同一个 Promise |

## 4. 安全设计

### Electron 侧
```ts
webPreferences: {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
}
```
- `will-navigate` 阻止渲染进程任意导航
- `setWindowOpenHandler` 只允许白名单域名在系统浏览器打开，其余 deny
- CSP：`default-src 'self'; script-src 'self'`，禁止内联与远程脚本
- preload 只通过 `contextBridge` 暴露 6 个方法，不暴露 `ipcRenderer`
- 主进程对每个 IPC 入参**重新校验**（渲染进程视为不可信）
- `app:openAssignment` 用 `isAllowedDetailUrl()` 做协议 + 域名双重校验

### 学校页面侧
- 学校页面运行在**独立 Playwright 浏览器**中，与 Electron 渲染进程完全隔离
- 不向学校页面注入任何系统 API
- 不读取、不导出 Cookie；`fetch` 在页面上下文内完成，凭证不出浏览器

### 凭证与日志
- 不保存密码
- 不打印 Cookie / Token / Authorization
- 诊断导出仅含版本、Edge 检测、状态统计
- `.gitignore` 覆盖会话目录、HAR、调研产物

## 5. 各模块职责

| 模块 | 路径 | 职责 |
|---|---|---|
| 领域模型 | `packages/shared/src/model/` | `Assignment`、`SyncOutcome`、日期归一化 |
| 适配器接口 | `packages/shared/src/source/` | `AssignmentSource` 契约 |
| 浏览器会话 | `src/main/browser/session.ts` | Edge 探测、持久化上下文、storageState |
| hw 适配器 | `src/main/sources/hw-source.ts` | 读取 `/api/student/plan` + `/api/student/homework`，归一化 |
| LMS 适配器 | `src/main/sources/ulearning-source.ts` | 课程读取（已验证）+ 维护页识别；作业接口未验证 |
| 同步编排 | `src/main/sync/sync-engine.ts` | 并发、失败隔离、缓存策略 |
| 提醒 | `src/main/reminder/planner.ts` | 幂等键、阈值计算、静默时段、文案 |
| 持久化 | `src/main/store/app-store.ts` | electron-store + schema 迁移 |
| IPC | `src/main/index.ts`、`src/preload/index.ts` | 白名单通道与入参校验 |
| 快照 | `src/main/ipc/snapshot.ts` | 组装脱敏的只读视图 |

## 6. 技术选型与理由

| 选择 | 理由 |
|---|---|
| **Electron 38** | 需求指定；Windows 托盘/通知/自启生态成熟 |
| **Vue 3 + TS** | 需求指定；组合式 API 适合中等复杂度界面 |
| **electron-vite** | 一条命令构建 main/preload/renderer，HMR 好，配置少 |
| **Playwright Core**（非 playwright） | 只需要驱动本机 Edge，不需要下载浏览器；`playwright` 会额外拉 Chromium |
| **`channel: 'msedge'`** | 复用系统已装的 Edge，安装包体积小，且 Edge 更新由系统维护 |
| **electron-store** | 原子写入 + schema 迁移，满足"小规模本地持久化"要求；无需原生模块，打包简单 |
| **未采用 SQLite** | 单用户、作业量级 < 1000 条，无需复杂查询；避免 Windows 原生模块重编译与打包风险 |
| **Vitest** | 与 Vite 同源，零额外配置，纯逻辑单测快 |
| **electron-builder NSIS** | 需求指定的安装包格式 |

## 7. 已知技术风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| hw 会话关闭浏览器即失效 | 重启后需重新登录 | 长驻浏览器 + storageState 落盘；失败时明确提示 |
| LMS 作业子系统独立域名且对外 404 | LMS 无法接通 | 需真实登录 + 可能需校园网；已明确标注未验证 |
| 平台改版 | 解析失败 | 适配器隔离；失败分类为 `structure_changed` 而非"零作业" |
| 打包后 Edge 路径差异 | 无法启动浏览器 | 显式探测两个标准路径 + 明确错误提示 |
| 无头模式被平台识别 | 登录失败 | 登录一律用 headed 模式 |
| Electron 打包后 preload 格式 | preload 加载失败 | 强制输出 CJS `index.js`（已修复并验证） |
