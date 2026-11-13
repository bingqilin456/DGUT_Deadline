# 测试报告与证据（TESTING）

> 原则：**只记录实际执行过的测试**。未执行的明确写「未执行」。

最后更新：2026-11-08

---

## 1. 测试环境

| 项 | 值 |
|---|---|
| 操作系统 | Microsoft Windows 11 专业版 |
| Node.js | v24.11.1 |
| npm | 11.6.2 |
| Electron | 38.8.6 |
| playright-core | 1.65.0 |
| Microsoft Edge | 156.0.4314.58 |
| TypeScript | 5.9.3 |
| Vitest | 3.2.7 |

---

## 2. 单元测试

命令：`npx vitest run`

```
 ✓ packages/shared/src/model/datetime.test.ts   (21 tests)
 ✓ packages/shared/src/model/normalize.test.ts  (17 tests)
 ✓ src/main/reminder/planner.test.ts            (23 tests)
 ✓ src/main/sources/hw-source.test.ts           (22 tests)
 ✓ src/main/sync/sync-engine.test.ts            (14 tests)

 Test Files  5 passed (5)
      Tests  97 passed (97)
```

### 覆盖的关键不变量

| 不变量 | 用例数 | 说明 |
|---|---|---|
| 只有日期时不补 23:59 | 2 | `duePrecision='date'`，断言不含 `23:59` |
| 无截止时间保留 null | 3 | 含 `未设置截止日期`、空串、`-` |
| 非法日期不进位 | 1 | `2026-02-30` → none |
| UTC → Asia/Shanghai 换算 | 2 | 含跨日 |
| hw `deadline` 是布尔、`deadlineDate` 才是时间 | 1 | **核心回归测试** |
| 未提交/已提交/未知严格区分 | 5 | 含 `submitted=undefined`/`null` |
| 跳转 URL allowlist | 5 | 含钓鱼域名、`javascript:` |
| 失败分类 | 6 | DNS/超时/401/维护/改版/未知 |
| 提醒幂等去重 | 3 | 含改期后旧键失效 |
| 未知状态不误报 | 2 | **修复了会误发"即将截止"的缺陷** |
| 静默时段跨零点 | 7 | 含边界 23:00 / 07:00 |
| 失败不清空缓存 | 2 | 断言缓存仍有 2 条 |
| 空 vs 失败区分 | 4 | `empty` / `needs_login` / `network_blocked` / `maintenance` |
| 并发同步去重 | 2 | 3 次并发只请求平台 1 次 |
| 默认值（72/24/3、不自启） | 3 | |

### 测试过程中发现并修复的真实缺陷

1. **提醒误报缺陷**
   当用户关闭「未知状态提醒」时，代码把 `unknown` 作业的确定性降级为 `definite`，
   于是仍会发出"作业即将截止"的**确定语气**提醒——这正是需求明令禁止的误报。
   修复：`unknown` 且关闭该选项时，整条作业不提醒。

2. **`stale` 判定缺陷**
   原实现只在"上次成功距今 > 6 小时"时标记过期。刚同步成功后立即失败时，
   缓存字面很"新"，但已失去与平台的一致性，UI 不会提示过期。
   修复：本次同步失败即标记 `stale=true`。

3. **preload 加载失败（阻断级）**
   `"type":"module"` 下 electron-vite 把 preload 输出为 `index.mjs`，主进程按 `index.js` 加载，
   导致整个 `window.dgut` API 为 undefined、UI 完全不可用。
   修复：强制 preload 输出 CJS `index.js`。

---

## 3. 类型检查

```
npm run typecheck:node   → 通过（0 error）
npm run typecheck:web    → 通过（0 error）
```

---

## 4. 生产构建

命令：`npm run build`

```
out/main/index.js                    42.45 kB
out/preload/index.js                  0.78 kB
out/renderer/index.html               0.69 kB
out/renderer/assets/index-*.css       6.87 kB
out/renderer/assets/index-*.js      220.33 kB
✓ built
```

---

## 5. 应用启动验证（冒烟）

命令：`node scripts/smoke.mjs`

