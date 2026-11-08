# 技术决策记录（DECISIONS / ADR）

格式：每条记录 = 背景 → 决策 → 理由 → 影响。

---

## ADR-001：用受控浏览器而非纯 HTTP 客户端采集

**日期**：2026-11-08
**状态**：已采纳

### 背景
两个平台的登录都不是简单的表单 POST：
- hw 平台走中央认证 CAS OAuth2，密码由前端加盐加密；会话是服务端 session cookie，浏览器关闭即失效。
- 优学院 LMS 用 `AUTHORIZATION` cookie + 自定义请求头，401 时按业务 code 跳转超时页。

### 决策
使用 Playwright Core 驱动**本机已安装的 Microsoft Edge**，采用应用专属 `userDataDir`，
由用户在可见窗口中手工登录；应用只负责持久化会话并在页面上下文内做同源只读 fetch。

### 理由
1. 需求明确要求"不关闭或绕过验证码/MFA"。真实浏览器是唯一合规且稳健的路径。
2. 复刻 CAS 加密流程脆弱且容易随改版失效。
3. `channel: 'msedge'` 复用系统 Edge，不下载 Chromium，安装包更小。

### 影响
- 应用需要长驻浏览器实例（内存开销）。
- 打包后必须能定位 Edge（已实现双路径探测 + 明确错误提示）。
- 绝不读取用户日常浏览器 Cookie。

---

## ADR-002：不采用 SQLite，使用 electron-store

**日期**：2026-11-08
**状态**：已采纳

### 背景
需求建议"优先选择稳健、支持原子写入和版本迁移的本地存储（例如 electron-store）；
如测试证明需要复杂查询，再采用 SQLite"。

### 决策
使用 `electron-store`。

### 理由
- 单用户场景，作业量级 < 1000 条，无需复杂查询或并发写入。
- electron-store 基于原子写入（写临时文件再 rename），自带 schema 版本字段便于迁移。
- 纯 JS 实现，无 Windows 原生模块，避免 electron-builder 打包时的 ABI 重编译问题。

### 影响
- 若未来需要全文检索或统计报表，再迁移到 SQLite。
- `AppStore.migrate()` 已预留逐版本升级入口。

---

## ADR-003：preload 强制输出 CommonJS + `.js`

**日期**：2026-11-08
**状态**：已采纳（由实测缺陷驱动）

### 背景
项目 `package.json` 为 `"type": "module"`，electron-vite 默认把 preload 输出为 `index.mjs`。
但主进程按 `join(__dirname, '../preload/index.js')` 加载，导致：

```
Unable to load preload script: .../out/preload/index.js
Error: ENOENT: no such file or directory
→ TypeError: Cannot read properties of undefined (reading 'onSnapshot')
```

即整个 preload API 失效，UI 完全不可用。

### 决策
在 `electron.vite.config.ts` 中强制 preload 输出 `format: 'cjs'`、`entryFileNames: 'index.js'`。

### 理由
Electron 的 sandbox preload 不支持 ESM；且路径必须与主进程加载路径一致。

### 影响
这是**必须保持**的配置，改动前请先跑 `node scripts/ui-shot.mjs` 验证。

---

## ADR-004：`deadline` 字段是布尔，`deadlineDate` 才是截止时间

**日期**：2026-11-08
**状态**：已采纳（纠正早期假设）

### 背景
从 hw 平台前端 bundle 的字段名推断时，最初假设 `deadline` 是截止时间字符串、
`deadlineDate` 是仅日期部分。

### 实测结果（真机数据，14 条作业）
```json
{ "deadline": true, "deadlineDate": "2026-11-22 23:00" }
```
- `deadline` 恒为 **boolean**，表示"是否设置了截止时间"。
- `deadlineDate` 才是 **"YYYY-MM-DD HH:mm"** 的完整时间，含时间部分。

### 决策
适配器只用 `deadlineDate` 解析截止时间；`deadline=false` 视为"平台明确未设截止"。

### 理由
按原假设实现会得到 `dueAt=null` 的 14 条作业，即"所有作业都没有截止时间"——
一个完全错误但看起来"没报错"的结果。

### 影响
已写入 `hw-source.test.ts` 的回归测试，防止再次改错。

---

## ADR-005：分页容器是 `data.data`，不是 `data.content`

**日期**：2026-11-08
**状态**：已采纳（由实测纠正）

### 背景
从字段名推测 Spring Data 风格的分页容器（`content` / `totalElements`）。

### 实测结果
```json
{ "code": 0, "msg": "成功", "data": { "total": 15, "data": [ ... ] } }
```

