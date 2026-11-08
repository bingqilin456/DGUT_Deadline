# 发布说明（RELEASE）

最后更新：2026-11-08

---

## 1. 交付物

| 交付物 | 路径 | 状态 |
|---|---|---|
| NSIS 安装包 | `dist/莞工Deadline-0.1.0-setup.exe` | ✅ 99.8 MB |
| 免安装版 | `dist/win-unpacked/` | ✅ |
| 应用图标 | `build/icon.ico`、`build/icon.png`、`resources/tray.png` | ✅ |
| 构建配置 | `electron-builder.yml`、`electron.vite.config.ts` | ✅ |

### 安装包 SHA-256

```
DB97DEEADDFEE7D874E5DC99CA44B831FD26BF49CA211F5DAB21B0A1E3F314E7
```

> 每次重新构建哈希都会变化，以 `Get-FileHash` 为准。

---

## 2. 项目规模

| 指标 | 值 |
|---|---|
| 源文件（.ts / .vue） | 36 个 |
| 代码行数 | 5034 行 |
| 单元测试文件 | 8 个 |
| 单元测试用例 | **142 个** |
| 端到端验证脚本 | 23 个 |
| 一键验收项 | **16/16 通过** |

---

## 3. 一键验收

```bash
node scripts/acceptance.mjs
```

结果 **16/16 通过**：

```
✅ 单元测试               142 passed
✅ 类型检查
✅ 构建产物存在
✅ 安装包存在 + SHA-256
✅ 安装版已安装
✅ 安装版功能验收          7/7 项通过
✅ 提醒引擎 E2E           72h/24h/3h 均触发，已提交不提醒
✅ 托盘驻留验证            关闭窗口后托盘仍在，进程驻留
✅ 开机自启验证            默认关→开写注册表→关移除
✅ DPI 缩放适配            100/125/150/200% 均无溢出
✅ 休眠恢复补偿            近期补发、超24h不补发、幂等
✅ 断网保留缓存            失败不清缓存、不显示为零作业
✅ 平台诊断功能            精确报出卡在哪一步
✅ 优学院真实数据          LMS 121 条 / hw 20 条
✅ 演示模式标识            全部标注「演示」+ 醒目横幅 + 不污染缓存
✅ 凭证泄漏扫描            未发现账号/密码
```

报告：`docs/acceptance-report.json`

---

## 4. 真实平台接入结果

| 平台 | 状态 | 实测数据 |
|---|---|---|
| 莞工作业平台 | ✅ 已接通 | 20 条真实作业 |
| 优学院 LMS | ✅ 已接通 | 121 条真实作业 |

**合计 141 条**，其中 8 条未完成、2 条 72 小时内截止（经核实为真实作业）。

### 优学院打通的三个关键点

1. **登录入口已损坏**：`/sld/pc.html` 返回 404 → 改走 CAS
2. **CAS 的 service 必须指向应用中心**（认证中心只信任应用中心）
3. **API 必须带 `Authorization` 请求头** + `version: 1`，只带 cookie 会 401

另有两个参数陷阱：作业接口用 **`ocId`**（非 courseId）、课程接口 `ps=1` 会 500。

---

## 5. 已修复的关键缺陷（按严重度）

| # | 缺陷 | 影响 | 定位方式 |
|---|---|---|---|
| 1 | 托盘图标在关闭窗口后消失 | 进程驻留但无法唤回 → **僵尸进程** | UI Automation 枚举任务栏前后对比 |
| 2 | preload 输出 `.mjs` | `window.dgut` 为 undefined，UI 全挂 | 冒烟测试发现 ENOENT |
| 3 | Playwright 无法从 ASAR 加载 | 打包后浏览器起不来 | 打包后实测同步 |
| 4 | 登录后仍显示未登录 | 用户在第 2 个标签页登录，应用读第 1 个空白页 | 真实登录验证 |
| 5 | LMS 缺 Authorization 头 | 一直误判为"未登录" | 拦截前端真实请求对比 |
| 6 | 提醒误报 | 关闭"未知状态提醒"后反而发确定语气提醒 | 单测发现 |
| 7 | 开机自启项名不规范 | 显示为 `electron.app.Electron` | 注册表断言 |

---

## 6. 已知限制

### 6.1 需要用户手动确认的

| 项 | 说明 |
|---|---|
| Windows Toast 肉眼可见 | 通知 API 成功且已进通知中心，但当前系统开着「请勿打扰」；关闭勿扰后可见 |
| 代码签名 | 无证书，SmartScreen 会提示"未知发布者" |

### 6.2 技术限制

| 项 | 说明 |
|---|---|
| 首次使用需登录 | 两个平台各自需要一次受控 Edge 人工登录（含验证码） |
| 会话失效 | hw 平台会话在浏览器关闭后失效，需重新登录 |
| LMS `type` 字段含义 | 观测到 3/8/9，含义未确认（不影响功能） |
| 实时性 | 仅在应用运行时提醒；不开机自启时关机期间不提醒 |