```
--- SMOKE: app alive after 8s ---
stderr: (仅有 UNDICI-EHPA 实验特性警告，无错误)
SMOKE_RESULT: PASS
```

验证点：
- Electron 主进程正常启动
- 无 preload 加载错误
- 无渲染进程未捕获异常

---

## 6. UI 渲染验证

命令：`node scripts/ui-shot.mjs`

实测 DOM 探测结果：
```json
{
  "title": "莞工 Deadline",
  "hasApp": true,
  "brand": "莞工 Deadline",
  "bodyLen": 180
}
```

截图：`docs/screenshots/main-window.png`（空状态）、`docs/screenshots/settings.png`

---

## 7. 端到端验证（真实数据）

命令：`node scripts/e2e-ui.mjs`

用 **2026-11-08 真机采集的 14 条真实作业** 填充 store，启动应用后断言 DOM：

```json
{
  "statNums": ["4", "0", "10"],
  "rowCount": 14,
  "chips": [
    "莞工作业平台· 已连接· 14 条 上次成功 2026/11/8 00:40:31",
    "优学院 LMS· 未连接· 0 条 可能过期 登录 从未成功同步"
  ]
}
```

- ✅ 统计卡片：未完成 4 / 72h 内截止 0 / 已完成 10 —— **与真实数据一致**
- ✅ 表格 14 行，字段（平台/作业/课程/截止/剩余/状态）全部正确
- ✅ 中文标题、课程名无乱码
- ✅ 时间显示为 `2026/10/10 23:00:00`（Asia/Shanghai）
- ✅ 已截止作业显示「已截止」+「已提交」

截图：`docs/screenshots/main-window-real-data.png`

### 关于「72 小时内截止 = 0」的核实
列表中最紧的未提交作业是「实验5」，截止 `2026-11-13 00:00`，
当前时间 `2026-11-08 00:40`，相差约 **119 小时**，确实超过 72 小时。
→ 该统计正确，不是缺陷。

---

## 8. 真实平台接入验证

### 8.1 hw 平台 ✅

| 步骤 | 结果 |
|---|---|
| 受控 Edge 打开 `https://hw.dgut.edu.cn/home` | ✅ 重定向到 `/login` |
| 用户手工完成中央认证登录 | ✅ |
| `GET /api/user/profile` | ✅ `code=0, userType="student"` |
| `GET /api/config` | ✅ `{startTime:"2026-08-31 08:00", xn:2026, xq:0}` |
| `GET /api/student/term` | ✅ `{startXn:2025, endXn:2026, endXq:0}` |
| `GET /api/student/plan` | ✅ `total=15`，本页 10 条 |
| `GET /api/student/homework` | ✅ `total=16`，本页 10 条 |
| 归一化后作业数 | ✅ **14 条**（两接口合流去重） |
| 状态统计 | ✅ 已提交 10 / 未提交 4 / unknown 0 |
| 截止时间解析 | ✅ 全部解析为 `+08:00` datetime，0 条失败 |

真实作业样本（4 条未提交）：
| 作业 | 课程 | 截止时间 |
|---|---|---|
| 实验5 | 面向对象程序设计(Java) | 2026-11-13 00:00 |
| 实验二 SQL查询实验 | 数据库系统原理 | 2026-11-21 23:00 |
| 作业三 SQL语言 | 数据库系统原理 | 2026-11-22 23:00 |
| 实验二_基于神经网络的图像分类 | 人工智能A | 2026-11-28 23:59 |

### 8.2 优学院 LMS ❌

| 步骤 | 结果 |
|---|---|
| 站点可达 | ✅ HTTP 200（维护已于 11-08 结束） |
| 维护页识别 | ✅ 已实现 503 + 公告特征匹配 |
| 首页接口 | ✅ 捕获到 `/courseapi/homepage/*` |
| `AUTHORIZATION` cookie | ❌ **缺失（未登录）** |
| 课程列表 | ❌ 需登录 |
| 作业接口 | ❌ 未拿到 |
| 作业子系统 `homework.dgut.edu.cn` | ❌ 302 → `nic.dgut.edu.cn/ymwzd404.htm` |

