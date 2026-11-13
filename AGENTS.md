# AGENTS.md —— 本项目的开发约定

本文件写给后续接手的人（或 AI 代理）。**动手改代码前请先读完。**

## 1. 项目是什么

「莞工 Deadline」是一款 Windows 11 桌面端作业截止提醒工具，服务于东莞理工学院学生，
只从两个平台读取作业信息并提醒：

1. 优学院 LMS：`https://lms.dgut.edu.cn/courseweb/ulearning/index.html`
2. 莞工作业平台：`https://hw.dgut.edu.cn/home`

## 2. 不可违反的红线

1. **只读**。只发 GET 请求读取数据。不提交作业、不上传文件、不修改任何学校系统数据。
2. **不接 AI / 云 / 付费 API**。运行时不联网到任何第三方服务，无遥测，无账号体系。
3. **不伪造**。任何未经验证的接口、字段、选择器都必须标注「未验证」，不得在代码中当作事实。
   没有真实数据时只能显示「暂无数据/同步失败」，**绝不能把失败渲染成"没有作业"**。
4. **不索取凭证**。绝不要求用户把账号密码输入本应用；登录一律在受控 Edge 窗口中由用户手工完成。
   不读取、不导出、不落盘任何 Cookie / Token / Authorization 值。
5. **不绕过安全机制**。不破解验证码、不绕过 MFA、不绕过 VPN/校园网策略、不读取用户日常浏览器 Cookie。
6. **凭证与个人信息不入库**。`.gitignore` 已覆盖会话目录、HAR、诊断导出、调研产物。

## 3. 目录结构

```
.
├── src/
│   ├── main/                  Electron 主进程
│   │   ├── browser/session.ts      受控 Edge 会话（Playwright）
│   │   ├── sources/                平台适配器
│   │   │   ├── hw-source.ts            莞工作业平台（✅ 已用真实数据验证）
│   │   │   └── ulearning-source.ts     优学院 LMS（❌ 作业接口未验证）
│   │   ├── sync/sync-engine.ts     同步编排（失败保留缓存）
│   │   ├── reminder/planner.ts     提醒规则（纯逻辑，可注入时钟）
│   │   ├── store/app-store.ts      electron-store 持久化 + 迁移
│   │   └── ipc/snapshot.ts         组装给渲染进程的只读快照
│   ├── preload/                  contextBridge 白名单 API
│   ├── renderer/                 Vue 3 界面
│   └── shared/ipc.ts             主进程 <-> 渲染进程的类型契约
├── packages/shared/          平台无关的领域模型与工具（含单测）
├── docs/                     所有工程文档
├── scripts/                  验证脚本（smoke / e2e / seed）
└── investigation/            调研产物（已 gitignore，含真实数据）
```

## 4. 分层规则

- `packages/shared` **不得**依赖 Electron / Playwright / Node 专有 API。纯 TS，可被单测覆盖。
- 适配器只负责"取数据 + 归一化"，不做通知、不碰 UI、不写 store。
- `SyncEngine` 负责编排与缓存策略；失败时**只能**更新 `sessions`，**不得**清空 `assignments`。
- 渲染进程不得直接接触任何凭证；只通过 preload 暴露的白名单方法通信。

## 5. 关键不变量（有单测保护）

| 不变量 | 保护位置 |
|---|---|
| 只有日期无时间时不得补 23:59 | `datetime.test.ts` |
| 无截止时间必须 `dueAt=null, duePrecision='none'` | `datetime.test.ts` |
| 未提交/未知状态严格区分 | `hw-source.test.ts` |
| 失败不得清空缓存 | `sync-engine.test.ts`（含按 kind 隔离的用例） |
| 跳转链接必须过 allowlist | `normalize.test.ts` |
| hw 的 `deadline` 是布尔、`deadlineDate` 才是时间 | `hw-source.test.ts` |
| 提醒键包含锚点时间，改期后旧键失效 | `planner.test.ts` + `exam-planner.test.ts` |
| **考试没有任何「提交状态」**（类型层不可写） | `ExamItem` 无 `submissionStatus` 字段；`item-view.test.ts` 断言 UI 不出现「未参加」 |
| **作业键与考试键不得互相匹配** | `exam-planner.test.ts`「关键」用例 |
| **考试按 `endsAt` 判过期**，进行中不得被默认隐藏 | `filter.test.ts` + `item-view.test.ts` |
| **考试失败不得影响作业缓存**，反之亦然 | `sync-engine.test.ts` + `app-store.migration.test.ts` |
| **v2 缓存迁移后一条不少且补 `kind='homework'`** | `app-store.migration.test.ts` + `app-store.realdata.test.ts` |
| **分类按接口来源，不按标题** | 无标题正则（代码中 grep 不到） |

## 6. 开发命令

```bash
npm install          # 安装依赖
npm run dev          # 开发模式（需同时有 GUI 环境）
npm run typecheck    # 主进程 + 渲染进程类型检查
npm test             # 单元测试
npm run build        # 生产构建
npm run build:win    # 打 NSIS 安装包
```

验证脚本：