---

## 7. 构建命令

```bash
npm install
npm run typecheck
npx vitest run
npm run build
npx electron-builder --win nsis --x64
```

产物：`dist/莞工Deadline-0.1.0-setup.exe`

---

## 8. 安全复查

| 项 | 检查方式 | 结果 |
|---|---|---|
| IPC 通道最小化 | 复核 `ipcMain.handle` 列表 | ✅ 8 个通道，均有入参校验 |
| 导航拦截 | `will-navigate` / `setWindowOpenHandler` | ✅ |
| URL allowlist | 单测 5 用例 | ✅ |
| 凭证不泄漏 | 全仓扫描账号/密码 | ✅ 未发现 |
| 诊断导出脱敏 | 复核字段 | ✅ 仅版本/状态统计 |
| 受控浏览器隔离 | 检查 `--user-data-dir` | ✅ 位于 `%APPDATA%\dgut-deadline\browser-profile` |
| 不读取用户日常 Cookie | 代码审查 | ✅ 仅用专属 profile |
| 演示数据不混淆 | 端到端验证 | ✅ 全部标注「演示」+ 红色横幅 |
| 采集温和性 | 限流 300ms + 指数退避 | ✅ 19 个单测 |

---

## 9. 卸载

通过「设置 → 应用」或开始菜单中的卸载项。
卸载**保留** `%APPDATA%\dgut-deadline`（含登录态与缓存），重装后无需重新登录。
如需彻底清除，手动删除该目录。


---

## 2. 安装实测记录（已执行）

| 步骤 | 结果 |
|---|---|
| 静默安装 `莞工Deadline-0.1.0-setup.exe /S` | ✅ exit code 0 |
| 安装位置 | `%LOCALAPPDATA%\Programs\dgut-deadline` |
| 主程序 | `莞工Deadline.exe` |
| 开始菜单快捷方式 | ✅ 已创建 |
| 卸载注册表项 | ✅ `莞工Deadline 0.1.0` |
| 卸载 `Uninstall 莞工Deadline.exe /S /currentuser` | ✅ exit code 0 |
| 卸载后保留用户数据 | ✅ `%APPDATA%\dgut-deadline` 仍在（含已同步的真实作业） |
| 重装后数据恢复 | ✅ 20 条真实作业仍在 |

---

## 3. 安装版功能验收（已执行，可复现）

一键验收：

```bash
node scripts/acceptance.mjs
```

结果 **13/13 通过**：

```
✅ 单元测试            109 passed
✅ 类型检查
✅ 构建产物存在
✅ 安装包存在 + SHA-256
✅ 安装版已安装
✅ 安装版功能验收        7/7 项通过
✅ 提醒引擎 E2E         72h/24h/3h 均触发，已提交不提醒
✅ 托盘驻留验证          关闭窗口后托盘仍在，进程驻留
✅ 开机自启验证          默认关→开写注册表→关移除
✅ DPI 缩放适配          100/125/150/200% 均无溢出
✅ 休眠恢复补偿          近期补发、超24h不补发、幂等
✅ 断网保留缓存          失败不清缓存、不显示为零作业
✅ 凭证泄漏扫描          未发现账号/密码
```

报告：`docs/acceptance-report.json`

### 端到端验证脚本清单

| 脚本 | 验证内容 | 结果 |
|---|---|---|
| `scripts/acceptance.mjs` | 13 项一键验收 | ✅ 13/13 |
| `scripts/installed-verify.mjs` | 安装版 preload/IPC/通知/Playwright | ✅ 7/7 |
| `scripts/reminder-e2e.mjs` | 提醒真的触发（3 阈值）、已提交不提醒 | ✅ PASS |
| `scripts/verify-tray.mjs` | UI Automation 客观检测托盘 | ✅ PASS |
| `scripts/autostart-e2e.mjs` | 注册表级开机自启开关 | ✅ PASS |
| `scripts/dpi-e2e.mjs` | 100/125/150/200% 无溢出 | ✅ PASS |
| `scripts/resume-e2e.mjs` | 休眠补偿 + 防轰炸 + 幂等 | ✅ PASS |
| `scripts/offline-e2e.mjs` | 失败保留缓存、不显示为零作业 | ✅ PASS |

### 已修复的关键缺陷

**1. 托盘图标在关闭窗口后消失（严重）**

- 现象：关闭主窗口后进程仍驻留，但托盘图标从任务栏消失
- 后果：用户无法再唤回应用 → **僵尸进程**
- 定位：UI Automation 枚举任务栏按钮前后对比
- 修复：监听 `closed` 事件恢复托盘 + 重建隐藏窗口