**结论：LMS 未接通。** 代码已主动抛出 `UnverifiedEndpointError`，不返回伪造数据。

---

## 9. 安装包与安装版验收（2026-11-08 执行）

### 9.1 打包

```
npx electron-builder --win nsis --x64
→ dist/莞工Deadline-0.1.0-setup.exe  (99.8 MB)
→ SHA-256: 36D42222033C350067A898A22CFB14321E935EF867AD6BA7877177D49FA6DCB6
```

### 9.2 安装 / 卸载

| 步骤 | 结果 |
|---|---|
| 静默安装 `/S` | ✅ exit 0 |
| 安装到 `%LOCALAPPDATA%\Programs\dgut-deadline` | ✅ |
| 开始菜单快捷方式 | ✅ |
| 卸载注册表项 | ✅ `莞工Deadline 0.1.0` |
| 静默卸载 `/S /currentuser` | ✅ exit 0 |
| 卸载后保留用户数据 | ✅ |
| 重装后数据恢复（20 条作业仍在） | ✅ |

### 9.3 安装版运行验收（CDP 断言）

```
✅ dom             —— UI 渲染、preload 加载、8 个 API
✅ ipc             —— getSnapshot 返回两个平台
✅ edgeDetected    —— browserReady: true
✅ notification    —— supported: true, shown: true
✅ playwrightLaunched —— 同步耗时 4.8s（浏览器真实启动）
✅ statesExplicit  —— 两平台均返回 needs_login
✅ userDataDir     —— %APPDATA%\dgut-deadline 建立
INSTALLED_APP_RESULT: PASS
```

### 9.4 打包相关缺陷与修复

| 缺陷 | 影响 | 修复 | 验证 |
|---|---|---|---|
| Playwright 无法从 ASAR 加载 | 浏览器起不来 | `asarUnpack: node_modules/playwright-core/**` | ✅ 解包目录存在且同步成功 |
| preload 输出 `.mjs` | `window.dgut` undefined，UI 全挂 | 强制 `format:'cjs'` + `entryFileNames:'index.js'` | ✅ |
| 托盘图标为空 | 打包后托盘不可见 | 生成真实 `.ico`/`.png` + `resourcePath()` | ✅ 图标已生成 |
| SPA 导航竞态 | `Execution context was destroyed` | `waitForStableUrl` + fetch 重试 3 次 | ✅ |
| 未登录被判为 `error` | 提示语误导 | 401 归类为 `needs_login` | ✅ |

---

## 10. 真实平台接入（安装版）

### 10.1 莞工作业平台 ✅ 已接通

用户在**安装版**中完成中央认证登录后，实测读到：

| 指标 | 值 |
|---|---|
| 作业总数 | **20 条** |
| 已提交 | 16 |
| 未提交 | 4 |
| 状态未知 | 0 |
| 无截止时间 | 0 |
| 中文乱码 | 0 |

4 条未提交作业：
| 作业 | 课程 | 截止 |
|---|---|---|
| 实验5 | 面向对象程序设计(Java) | 2026-11-13 00:00 |
| 实验二 SQL查询实验 | 数据库系统原理 | 2026-11-21 23:00 |
| 作业三 SQL语言 | 数据库系统原理 | 2026-11-22 23:00 |
| 实验二_基于神经网络的图像分类 | 人工智能A | 2026-11-28 23:59 |

### 10.2 优学院 LMS ❌ 平台侧故障，无法接入

| 探测项 | 结果 |
|---|---|
| LMS 登录按钮目标 `/sld/pc.html#/login` | **HTTP 404** |
| `/sld/`、`/portal/login.html`、`/courseapi/login` | **HTTP 404** |
| CAS 登录完成（拿到 `CASTGC`） | ✅ 但被跳转到融合门户 |
| 门户带 token 跳转的 URL 形态 | ✅ 确认 `#/index/courseList?AUTHORIZATION=<token>` |
| LMS `AUTHORIZATION` 是否写入 | ❌ 始终未写入 |
| 作业子系统 `homework.dgut.edu.cn` | ❌ 对外 302 → 404 |

**结论**：这不是应用代码问题，是学校平台的登录入口与 SSO 回跳故障。