### 决策
`extractRows()` 优先取 `data.data`，并保留 `content` / `list` / `records` 作为容错回退。

### 影响
若平台换分页实现，靠回退链仍可能读取成功；同时有 `total` 用于判断是否取全。

---

## ADR-006：LMS 适配器在接口未验证时主动抛错

**日期**：2026-11-08
**状态**：已采纳

### 背景
LMS 的作业接口始终未拿到真实响应。若按普通方式返回空数组，UI 会显示"暂无作业"，
用户会误以为真的没有作业——这违反了项目红线。

### 决策
`UlearningAssignmentSource.listAssignments()` 在成功读取课程后，抛出
`UnverifiedEndpointError`，消息中明确说明"课程已读到 N 门，但作业接口尚未验证"。

### 理由
**失败必须表现为失败**。宁可显示"同步失败，请核对"，也不能显示成"没有作业"。

### 影响
- 同步引擎会把它归类为 `failed`，UI 显示失败横幅，并保留旧缓存。
- 一旦作业接口验证通过，替换该方法实现并把测试从"期望抛错"改为"期望返回真实数据"。

---

## ADR-007：提醒幂等键包含 `dueAt`

**日期**：2026-11-08
**状态**：已采纳

### 背景
需求要求：同一作业同一阈值不重复提醒；截止时间变化需重新计算提醒。

### 决策
幂等键 = `${source}:${sourceAssignmentId}:${dueAt}:${thresholdHours}`。

### 理由
把 `dueAt` 放进键里，**改期后旧键天然失效**，无需额外的"撤销旧计划"逻辑，
也不会因为改期而漏提醒。

### 影响
`AppStore.clearRemindersForAssignment()` 提供了按前缀清理的能力，用于显式改期场景。

---

## ADR-008：优学院必须走"CAS → 应用中心 → 带 token 跳 LMS"

**日期**：2026-11-08
**状态**：已采纳（由实测 + 社区逆向资料共同确认）

### 背景
优学院 LMS 直接登录始终失败：
- LMS 自家登录页 `/sld/pc.html#/login` 返回 **404**；
- CAS `service` 指向 LMS 时，认证后被跳回门户，`AUTHORIZATION` 不写入 LMS。

参考：[博客园逆向分析](https://www.cnblogs.com/resea/p/20135197)、
[Greasy Fork 脚本](https://greasyfork.org/zh-CN/scripts/561583)。

### 根因
DGUT 的认证中心**只信任来自应用中心 `application.dgut.edu.cn` 的请求**。
所以 `service` 必须写成：
```
https://application.dgut.edu.cn/appapi/cas/fromcas
```
认证成功后才在 `.dgut.edu.cn` 域下签发 `AUTHORIZATION`(32 位) 与 `token`。
随后必须用 URL 参数形式把 token 交给 LMS：
```
https://lms.dgut.edu.cn/courseweb/ulearning/index.html#/index/courseList?AUTHORIZATION=<token>
```

### 决策
`UlearningAssignmentSource.connect()` 按上述三段链路实现：
1. 打开正确的 CAS 入口；
2. **轮询等待最多 90 秒**，一旦出现 `AUTHORIZATION` 自动执行第 2 段跳转；
3. 用真实 API 响应（`/courseapi/users/0`）而非 `document.cookie` 判定登录态。

### 理由
- 这是唯一可行的路径，其他方式均被平台拒绝；
- 轮询等待而非固定 sleep，能适配用户输入验证码/短信验证的耗时差异；
- 用 API 响应判定可兼容 `AUTHORIZATION` 是 HttpOnly 的情况。

### 影响
- 最后一步（完成认证）仍需用户人工操作，应用不代填密码、不碰验证码。
- 若平台后续修复 SSO，本流程仍可用（退化为普通 CAS 登录）。

---

## ADR-009：`getPage` 必须优先复用已导航到目标站点的页面

**日期**：2026-11-08
**状态**：已采纳（由真实缺陷驱动）

### 背景
原实现 `getPage()` 无条件返回 `pages[0]`。实际使用中出现：
用户在受控 Edge 的**第二个标签页**登录成功，应用却去读**第一个空白标签页**，
表现为"明明登录了却显示未登录"。

### 决策
`getPage(preferHost?)` 优先返回 URL 中包含 `preferHost` 的页面，否则回退 `pages[0]`。
两个适配器分别传入 `'hw.dgut.edu.cn'` 与 `'lms.dgut.edu.cn'`。

### 影响
这修复了"登录成功但读不到数据"的核心可用性缺陷。