```bash
node scripts/smoke.mjs        # 无头启动验证（检查主进程/渲染进程无致命错误）
node scripts/ui-shot.mjs      # 截图主窗口
node scripts/e2e-ui.mjs       # 用真实采集数据渲染并断言 UI
node scripts/exam-e2e.mjs     # 考试接入端到端（合成夹具，验证接线非接口真实性）
node scripts/probe-lms-exam.mjs  # 只读探针：拿考试列表真实响应形状（需登录态）
```

> ⚠️ 本机 shell 存在 `NODE_OPTIONS=--require worker-events.cjs`，会污染 Electron 启动。
> 脚本中已显式置空 `NODE_OPTIONS`。
>
> ⚠️ **另一个坑**：本机还带有 `ELECTRON_RUN_AS_NODE=1`。只要该变量存在（哪怕值为空串），
> Electron 就会以纯 Node 模式运行，于是 `import { BrowserWindow } from 'electron'`
> 直接抛 `does not provide an export named 'BrowserWindow'` —— 看起来像代码缺陷，
> 实际是环境污染。启动 Electron 的脚本必须 **`delete env.ELECTRON_RUN_AS_NODE`**（删除键，
> 不是设为 `''`）。

### 一键启动（已处理上述污染）

双击仓库根目录的：

| 文件 | 模式 | 用途 |
|---|---|---|
| `启动.cmd` | `npm run dev`（含热更新） | 开发调试用 |
| `快速启动.cmd` | `npx electron .`（跑 `out/` 预构建） | 日常使用，启动更快 |

两者都会自行清理 `NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE`，因此从资源管理器、
快捷方式、任何 shell 启动都不会踩坑。桌面已创建快捷方式「莞工 Deadline」→ `快速启动.cmd`。

> `.cmd` 内容刻意保持**纯 ASCII**：中文注释在 `chcp 65001` 生效前就已被 GBK 解析，
> 会整行乱码并导致 `rem` 之后的行被当成命令执行。

## 7. 修改适配器时必须做的事

1. 先在真实平台上确认字段（截图 / 脱敏响应结构），把结论写进 `docs/PLATFORM_FINDINGS.md`。
2. 更新或新增**基于真实数据**的测试用例，而不是自己编造形状。
3. 若接口仍未验证，保持 `UnverifiedEndpointError`，不要返回空数组冒充成功。
4. 在 `docs/TESTING.md` 记录本次验证的日期与结果。

## 8. 当前状态（务必与代码同步更新）

### 平台认知（2026-11-11 实测纠正，**旧文档此处曾有错**）

DGUT 优学院是**单主机 + 路径前缀**，不是「一子系统一子域」：

- 唯一主机：`https://lms.dgut.edu.cn`
- 子系统按路径分发：`/courseweb/`（前端）、`/courseapi/`（旧 API）、`/utest/`（新考试前端）、
  `/utestapi/`（新考试 API）、`/homework/`（作业前端）—— 实测全部 **200**
- `homework.dgut.edu.cn` / `courseapi.dgut.edu.cn` / `utestapi.dgut.edu.cn` / `utest.dgut.edu.cn`
  实测一律 **302 → `nic.dgut.edu.cn/ymwzd404.htm`**（不存在）
- 根因：打开页面即下发**非凭证**路由 cookie `urlStyle=2` + `baseHost=lms.dgut.edu.cn`，
  `config.js` 据此把 host 改写为 `baseHost + "/<prefix>"`
- ⇒ 所有 `detailUrl` 都在 `lms.dgut.edu.cn` 下，`SOURCE_ALLOWLIST` **无需新增域名**

### 数据接入

- ✅ hw 平台：真实登录后读取作业，归一化正确（已验证 14 / 20 条两个批次）
- ✅ 优学院 LMS **作业**：`/courseapi/homeworks/student/v2?ocId=`，真实读取 121 条
- ✅ 优学院 LMS **考试**：`/utestapi/exams/student?ocId=`（2026-11-13 已用真实登录态验证 6 门课 18 场考试）。
  个人交卷状态由 `answerTimes`（已用提交次数）与 `limitTimes`（允许提交次数）判定：
  `answerTimes >= 1` 为 `submitted`（显示「已交卷 X/Y」，悬停可见 `subjective + objective` 得分，并抑制后续提醒），
  `answerTimes === 0` 为 `not_submitted`（显示「未交卷 0/Y」），字段缺失时保守置 `unknown`（显示「参加状态未知」）。
  证据见 `investigation/lms/exam-probe-result.json` 与 `docs/PLATFORM_FINDINGS.md` §3.10。
- ⏳ 提醒引擎、托盘、系统通知：代码骨架已就绪，**尚未做实机验证**。
- ⏳ NSIS 安装包：**尚未制作**。

### 作业 / 考试的分类口径（用户 2026-11-11 决策）

> 「在作业模块出现的不管叫什么都算作作业 tab，在考试模块出现的不管叫什么都算作考试 tab。」

⇒ `kind` 由**接口来源**决定，**不由标题内容决定**。
叫「期末考试」但来自作业接口的条目就是 `kind='homework'`，继续用作业模型与作业文案。
**禁止**按标题正则（`期末|期中|测验|考试`）推断条目性质。