**已实现的应对**：
- `connect()` 打开融合门户而非 404 的登录页
- 自动尝试点击门户中的「优学院」入口
- 提示语明确告知用户"平台故障"与三步可行操作
- 绝不返回空列表冒充"没有作业"

---

## 11. 端到端验证套件（2026-11-08 全面执行）

### 11.1 一键验收

```bash
node scripts/acceptance.mjs
```

结果：**18/18 通过**

```
✅ 单元测试            180 passed
✅ 类型检查
✅ 构建产物存在
✅ 安装包存在 + SHA-256  莞工Deadline-0.1.0-setup.exe 99.8MB
✅ 安装版已安装          %LOCALAPPDATA%\Programs\dgut-deadline
✅ 安装版功能验收        7/7 项通过
✅ 提醒引擎 E2E         72h/24h/12h/6h/3h 均触发，已提交不提醒
✅ 托盘驻留验证          关闭窗口后托盘仍在，进程驻留
✅ 开机自启验证          默认关→开写注册表→关移除
✅ DPI 缩放适配          100/125/150/200% 均无溢出
✅ 休眠恢复补偿          近期补发、超24h不补发、幂等
✅ 断网保留缓存          失败不清缓存、不显示为零作业
✅ 平台诊断功能          精确报出卡在哪一步
✅ 优学院真实数据          LMS 121 条 / hw 20 条
✅ 演示模式标识            全部标注「演示」+ 醒目横幅
✅ 凭证泄漏扫描          未发现账号/密码
✅ 提醒弹窗与确认        右下角弹窗 + 强制提醒 + 「我已知晓」
✅ 列表筛选功能          平台/课程/剩余/状态 + 默认排序
```

报告：`docs/acceptance-report.json`

### 11.2 提醒引擎端到端（`scripts/reminder-e2e.mjs`）

构造隔离用户数据，注入两条作业（3h 后截止，一条未提交、一条已提交）：

| 检查 | 结果 |
|---|---|
| 快照含 2 条作业 | ✅ |
| 触发阈值 | ✅ `3, 6, 12, 24, 72` 全部触发（1h 阈值因作业 3h 后截止而未到点）|
| 写入提醒记录 | ✅ 5 条幂等键 |
| 已提交作业不提醒 | ✅ 无 9002 相关键 |

幂等键样例：
```
hw:9001:2026-11-08T05:37:00+08:00:3
hw:9001:2026-11-08T05:37:00+08:00:24
hw:9001:2026-11-08T05:37:00+08:00:72
```

### 11.3 托盘驻留（`scripts/verify-tray.mjs`）

用 **UI Automation 枚举 Windows 任务栏按钮**，客观检测托盘图标（非目视）：

| 检查项 | 修复前 | 修复后 |
|---|---|---|
| 启动后托盘存在 | ✅ | ✅ |
| **关闭窗口后托盘仍在** | ❌ **消失** | ✅ |
| 关闭后进程驻留 | ✅ | ✅ |
| 窗口未被销毁 | ❌ | ✅ |

**这是本轮发现并修复的严重缺陷**：原实现在窗口被销毁后托盘图标消失，
应用变成"进程还在但用户无法唤回"的僵尸状态。
修复：监听 `closed` 事件恢复托盘 + 重建隐藏窗口。

### 11.4 开机自启（`scripts/autostart-e2e.mjs`）

通过注册表客观断言（无需真的重启）：

| 检查 | 结果 |
|---|---|
| 默认不自启（`HKCU\...\Run` 无项） | ✅ |
| 开启后写入注册表 | ✅ 项名 `莞工 Deadline` |
| 注册表值指向本应用 exe | ✅ |
| 关闭后注册表项被移除 | ✅ |
| 设置持久化到 store | ✅ |

### 11.5 DPI 缩放适配（`scripts/dpi-e2e.mjs`）

| 缩放 | 横向溢出 | 关键元素 |
|---|---|---|
| 100% | ❌ 无 | ✅ 完整 |
| 125% | ❌ 无 | ✅ 完整 |
| 150% | ❌ 无 | ✅ 完整 |
| 200% | ❌ 无 | ✅ 完整 |