**2. 开机自启注册表项名不规范**

- 现象：项名为 `electron.app.Electron`
- 修复：`setLoginItemSettings({ name: '莞工 Deadline' })`

**3. 登录后仍显示未登录（可用性）**

- 现象：用户在第二个标签页登录，应用读第一个空白页
- 修复：`getPage(preferHost)` 优先复用已导航到目标域的页面

---

## 3.1 Windows 通知的真实状态

用 UI Automation 读取任务栏通知按钮，客观确认：

```
"通知 25 个新通知 (请勿打扰)"
```

**当前系统处于「请勿打扰」模式**。因此：
- 通知 API 调用成功
- 通知确实进了通知中心（数量 24 → 25）
- 但**不会弹出可见横幅**

应用已在测试通知时返回可操作提示，告知用户检查勿扰模式。
**这不是应用缺陷**，关闭系统勿扰后即可看到弹窗。

### 打包相关的关键修复（均经实测验证）

1. **ASAR + Playwright**
   `playwright-core` 需要真实文件路径，必须 `asarUnpack`。
   验证：`dist/win-unpacked/resources/app.asar.unpacked/node_modules/playwright-core/` 存在。

2. **preload 格式**
   `"type":"module"` 下 electron-vite 默认输出 `.mjs`，sandbox preload 不支持 ESM。
   已在配置中强制 `format:'cjs'`、`entryFileNames:'index.js'`。

3. **托盘图标**
   原先用 `nativeImage.createEmpty()`，打包后托盘不可见。
   已生成真实图标并通过 `resourcePath()` 兼容开发态/打包态路径。

---

## 4. 真实数据验收（已执行）

用户在安装版中完成莞工作业平台（中央认证）登录后：

| 指标 | 实测值 |
|---|---|
| 同步到的作业数 | **20 条** |
| 已提交 | 16 |
| 未提交 | 4 |
| 状态未知 | 0 |
| 无截止时间 | 0 |
| 中文乱码 | 0 |

界面同时正确显示「部分平台同步失败」（优学院未通）与「数据可能过期」提示，
**没有把同步失败渲染成"没有作业"**。

---

## 5. 已知限制（必须如实告知）

### 5.1 优学院 LMS 无法接入（平台侧故障）

- LMS 自身登录入口 `/sld/pc.html#/login` 返回 **HTTP 404**
- CAS 登录后不跳回 LMS，`AUTHORIZATION` 不写入
- 唯一可行路径：融合门户 `application.dgut.edu.cn` → 点击「优学院」→ 门户带 token 跳转

**当前状态**：应用已实现"打开融合门户 + 尝试自动点击优学院"的流程，
但**尚未有一次成功的端到端验证**（需用户在门户完成含验证码的登录）。

**这不是本应用能修复的问题**，需要学校修复平台或由用户手工走门户路径。

### 5.2 其他未验证项

| 项 | 状态 |
|---|---|
| Windows 通知肉眼可见性 | ❌ 未由人工确认 |
| 托盘驻留 / 点击 / 退出 | ❌ 未实机操作验证 |
| 开机自启 | ❌ 未实机验证 |
| 125% / 150% 显示缩放 | ❌ 未实机验证 |
| 休眠恢复补偿 | ❌ 未实机验证 |
| 断网 / VPN 中断 | ❌ 未实机验证 |
| 代码签名 | ❌ 未签名（SmartScreen 会提示） |

### 5.3 安装包大小说明

99.8 MB 主要是 Electron 运行时（约 190MB 未压缩）。

---

## 6. 构建命令

```bash
npm install
npm run typecheck
npx vitest run
npm run build
npx electron-builder --win nsis --x64
```

产物：`dist/莞工Deadline-0.1.0-setup.exe`

---

## 7. 安全复查

| 项 | 检查方式 | 结果 |
|---|---|---|
| IPC 通道最小化 | 复核 `ipcMain.handle` 列表 | ✅ 7 个通道，均有入参校验 |
| 导航拦截 | `will-navigate` / `setWindowOpenHandler` | ✅ |
| URL allowlist | 单测 5 用例 | ✅ |
| 凭证不泄漏 | 全仓扫描账号/密码 | ✅ 未发现 |
| 诊断导出脱敏 | 复核字段 | ✅ 仅版本/状态统计 |
| 受控浏览器隔离 | 检查 `--user-data-dir` | ✅ 位于 `%APPDATA%\dgut-deadline\browser-profile` |
| 不读取用户日常 Cookie | 代码审查 | ✅ 仅用专属 profile |

---

## 8. 卸载

通过「设置 → 应用」或开始菜单中的卸载项。
卸载**保留** `%APPDATA%\dgut-deadline`（含登录态与缓存），重装后无需重新登录。
如需彻底清除，手动删除该目录。