截图见 `docs/screenshots/scale-*.png`。

### 11.6 休眠恢复补偿（`scripts/resume-e2e.mjs`）

构造两个作业验证补偿策略：

| 场景 | 预期 | 实测 |
|---|---|---|
| 2 小时前刚过截止 | 应补发 | ✅ 记录 3 个阈值 |
| 3 天前过截止 | 不应补发（防轰炸） | ✅ 无对应键 |
| 二次补偿 | 幂等，不重复 | ✅ 3 → 3 |

### 11.7 断网 / 失败保留缓存（`scripts/offline-e2e.mjs`）

预置 2 条缓存作业，让同步失败：

| 检查 | 结果 |
|---|---|
| 同步失败后缓存仍为 2 条 | ✅ |
| **未渲染成"零作业"** | ✅ `looksLikeNoHomework: false` |
| 状态明确为失败原因 | ✅ `needs_login`（非 connected） |
| 持久化层也保留 | ✅ |

这是需求最强调的行为：**失败绝不能被显示成"没有作业"**。

### 11.8 平台链路诊断（`scripts/diag-e2e.mjs`）

应用内「设置 → 平台诊断」可逐段检查接入链路，精确报告卡在哪一步。

> **2026-11-11 已更新**：优学院自身登录页 `/sld/pc.html` 经复核是**永久下线**（不是临时故障），
> 诊断不再把它当作阻塞项，改为检查「应用中心入口是否可达」+「token 是否经官方接口校验有效」。
> 详见 §13 与 `docs/PLATFORM_FINDINGS.md` §3.9。

实测输出（优学院，未登录状态）：

| 状态 | 检查项 | 实测结果 |
|---|---|---|
| 正常 | 应用中心登录入口（`application.dgut.edu.cn`） | HTTP 200 —— 可用（附注：旧登录页 `/sld/pc.html` 已 404，勿用） |
| 待进行 | 莞工中央认证 | 尚未访问（点击「登录」后自动打开） |
| 异常 | 中央认证授权票据 | 未签发 —— 需完成登录 |
| 异常 | 优学院会话校验 | HTTP 401，业务码 2001（跨域时明确说明"被浏览器拦截"，不伪装成平台故障） |
| 异常 | 优学院作业接口 | 尚未真机验证 |

**设计要点**：
- 先用真实 API 响应判定，不依赖 `document.cookie`；
- "尚未访问中央认证"标为**中性状态（待进行）**而非异常，避免误导；
- **token 存在 ≠ token 有效**：经 `GET /courseapi/users/isValidToken/<token>` 校验，
  失效时明确告知"登录已失效（这就是「网络错误」页的成因），不是断网"；
- 浏览器上下文已关闭时也**必须**返回可读结论（不能整体抛错）。

截图：`docs/screenshots/diagnostic-panel.png`

### 11.9 Windows 通知的客观状态

用 UI Automation 读取任务栏通知按钮：

```
"通知 25 个新通知 (请勿打扰)"
```

**客观确认当前 Windows 处于「请勿打扰」模式**：
- 通知 API 调用成功（`supported:true, shown:true`）
- 通知确实投递进通知中心（数量 24 → 25）
- 但**不会弹出可见横幅**

应用已在测试通知时返回可操作排查 `hint`，而非简单说"已发送"。

---

## 12. 仍未执行的测试（明确声明）

| 测试项 | 状态 | 原因 |
|---|---|---|
| Windows Toast 肉眼可见 | ⚠️ | **受系统勿扰模式阻塞**，需用户关闭勿扰 |
| 真实重启验证开机自启 | ⚠️ | 注册表已客观验证，但未重启 |
| 真实休眠/唤醒 | ⚠️ | 补偿逻辑已验证，但未真实休眠 |
| LMS 端到端登录 | ⏳ | 路径已破解并修复，等用户完成认证 |
| 代码签名 | ❌ | 无证书，SmartScreen 会提示 |


---

## 13. 2026-11-11 LMS 登录跳转修复验证

**背景**：用户报告两个 bug —— 点「立即同步」后受控 Edge 停在 LMS 课程列表显示
「网络错误，点击重新加载」；点「登录」后打开 `/sld/pc.html#/login` 得到 nginx 404。

### 13.1 真实平台探测（只读 GET，无凭证）

| 探测 | 结果 |
|---|---|
| `GET /sld/pc.html` | **404**（nginx，整目录已下线） |
| `GET /courseweb/ulearning/index.html` | 200 |
| `GET /ulearning/tip/timeout.html` | 200（LMS 官方会话失效页） |
| `GET /courseapi/users/isValidToken/<假token>` | 200，裸响应 `false` |
| `GET /organization/index.html` | 301 → `https://application.dgut.edu.cn/#/portal` |
| `GET /courseapi/courses/students`（无 token） | 401 |
| `GET https://application.dgut.edu.cn/#/login` | 200，页面含「校园统一身份认证登录」 |

**未登录时 LMS 实际导航轨迹**（浏览器实测）：
```
#/index/courseList → /ulearning/tip/timeout.html → / → application.dgut.edu.cn/#/portal
```

### 13.2 免密参数写法对照（本地桩，不含任何真实凭证）

用桩替换 `/courseapi/*` 阻止无效 token 触发的 logout 重定向，观测前端是否把参数落成 cookie：

| URL 写法 | 前端落成 `AUTHORIZATION` cookie |
|---|---|
| `#/index/courseList?token=xxx` | ✅ **是**（新实现采用） |
| `?token=xxx`（查询串） | ❌ 否 |
| `#/index/courseList?AUTHORIZATION=xxx` | ❌ 否（**旧实现，即 bug 根因**） |

结论与 `init.js` 源码一致：`var token = getHashParam("token")`。

### 13.3 端到端（`node scripts/lms-login-fix-e2e.mjs`）

真实 Electron + 真实受控 Edge + 隔离 profile（未登录态）。**结果：PASS**

| 检查 | 结果 |
|---|---|
| `login('ulearning')` 不抛错 | ✅ |
| 返回会话状态为明确值（非 error） | ✅ `needs_login` |
| 不再把人留在坏的 LMS 页面 | ✅ |
| 诊断中 `/sld` 步骤已移除 | ✅ |
| 诊断包含「应用中心入口」步骤 | ✅ |
| 受控 Edge 确实被拉起 | ✅ 8 个进程 |
| **点登录耗时** | ✅ **3.7–4.1 秒**（修复前 94 秒） |

修复前该脚本的 `login` 耗时 **94,185 ms** 且 `state: none`（因为 `app:login` 丢弃了
`connect()` 的返回值，UI 状态永不刷新）。

### 13.4 单元测试

| 文件 | 覆盖 |
|---|---|
| `ulearning-source.test.ts` | 登录入口永不为 `/sld/`；停在 LMS 时带去应用中心；CAS 页不打断；`token` 必须在 hash 段；token 编码 |
| `lms-diagnostic.test.ts` | 结论口径（失效≠断网、未登录引导登录）；浏览器已关闭时不抛错 |

`npm test`：**15 文件 / 369 项全部通过**；`npm run typecheck`、`npm run build` 通过。

### 13.5 未覆盖（明确声明）

- **真实已登录会话下的完整换票**：本次验证环境均无有效账号，只验证了
  "不再跳到坏页面"「参数写法正确」「浏览器被拉起」「诊断口径正确」。
  最后一公里（CAS 成功后 LMS 课程列表真的出数据）需用户实际登录确认。
- 应用中心页面上「点图标进优学院」的模拟点击未实现 —— 域级 cookie 共享，
  通常直接 `goto` LMS 即可，无需点击。


---

## 10. 复现方式

```bash
# 依赖
npm install

# 类型检查
npm run typecheck

# 单元测试（97 个）
npx vitest run

# 生产构建
npm run build

# 启动冒烟
node scripts/smoke.mjs

# UI 截图
node scripts/ui-shot.mjs

# 真实数据端到端
node scripts/e2e-ui.mjs
```

> 全部脚本已显式清空 `NODE_OPTIONS`，避免本机 `worker-events.cjs` 污染 Electron 启动。

## 2026-11-08 Fluent 前端改造验证

- 范围：`App.vue`、`main.css`、`SourceStatus.vue`、`FilterBar.vue`、`AssignmentTable.vue` 的模板/样式，以及 `DiagnosticPanel.vue` 状态列宽度。未更改 Vue script、筛选/时间计算、主进程、preload 或 API；未新增依赖。
- `npm run typecheck`、`npm run build` 通过；`npm test`：9 文件、180 项通过。沙箱内存储测试曾因临时文件原子重命名 `EPERM` 失败，获准沙箱外重跑后全部通过，未更改存储代码。
- 文字配色抽查：主/次文字、辅助文字、主按钮和品牌/成功/警告/错误标签共 8 组，深色最低 6.10:1、浅色最低 5.57:1（按主题颜色 token 计算）。
- 新增 `node scripts/fluent-ui-e2e.mjs`（先运行 `npm run build`）：直接启动本次源码构建，使用隔离 profile 和明确标识的演示 IPC 夹具，不调用学校接口、不使用真实浏览器会话、不触发真实通知。Electron GUI 在当前沙箱内无法启动，使用获准的沙箱外执行。
- UI 回归通过：搜索、平台/课程/截止/剩余/状态筛选、排序、隐藏过期、重置、空筛选；真实 preload 上的打开/登录/同步事件与忙碌状态；深色/浅色/跟随系统；1180/900/720/590 CSS 像素窗口；长标题、日期精度提示、状态标签；表格键盘横滚及操作按钮定位；900/590px 设置页与诊断标签；失败时保留缓存警示和无数据提示。
- 截图：`docs/screenshots/fluent-1180.png`、`fluent-900.png`、`fluent-900-table.png`、`fluent-720.png`、`fluent-590.png`、`fluent-light.png`、`fluent-settings.png`。全部使用演示数据。
- 人工验收：`npm start` 启动本次构建；设置中切换三种主题，缩放窗口并检查长标题/标签；验证真实登录、同步和打开作业。真实平台、系统 DPI、通知、安装包不在此次 UI 自动化验证范围内。
- 当前工作目录无 Git 元数据；未初始化仓库、Commit 或 Push，等待用户人工验收。
- DSH 按用户授权完成一次源码建议与一次独立源码审查，最终结论「通过，未发现阻塞性问题」；Codex 已查看深色、浅色、窄窗口表格和设置页截图。非阻塞建议为启动窗口底色一致性与后续增加手动修正/真实来源徽标测试覆盖，本次不扩大范围。

## 14. 2026-11-13 优学院考试交卷状态实测验证与 TDD 接入

- **真实平台探针验证**：在已登录优学院 profile 副本上运行 `node scripts/probe-lms-exam.mjs --profile <副本> --oc-id 161631`，拿到 `/utestapi/exams/student` HTTP 200 真实响应，确认 `answerTimes`（已用提交次数）、`limitTimes`（允许提交次数）、`isLimitTimes`（`"0"` 不限 / `"1"` 限制）、`subjective`/`objective`（主客观题得分）字段结构与值域。
- **TDD 三切面验证**：
  1. `src/main/sources/lms-exam.test.ts`：`resolveExamAttendance` / `normalizeExamItems` 对实测《3. 组合逻辑电路》（`answerTimes=1, limitTimes=2, score=60`）、《4. 时序逻辑电路》（`answerTimes=0, limitTimes=1`）、不限次数测验（`isLimitTimes="0"`）及缺字段回退 `unknown` 的归一化验证。
  2. `src/renderer/src/logic/item-view.test.ts`：`attendanceBadge` 显示「已交卷 X/Y」「已交卷 X次」「未交卷 0/Y」「未交卷」与悬停得分说明。
  3. `src/renderer/src/logic/filter.test.ts` + `src/main/reminder/exam-planner.test.ts`：按 `submitted` / `not_submitted` / `unknown` 筛选考试场次；已交过 1 次卷（`attendance='submitted'`）的考试自动抑制后续提醒。
- **全量检查**：`npm run typecheck`、`npm test`（15 文件 / 383 项通过）、`npm run build`、`node scripts/exam-e2e.mjs` 通过。
