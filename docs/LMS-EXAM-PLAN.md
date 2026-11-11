# 优学院 LMS「考试」接入实施计划（LMS-EXAM-PLAN）

> **文档性质：计划（to-be）。** 本文所有设计、字段、键格式、界面行为均为**待实施方案**，不代表代码已具备该能力。
> 唯一例外是明确标注「实测」的条目 —— 那是已发生的客观观测，只作为设计依据引用。
>
> **证据基线**：`investigation/lms/exam-evidence.md`（2026-11-10，§A 实测 / §B 代码证据 / §C 未知）。
> **约束基线**：`AGENTS.md` 红线 1（只读）、红线 3（不伪造）、红线 6（凭证不入库）；`docs/DECISIONS.md` ADR-006、ADR-007。
> **写作日期**：2026-11-10。凡未经真实响应验证的接口/字段/取值域，全文一律显式标「**未验证**」，且不得在代码中当作事实。

---

## §0 一句话结论 + 当前阻塞

**结论**：在现有「作业」骨架上增加第二种列表实体 —— 考试**场次**（不是考试） —— 用判别联合 `ListItem = HomeworkItem | ExamItem` 表达；考试以 `startsAt` 为提醒主锚点、以**独立的分钟级阈值**提醒、以 `examId + 场次 startTime` 复合键为身份；作业侧数据模型与提醒键**保持不变**。第一阶段考试参加状态一律 `unknown`（UI 显示「未知」），考试同步默认关闭，直到 §3 的 C.1/C.5/C.6 拿到真实响应。

**当前阻塞（实测，2026-11-10 15:2x 复核本机 store）**：

| 项 | 现状 | 证据 |
|---|---|---|
| LMS 会话 | `sessions.ulearning.state = needs_login`，`lastAttemptAt = 2026-11-10T07:00:50.703Z` | `%APPDATA%\dgut-deadline\dgut-deadline.json`（只读查看，未见任何凭证字段） |
| 考试列表真实响应 | **未拿到**。临时 profile 下 `/courseapi/exams/student` 与 `/utestapi/exams/student` 均 401 `{code:2001}` | `exam-evidence.md` §A.3、§A.6；`scripts/probe-lms-exam.mjs` 退出码 2 属预期 |
| 可用的缓存基线 | `assignments.ulearning = 121 条`、`assignments.hw = 20 条`、`reminders = 9 条`（同一 store） | 同上；用于回归对照，勿清空 |
| 本次调研的写操作 | **零**。全部为 GET；未登录、未解验证码、未读日常浏览器 Cookie | `exam-evidence.md` §A.1 |

**因此本计划分为两条并行轨道**：轨道 A（§4–§9 的纯逻辑层）不依赖真实响应即可落地并用单测闭环；轨道 B（考试适配器 `listExams()` 的真实解析）**卡在 C.1**，只能先按「未验证」形状实现并默认关闭（§10 步骤 8）。

**必须先纠偏的一条旧表述**：`AGENTS.md` §8 暗示「一子系统一子域」（`homework.dgut.edu.cn`）。实测为 **单主机 + 路径前缀**：`homework/`、`utest/`、`utestapi/`、`courseapi/` 全部挂在 `https://lms.dgut.edu.cn/` 下；`homework.dgut.edu.cn`、`courseapi.dgut.edu.cn`、`utestapi.dgut.edu.cn`、`utest.dgut.edu.cn` 均 302 → `nic.dgut.edu.cn/ymwzd404.htm`（不存在）。本案所有 URL 因此都在 `lms.dgut.edu.cn` 下，**`SOURCE_ALLOWLIST` 不需要新增域名**（`packages/shared/src/model/assignment.ts:19-22`）。AGENTS.md 的更正作为 §10 步骤 9 的文档回填项，不在本次代码改动内。

---

## §1 已实测事实表（可直接支撑设计）

> 来源：`investigation/lms/exam-evidence.md` §A（2026-11-10，无凭证 GET）。只列与本设计直接相关的条目；编号沿用该文档。

| # | 实测事实 | 证据位置 | 对本设计的直接含义 |
|---|---|---|---|
| A.2 | `lms.dgut.edu.cn` 是唯一主机；子系统按路径前缀分发；页面入口 `/courseweb/`、`/homework/`、`/utest/` 均 **200**；`/utestapi/*` 与 `/courseapi/*` 为 API 前缀（需 token） | evidence §A.2（`:27-60`）；`config.js:131-219` 的 `urlStyle=2` 分支 | 考试 URL 全部在 `lms.dgut.edu.cn`；`detailUrl` 不需新域名；**allowlist 不改** |
| A.2 | `lms.dgut.edu.cn` 响应携带两个**非凭证**路由 cookie：`urlStyle=2`、`baseHost=lms.dgut.edu.cn` | evidence §A.2（`:39-48`） | 适配器**不得**把这两个 cookie 当登录态信号；登录态判定沿用现实现（`ulearning-source.ts:262-288`，`/courseapi/courses/students` 真实响应） |
| A.2 | `homework.dgut.edu.cn` 等 4 个子域 302 → `nic.dgut.edu.cn/ymwzd404.htm` | evidence §A.2（`:31-37`） | 不写入任何配置文件、不重试、不加入 allowlist |
| A.3 #1/#2 | `GET /courseapi/exams/student?ocId=…` → 401 `{code:2001}`；`GET /utestapi/exams/student?ocId=…` → 401 `{code:2001}` | evidence §A.3 | 只能证明**两个前缀下的 `exams/**` handler 组存在**；`/exams/student` 这个**具体 handler 的存在性仍属代码证据**（A.4 已证明 `studentXXX` 同样 401）。故设计「先新后旧」回退（§6.4），**不要**「先判分支再请求」 |
| A.3 #5 | `GET /courseapi/activitycalendar?startDate&endDate` → 401（路由存在） | evidence §A.3 | 日历可作为**交叉校验**通道，但**不作为** id 来源（缺 `examId`，C.8） |
| A.3 #18 | `GET /courseapi/exams/orgExamConfig/{ocId}` → **200**，返回 `{"phoneExam":0,"faceExam":0}`（唯一免登录业务响应） | evidence §A.3 | 这是**唯一已实测**的考试域业务响应，且与提醒无关；不得据此推断列表形状 |
| A.3 #9/#11 | `/exams/{id}/batch` → 405（handler 存在，GET 不允许）；`/exams/{id}/batchs` → 401 | evidence §A.3 | 场次是**独立资源**，但本案只读列表内的 `examRelationTimeList`，**不增发 per-exam 请求**（C.11 未定前避免 25×N 请求） |
| A.4 | 401 是网关级拦截，判别力有限：`/exams/studentXXX` 同样 401；只有路径深度 ≥3 的对比（如 `/exams/1/score`：courseapi 404 vs utestapi 401）才有判别力 | evidence §A.4（`:107-126`） | 不得用「401 ⇒ handler 存在」论证 `/exams/student`；设计必须容忍「两条分支都 404/401」→ 报 `failed`，**绝不返回空数组** |
| A.5 | 前缀不对称矩阵：`/exams/{id}/score` 只在 `/utestapi` 有；`/courses/students`、`/activitycalendar`、`/users/menu/**` 只在 `/courseapi` 有；`/exams/{id}/{result,batchs,batch}` 两侧都有 | evidence §A.5（`:127-147`） | 课程列表（拿 `ocId`）**必须**走 `/courseapi`；考试列表候选两条；`/utestapi` 下没有课程列表（#31），不能整站切前缀 |
| A.6 | 探针脚本用**临时 profile**，不碰应用真实 profile（Edge 持久化上下文单实例锁）；鉴权头只在页面内 fetch，值不进 Node、不打印、不落盘 | evidence §A.6（`:148-169`） | 后续取真实响应的**唯一合规路径**：用户手工登录一次 → **复制** profile → `--profile <副本>`；不得指向运行中的应用 profile |
| 本机基线 | 单测：**180 passed / 9 files**；`tsc -p tsconfig.node.json` 与 `vue-tsc -p tsconfig.web.json` 均 **0 error**（2026-11-10 15:23–15:24 实测） | 本次运行 | §9/§10 的回归门槛以此为基线数字 |

**明确不属于实测、不得据此设计的项**：考试列表响应体形状、场次字段名、时间类型（毫秒 vs ISO 字符串）、`examState` 值域 —— 全部见 §2/§3。

---

## §2 代码证据（未验证）表

> 来源：前端 bundle 静态阅读（`investigation/lms/`）。**逻辑可信，形状未验证。** 进代码前必须逐条标 `未验证` 注释，并在测试夹具上注明「非真实响应」。

### 2.1 学生端考试列表：两条候选 URL（未验证）

| 分支 | URL（DGUT，`urlStyle=2`） | 触发条件 | 证据 |
|---|---|---|---|
| 旧 `retrieveStudentExamList` | `GET https://lms.dgut.edu.cn/courseapi/exams/student?ocId=<ocId>&keyword=&pn=&ps=&lang=zh` | `getAccess(54)` 为假/失败 | `Exam.js:150` |
| 新 `retrieveStudentExamListNew` | `GET https://lms.dgut.edu.cn/utestapi/exams/student?ocId=<ocId>&pn=&ps=` | `getAccess(54)` 为真 | `Exam.js:1786` |

分支派发：`module_course_exam_examController.js:64-76`（成功回调 `if (res)`）+ `:297-325`（`roleId()==9` 学生派发点，`:308` 判 `newExamBaseUrl`）。
**未验证**：`hasMenu` 真实响应形状（可能 `true`/`false`，也可能恒真对象）；故**不采用**「先判分支」，改「先新后旧，失败回退」（§6.4）。

### 2.2 列表响应容器与字段（**全部未验证**）

容器：`result.total` + `result.examList[]`（`module_course_exam_examController.js:108`、`:83-234`）。

| 字段 | 用途（代码里的用法） | 未验证点 | 设计取舍 |
|---|---|---|---|
| `examId` | 作为 `Exam.id`（`:116`/`:139`） | 类型（数字/字符串） | 一律 `String()` 归一，**只做键，不做运算** |
| `title` | 标题 | 空值形态 | 空标题 → 丢弃并计 warning（同作业侧策略 `ulearning-source.ts:471-472`） |
| `startTime` / `endTime` | 考试级起止，**允许为空**（`:111-112` 空转 `""`） | `null`/`undefined`/`""` 三选一（C.7） | **不作为锚点**；空值一律按「无」处理 |
| `examRelationTimeList[]` | 整项透传 → `exam.batchList`（`:172-178`） | 元素字段名（C.5） | **本设计的唯一时间来源** |
| `examState` | `:179`；教师端映射 `:135`（`publishStatus ? 4 : examState`） | 值域、`4` 是否后端返回（C.9） | **不使用**。考试阶段由本地 `startsAt/endsAt + now` 推导（§5.6） |
| `isInExam` / `isTooLate` | `:182-194`（`canStart`） | 「现在能否进场」，与历史参加无关 | **不使用** |
| `answerTimes` | `:161`/`:185`/`:220`/`:348`，与 `limitTimes` 比较 | `>0` 只说明进过考场，**不等于交卷** | **不使用**（不能据此判「已参加」） |
| `examFinish` | `:196-211`，`'1';'2';'3'` 分号串 | 空串被代码当 `'1'`（`:206-208`），语义被前端改写 | **不使用** |
| `showExamRecord` / `showExamRecodAfterDate` / `notEnoughTime` / `allExamBatchEnd` | `:214-228` | 全是可见性策略 | **不使用**；另记：`Recod` 拼写错误是接口事实 |
| `subjective` + `objective` | `:162-164` 合成 `grade` | `0` 与「未参加」不可区分 | **不使用** |
| `paperCount` | `:134` | 低价值 | 仅展示可选项，一期不做 |
| `examPaperList[]` | `:126-132` | 元素字段名未知（C.2） | **不读取** |

> 结论：学生端列表里**没有任何字段**直接回答「我参加了没」。这是 §2.3 与 §3 C.3 的分界。

### 2.3 场次结构 `examRelationTimeList[]`（字段名部分未验证）

| 子字段 | 证据 | 状态 |
|---|---|---|
| `batch.startTime` / `batch.endTime` | `module_course_exam_exam.html:260-266`（学生端 `ko foreach: batchList`） | 字段名有代码证据，**未验证**类型与空值 |
| `batch.examRoomName` / `batch.seatNo` | `exam.html:267-275` | 同上，仅展示用 |
| `examRelationId` | 成绩侧 `exam_gradeController.js:168-175` 用 `examRelationList[].examRelationId` | **未验证**是否也出现在 `examRelationTimeList` 里（C.5） |
| `batchId` / `roomId` | 全部已下载 bundle 中**不作为场次字段**出现（仅 `Exam.js:879-880,1562-1563` 的 `examroomId` 参数、`:1303` 的 `roomIdList`） | **不得**据此命名场次字段 |

### 2.4 学生端模板的真实读法（决定「粒度 = 场次」）

`module_course_exam_exam.html`：

- `:249-257` 教师端：考试级 `startTime && endTime` 才显示，否则显示「暂无批次」；
- `:259-280` 学生端：**永远** `ko foreach: batchList`，逐场次渲染 `batch.startTime` / `batch.endTime`，从不读考试级时间。

→ 一场考试可能有 0..N 个场次；考试级时间为空是**正常现象**。做锚点必须逐场次，否则丢提醒。

### 2.5 状态文案对照（`nls_exam.js`，用于 UI 词表，未验证与本设计的对应关系）

`readed`=已批阅(`:26`)、`notSubmitted`=未提交(`:27`)、`toBeApproved`=待批阅(`:57`)、`notAttending`=未参加(`:58`)、`inExam`=考试中(`:59`)、`noStart`=未开始(`:173`)、`onGoing`=进行中(`:174`)、`hasEnded`=已结束(`:175`)、`draft`=草稿(`:891`)。
**注意**：这些词是**平台**词表，含「未参加」；本案第一阶段**禁止**在 UI 上对考试使用「未参加」（§8.3）。

### 2.6 个人状态枚举（唯一明确，但不在列表里）

`exam_gradeController.js:76-102`：`'1'` 待批阅 / `'0'` 未参加 / `'3'` 未提交 / `'2'` 考试中 / `'4'` 已批阅。
它来自 `GET /exams/{id}/score?examRelationID=…`（`Exam.js:662-682`），是**教师端成绩页**字段。
**未验证**（C.3）：学生端是否有权限调用、返回是否同样带 `status`。→ 第一阶段**不调用**该接口（多发请求 + 权限未知）。

### 2.7 详情节（用于 `detailUrl`，未验证可达性）

考试分享/详情 URL：`UTEST_WEB_HOST + '/#/exam/' + examId`（`exam_detailController.js:29`）→ DGUT 实际为 `https://lms.dgut.edu.cn/utest/#/exam/<examId>`。
**未验证**：该 hash 路由对学生是否直接可进入（很可能需要先带 `ocId` 上下文）。故 `detailUrl` 采用「尽力给 + allowlist 校验 + UI 允许为空」策略（§4.4）。

---

## §3 未知清单（C.1–C.11）+ 设计影响 + 回填方式

> 摘录自 `exam-evidence.md` §C。**回填动作统一记为 `BACKFILL(C.n)`**，写进 §9 的 `docs/PLATFORM_FINDINGS.md` 与 `docs/TESTING.md`，并把对应 `未验证` 注释改为实测日期。

| # | 未知项 | 对设计的影响（若与假设不符会怎样坏） | 回填方式 |
|---|---|---|---|
| C.1 | `/utestapi|/courseapi/exams/student` 真实响应形状 | 容器名不是 `examList` → 解析必须「容器不识别 ⇒ `parse_error`」，**不能**当空列表；字段名错 → 只有标题能出，时间为空 ⇒ 全列表无提醒（静默失效，比报错更危险） | `node scripts/probe-lms-exam.mjs --profile <profile 副本> --json`；把 `investigation/lms/exam-probe-result.json` 的 `$fields` 收敛为字段清单 |
| C.2 | `examPaperList[]` 元素字段 | 极低（一期不读） | 同 C.1 |
| C.3 | 学生能否调 `/exams/{id}/score` 且带 `status` | 决定「已参加」能否可靠展示；若可行，二期接入，UI 才允许出现「未参加/已提交」 | 登录态下额外探测一次；成功才开二期开关 |
| C.4 | `getAccess(54)` 返回值形状 | 决定新旧分支；本案用「先新后旧回退」规避，故**不阻塞** | 有真实登录态时顺手打一次 `/courseapi/users/menu/hasMenu?menuId=54&userId=<真实id>`，只记形状 |
| C.5 | 场次是否含 `examRelationId` | 若含 → 身份键可升级为 `examRelationId`（更稳）；若不含 → 保持 `examId + 场次 startTime` 复合键（本文方案），并在改期/加场时依赖 id 变化自然失效 | 同 C.1；把结论写进 `ExamItem` 注释并同步 §4.3 |
| C.6 | 时间是毫秒数字还是 ISO 字符串 | **高危**：若按毫秒解析却拿到 `"2026-12-30 09:00"`，会得到 `NaN` → 静默丢提醒。设计上必须**双格式探测 + 无法解析即 `null`**（§4.5） | 同 C.1；作业接口实测是毫秒（`PLATFORM_FINDINGS` §3.5），考试**不得**照搬假设 |
| C.7 | 空值是 `null`/`undefined`/`""` | 归一化分支；三者都按「无」处理即可，故不阻塞 | 同 C.1，记录实际形态 |
| C.8 | `activityId` 与 `examId` 映射 | 若可映射，日历可作低成本兜底源；否则仅作交叉校验 | 同 C.1，对比两响应 |
| C.9 | `examState=4` 是否后端返回 | 本案不依赖 `examState`，不阻塞 | 同 C.1，仅记录 |
| C.10 | 分页 `total` 是考试数还是场次数 | 影响「是否取全」的判定；错判会截断今日考试 | 实测后据 `examList.length` 与 `total` 关系定；取全判据改为「分页直到 `list.length < ps` 或累计 ≥ total」，并对 `total` 语义存疑时多取一页 |
| C.11 | 是否可按日期范围一次拉全部考试 | 影响请求预算（逐课程最多 25 次 GET）；不影响正确性 | 登录态下探索 `/courseapi/exams/*` 与 `/activitycalendar`；有则二期替换 |

**红线对齐**：C.1/C.5/C.6 未定期间，考试分支必须满足「**能解析才提醒，不能解析就明确说失败**」，绝不允许出现「界面上考试为 0 条但我其实有考试」。

---

## §4 数据模型设计（判别联合）

### 4.1 目录与文件（新增/修改）

| 文件 | 动作 | 说明 |
|---|---|---|
| `packages/shared/src/model/list-item.ts` | **新增** | `ListItemKind`、`ListItemBase`、`HomeworkItem`、`ExamItem`、`ListItem`、`isExamItem()`、`isHomeworkItem()`（见 §4.2） |
| `packages/shared/src/model/assignment.ts` | 修改 | `Assignment` 降级为 `HomeworkItem` 的兼容别名（§4.2 末）；`SOURCE_ALLOWLIST` **内容不变**，仅新增一条测试断言考试 detailUrl 可过校验 |
| `packages/shared/src/model/datetime.ts` | 修改 | 新增 `parseExamTime(raw)`：毫秒数 / ISO 字符串 / `YYYY-MM-DD HH:mm` 双格式，失败返回 `null`（**不猜**） |
| `packages/shared/src/index.ts` | 修改 | `export * from './model/list-item.js'`（`:1-4` 追加一行） |

### 4.2 完整类型定义（待落地）

```ts
// packages/shared/src/model/list-item.ts
import type { SourceId } from './assignment.js';

/** 列表实体类型判别字段。必填 —— 缺失即编译错误（防止 exam 被当成 homework 处理）。 */
export type ListItemKind = 'homework' | 'exam';

/** 两种实体共有的字段（= 现有 Assignment 去掉作业专有字段）。 */
export interface ListItemBase {
  source: SourceId;
  /** 平台内稳定键，含 kind 前缀（见 §4.3）。 */
  sourceAssignmentId: string;
  /** 去重主键 = `${source}:${sourceAssignmentId}`。 */
  id: string;
  courseId: string | null;
  courseName: string | null;
  title: string;
  /** 已过 allowlist 校验；null 表示无法构造（UI 禁用「打开」）。 */
  detailUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSyncAt: string;
  sourceUpdatedAt: string | null;
}

/** 作业项：字段与现有 Assignment 完全一致，只多一个 kind。 */
export interface HomeworkItem extends ListItemBase {
  kind: 'homework';
  dueAt: string | null;                     // ISO8601 +08:00
  duePrecision: 'datetime' | 'date' | 'none';
  submissionStatus: 'not_submitted' | 'submitted' | 'overdue' | 'unknown';
  statusEvidence: string;
  manuallyOverridden?: { field: 'dueAt' | 'submissionStatus'; at: string };
}

/**
 * 考试**场次**项（不是考试）。一场考试 N 个场次 => N 条。
 *
 * 未验证（见 investigation/lms/exam-evidence.md §B.4/§C.5）：
 *   - 场次唯一标识字段名未知，故身份 = examId + 场次 startsAt；
 *   - 时间字段类型未知（毫秒 / ISO），归一化见 parseExamTime()；
 *   - 参加状态无可靠来源（§2.3），第一阶段恒 'unknown'。
 */
export interface ExamItem extends ListItemBase {
  kind: 'exam';
  /** 考试 ID（未验证类型，一律 String() 归一）。 */
  examId: string;
  /** 场次开始（提醒主锚点）。未验证；未知则 null。 */
  startsAt: string | null;
  /** 场次结束。未验证；未知则 null。 */
  endsAt: string | null;
  /** 时间精度：只有 datetime 才允许阈值提醒。 */
  timePrecision: 'datetime' | 'none';
  /** 考场/座位（可选，仅展示）。未验证字段名。 */
  venue: { roomName: string | null; seatNo: string | null } | null;
  /** 个人参加状态：第一阶段**恒为 'unknown'**（红线 3）。 */
  attendance: 'unknown';
  /** 判定依据（脱敏），便于回填 C.3 后审计。 */
  attendanceEvidence: string;
}

/** 列表读取的统一返回类型。 */
export type ListItem = HomeworkItem | ExamItem;

/** 编译期判别助手（渲染层/提醒层必须经它收窄后再访问专有字段）。 */
export function isExamItem(i: ListItem): i is ExamItem { return i.kind === 'exam'; }
export function isHomeworkItem(i: ListItem): i is HomeworkItem { return i.kind === 'homework'; }
```

**兼容策略**（对齐 Lead 决策 1，不把 exam 塞进 Assignment）：

```ts
// packages/shared/src/model/assignment.ts
/** @deprecated 仅过渡期保留；新代码一律用 ListItem / HomeworkItem。 */
export type Assignment = HomeworkItem;
```

⚠️ 这一行会让**所有构造 `Assignment` 字面量的位置缺少 `kind` 而报错** —— 这是**故意的**：编译器会把每一个「需要显式声明这是作业」的点全部点名（清单见 §9.3）。不允许用 `kind?: 'homework'` 可选字段绕过：可选会让 `switch (item.kind)` 的穷尽检查失效，也与「必填」决策冲突。

### 4.3 id / sourceAssignmentId 规则（防作业-考试 id 撞车）

| 实体 | `sourceAssignmentId` | `id`（= `source:sourceAssignmentId`） |
|---|---|---|
| 作业（现状不变） | `<数值 ID>`，例如 `500750` | `ulearning:500750` / `hw:5879` |
| 考试场次 | `exam:<examId>@<场次 startTime 毫秒>`，例如 `exam:9001@1793705220000` | `ulearning:exam:9001@1793705220000` |
| 考试场次·开始时间未知 | `exam:<examId>@nostart` | `ulearning:exam:9001@nostart` |

规则说明：

1. 作业侧 ID 恒为纯数字，考试侧恒以 `exam:` 开头 ⇒ **物理上不可能撞车**；`assignmentId()`（`assignment.ts:72-74`）无需改动，只要传入带前缀的 `sourceAssignmentId`。
2. 用**毫秒**而非 ISO 字符串拼 id：ISO 文本可能因平台格式差异（有无秒、`T`/空格）而漂移，毫秒是稳定数值。归一化后从统一 ISO 反解 ms（`Date.parse`）。
3. `@nostart` 情形**每场考试至多一条**：用于「已知有这场考试但场次时间没解析出来」的可见性兜底；该条**不产生任何阈值提醒**（§5.2）。
4. 改期辨识：场次 `startsAt` 变化 ⇒ id 变化 ⇒ 列表项身份变化 ⇒ 旧提醒键自然失效。这与 ADR-007「键含 dueAt，改期后旧键天然失效」是同一套机制，**不需要**额外的撤销逻辑（`app-store.ts:221-225` 的按前缀清理仍保留给显式场景）。
5. 若 C.5 回填确认 `examRelationId` 存在且稳定 → 二期把场次键升级为 `exam:<examId>#<examRelationId>`，并写一条数据迁移说明（**当前不做**）。

### 4.4 `detailUrl` 与 allowlist

```ts
const detailUrl = isAllowedDetailUrl('ulearning', url) ? url : null;
// url = `https://lms.dgut.edu.cn/utest/#/exam/${examId}`   // 未验证：hash 路由是否可直接进入
```

- `SOURCE_ALLOWLIST['ulearning'] = ['lms.dgut.edu.cn']`（`assignment.ts:20`）已覆盖，**不改白名单**。
- `isAllowedDetailUrl()` 只校验协议 + hostname（`assignment.ts:94-107`），不校验 hash 路由可达性 ⇒ UI 必须有「链接不可用」的降级（`detailUrl === null` 时禁用按钮，现状已有此分支 `AssignmentTable.vue:87`）。
- 明确**不加入**：`homework.dgut.edu.cn`、`courseapi.dgut.edu.cn`、`utestapi.dgut.edu.cn`、`utest.dgut.edu.cn`（均 302 到 404 页，§A.2）。

### 4.5 时间归一化 `parseExamTime(raw)`（新增，纯函数）

```
输入：unknown（毫秒数字 | 秒级数字? | ISO 字符串 | "YYYY-MM-DD HH:mm[:ss]" | "YYYY/MM/DD HH:mm" | "" | null）
输出：{ iso: string; precision: 'datetime' } | null

规则：
 1. 数值型：n > 1e12 → 毫秒；1e9 < n <= 1e12 → 秒级（×1000，保守猜测需在证据回填后确认，C.6）；
    仍不合理 → null。绝不 new Date(0) 之类的伪值。
 2. 字符串：先复用 parseDueAt()（datetime.ts:56-139，已覆盖多种真实形态）；
    得到 duePrecision === 'date' 时 → **视为无法定时刻**，返回 null（考试没有「只有日期」的语义）。
 3. 任何解析失败 → null，并在适配器计 warning（不允许静默丢场次而不告警）。
 4. 输出一律 +08:00 ISO（复用 datetime.ts 的 toIsoShanghai 思路）。
```

`timePrecision = (startsAt !== null) ? 'datetime' : 'none'` —— 只有 `datetime` 的场次才参与阈值提醒。

### 4.6 `fallbackKey` 的处置

现有 `fallbackKey()`（`assignment.ts:80-92`）面向「平台无稳定 ID 的作业」。考试**不使用它**：`examId` 有代码证据（`Exam.js` 以 `e.examId` 构造 id），若真实响应里 `examId` 缺失 → **跳过该场次并计 warning**，而不是用「课程+标题+时间」兜底（兜底键会随标题微调漂移，反而制造重复提醒）。

### 4.7 ✅ 已定案（2026-11-11 用户决策）：按「来源模块」分类，不做内容判定

**用户决策原文**：「在作业模块出现的不管叫什么都算作作业 tab，在考试模块出现的不管叫什么都算作考试 tab。」

依据：优学院课程左侧导航把 **「作业」与「考试」列为两个独立菜单项**（用户截图实测：工作台/单元/公告/课件/资源/知识图谱/**作业**/讨论/课堂/直播/**考试**/考核/成员）。因此 `kind` 严格等于**数据来源的接口模块**，与标题内容无关：

| 来源接口 | `kind` | 归入 Tab |
|---|---|---|
| `GET /courseapi/homeworks/student/v2` | `'homework'` | 作业 |
| `GET /courseapi/exams/student` 或 `/utestapi/exams/student` | `'exam'` | 考试 |

**因此明确不做**（本节以下旧分析全部作废，勿再实现）：
- ❌ 不按标题正则（`期末|期中|测验|考试`）判定条目性质 —— 叫「期末考试」但来自作业接口的条目，**就是作业**。
- ❌ 不做跨 kind 启发式去重（原 §12 D4 的 A/B 方案作废）。
- ❌ 不因「作业流已有期末考试」而抑制考试模块数据 —— 用户已确认**不会出现重复**。

**残留观察（仅记录，不驱动代码）**：本机缓存 121 条作业中有 6 条标题含考试类关键词（`500750` 期末考试、`500372` 期中测验、`484357` 测验 等），全部来自作业接口 ⇒ 按上述规则保持 `kind='homework'`，继续用作业模型与作业文案。这是**正确行为**，不是缺陷。

**兜底**：若未来真出现同一条目被两个模块返回，不自动抑制（自动抑制有漏考风险），只在诊断导出里记 warning 供用户判断。

#### 以下为作废的旧分析（保留供追溯，**不要据此实现**）

这是本方案**最容易漏掉的坑**，必须在实现前定策略，否则会出现「同一场考试提醒两遍」。

**实测依据**（`investigation/lms-homework-real.json`，2026-11-08 真实采集 121 条作业）：

| 采集到的那条「作业」 | `type` | `homeworkTitle` |
|---|---|---|
| `id=500750` | 9 | `《大学生职业生涯规划》(26-27-1)期末考试` |
| `id=500372` | 9 | `2026-10-29 21:40 周四期中测验` |
| `id=484357` | 3 | `2025-12-07 11:00  测验` |

即：**优学院的作业接口 `/courseapi/homeworks/student/v2` 里本来就含"期末考试/期中测验/测验"这类考试性质的条目**，它们走的是作业模型（有 `endTime` 当截止、有 `status` 当提交状态），已经能被现有提醒引擎覆盖。

**因此存在两个方向的问题**：

1. **重复提醒（主要风险）**：同一场考试若同时出现在
   - 作业流 → `id = ulearning:500750`，键 `${id}:${dueAt}:${hours}`
   - 考试流 → `id = ulearning:exam:<examId>@<ms>`，键 `${id}:start:<offset>:<ms>`

   两个键**物理上不可能相等**（这是 §4.3 刻意设计的结果），于是去重机制**完全失效** → 用户收到两条指向同一场考试的提醒，且文案一个说"作业即将截止"、一个说"考试即将开始"。

2. **覆盖空洞（次要）**：反向不成立 —— 纯考试模块里发布的考试（尤其需要进考场作答的）可能**不在**作业流里，所以不能因为"作业流已经有期末考试"就砍掉考试模块。

**建议策略（需产品确认，见 §12 D4）**：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 标题启发式去重** | 归一化标题后匹配 `/(期末|期中|测验|考试|补考|重修考试)/` + 同课程 + 时间窗接近（±48h）⇒ 标记为「疑似重复」，**保留考试行、抑制其提醒**，作业行照常提醒 | 误判风险；正则属**启发式**，必须在代码注释与 UI 上标明「按标题推断，可能不准」 |
| **B. 不做去重，UI 标「可能是同一场考试」** | 两条都显示、都提醒，但考试行加灰字提示 | 用户被判双向打扰，但**零误判** |
| **C. 一期先只做「作业流里的考试」** | 不接考试模块，改为在作业列表上加「考试」徽标（按标题/`type` 判断）+ 复用现有提醒 | 改动最小、零新接口风险；但拿不到"进考场"类考试 |

> **工程倾向：一期先 C + 预留 A**。理由：C 完全不依赖 §3 的任何未知项（C.1/C.5/C.6），可以立刻让「考试」进入提醒范畴且**不新增任何未验证接口**；等拿到真实考试响应后再按 A 做跨流去重合并。若你要的是"尽快能在提醒里看到考试"，C 的性价比远高于 S1–S8 全量改造。

**无论选哪个，都必须新增一条不变式测试**：同一「课程 + 标题 + 时间窗」的作业项与考试项，**不得同时产生提醒**（A）或**必须在 UI 上互相标注**（B/C）。

---

## §5 提醒设计

### 5.1 语义：考试锚点 = `startsAt`，不复用 `dueAt`

| 项 | 作业（现状） | 考试（本案） |
|---|---|---|
| 主锚点 | `dueAt`（截止） | `startsAt`（开考） |
| 次锚点 | — | `endsAt`（结束），由 D1 决定是否提醒 |
| 过期判定 | `dueAt < now`（`filter.ts:67-70`） | `(endsAt ?? startsAt) < now`（§8.5） |
| 提醒键基 | `id`（替换 `sourceAssignmentId`，见 5.3） | `id`（含场次开始毫秒） |

**为什么不能复用 `dueAt`**：`filter.ts:58` 的 `hideExpired` 默认 `true`，`isExpired()` 基于 `dueAt`（`filter.ts:67-70`、`:88`）。若把考试开始时间塞进 `dueAt`，**已开考但未结束**的考试会被默认隐藏 —— 这是产品级误伤（用户正在考试，列表里反而没了）。因此考试必须有自己的 `startsAt/endsAt` 两个字段，过期由 `endsAt` 判定。

### 5.2 哪些场次参与提醒

| 情形 | 是否提醒 | 理由 |
|---|---|---|
| `timePrecision === 'datetime'` 且 `startsAt` 存在 | 是 | 有确定锚点 |
| `startsAt === null`（`@nostart` 兜底项） | **否** | 无锚点不能瞎推算（对齐「无 dueAt 不参与阈值提醒」`planner.ts:94-95`） |
| `endsAt < now - graceMs` | 否 | 已结束太久，防轰炸（复用 `graceMs` 语义 `planner.ts:89`、`:115`） |
| `attendance === 'unknown'` | **是**（但文案低确定性） | 参加状态不明**不能**抑制提醒，否则漏考；文案见 §5.7 |
| 命中用户关闭的阈值 | 否 | 逐项开关（`ThresholdSetting.enabled`） |

### 5.3 提醒键（**必须改为基于 `a.id`** —— 已确认的最大漏洞）

```ts
// 现状 planner.ts:62-64
export function reminderKey(a: Assignment, thresholdHours: number): string {
  return `${a.source}:${a.sourceAssignmentId}:${a.dueAt ?? 'no-due'}:${thresholdHours}`;
}
```

问题：`sourceAssignmentId` **不含 kind**，且作业与考试的 `source` 都是 `ulearning` ⇒ 若某考试 `examId` 与某作业 `id` 数值相同（或未来任何一侧拼出相同串），两条记录会**共用同一个提醒键**，后者被 `firedKeys` 去重吃掉 ⇒ **漏提醒**，破坏 ADR-007 的不变量。

改为：

```ts
/** 作业键：与现键**逐字节相同**（见下方证明），迁移无需清 reminders。 */
export function homeworkReminderKey(a: HomeworkItem, thresholdHours: number): string {
  return `${a.id}:${a.dueAt ?? 'no-due'}:${thresholdHours}`;
}
// 现键 = `${source}:${sourceAssignmentId}:${dueAt}:${hours}`；而 a.id === `${source}:${sourceAssignmentId}`
// ⇒ 两者完全相同。这是本次改造可以「零清理迁移」的关键。

/** 考试键：id 已含场次开始毫秒；再把锚点时间与偏移放进键。 */
export function examReminderKey(
  x: ExamItem,
  anchor: 'start' | 'end',
  offsetMinutes: number,
  anchorAtMs: number,
): string {
  return `${x.id}:${anchor}:${offsetMinutes}:${anchorAtMs}`;
}
```

- 作业键**不变** ⇒ `store.reminders` 中既有 9 条记录继续有效，`firedKeys` 不会因改造而重放历史通知。
- 考试键前缀 `ulearning:exam:…` 与作业键前缀 `ulearning:500750:` 不可能互相 `startsWith` 匹配（`app-store.ts:221-225` 的 `clearRemindersForAssignment(source, assignmentId)` 改为 `clearRemindersForListItem(itemId)`，前缀 `${itemId}:`）。
- 改期语义：`startsAt` 变 ⇒ id 变 ⇒ 键变；只改 `endsAt` ⇒ id 不变但键里的 `anchorAtMs` 变 ⇒ 旧键失效。两个方向都安全。

### 5.4 分钟级独立阈值（**不能挂在现有 `thresholds` 上**）

现有 `ThresholdSetting.hours` 是整数小时，且 `normalizeThresholds()` 用 `Math.round(hours)` 取整（`thresholds.ts:59`）—— 示例：0.5 → 1 小时（30 分钟精度被抹平），0.4 → 0 小时（随后被 `enabledThresholds()` 的 `hours > 0` 过滤扔掉，`thresholds.ts:41`），即分钟级阈值**在这个模型里无法表达**。因此新增独立配置，**不改** `thresholds`（作业侧零风险）：

```ts
// src/shared/thresholds.ts 追加（不改现有 ThresholdSetting）
export interface ExamThresholdSetting {
  /** 锚点：开考 / 结束。 */
  anchor: 'start' | 'end';
  /**
   * 相对锚点的分钟偏移。
   *  > 0：提前 N 分钟（如 1440 = 提前 1 天）
   *  = 0：锚点当时（如「现在开考」）
   *  < 0：锚点之后 N 分钟（如 -30 = 开考后 30 分钟）
   */
  offsetMinutes: number;
  enabled: boolean;
  /** 强制弹出（不受静默时段抑制），对齐 existing urgent 语义。 */
  urgent: boolean;
}

/** 默认（D1 决策点：开始锚点为基线；end 锚点默认空，待 D1 选定后填）。 */
export const DEFAULT_EXAM_THRESHOLDS: ExamThresholdSetting[] = [
  { anchor: 'start', offsetMinutes: 1440, enabled: true, urgent: false }, // 提前 1 天
  { anchor: 'start', offsetMinutes: 120,  enabled: true, urgent: true  }, // 提前 2 小时
  { anchor: 'start', offsetMinutes: 30,   enabled: true, urgent: true  }, // 提前 30 分钟
  { anchor: 'start', offsetMinutes: 0,    enabled: true, urgent: true  }, // 开考时刻
];

/** 主进程侧校验（渲染进程不可信）：去重、限幅、按 |offset| 降序。 */
export function normalizeExamThresholds(input: unknown): ExamThresholdSetting[];
```

限幅建议：`-1440 <= offsetMinutes <= 30 * 1440`，`anchor ∈ {'start','end'}`，同 `(anchor, offset)` 去重，最多 10 条。主进程校验入口必须与 `normalizeThresholds` 并列（`src/main/index.ts:252-304` 的 `app:updateSettings` 中追加一段，模式照抄 `:255-258`）。

### 5.5 触发时刻与幂等

```
对每个 ExamItem（timePrecision === 'datetime'）：
  for t of enabledExamThresholds:
     anchorAtMs = (t.anchor === 'start' ? startsAtMs : endsAtMs)
     if (!anchorAtMs) continue                      // end 锚点但 endsAt 未知 => 跳过
     fireAtMs = anchorAtMs - t.offsetMinutes * 60_000
     if (fireAtMs > now) continue                    // 未到点，交给调度器下一拍
     if (now - anchorAtMs > graceMs) continue         // 已过锚点太久，不补发（默认 24h，同 planner.ts:89）
     if (firedKeys.has(examKey)) continue
     emit PlannedReminder { kind: 'exam', ... }
```

- 调度器 tick 仍是 60s（`scheduler.ts:24-25`），分钟级阈值天然够用；**不需要**改 tick。
- 排序沿用 `fireAtMs` 降序（`planner.ts:135`）。
- 去重来源不变：`store.getReminders()` → `Set(keys)`（`scheduler.ts:102`）。

### 5.6 考试阶段（phase）由本地时间推导，**不依赖** `examState`

```ts
export type ExamPhase = 'upcoming' | 'ongoing' | 'ended' | 'unknown';

export function examPhase(x: ExamItem, nowMs: number): ExamPhase {
  const s = dueToMs(x.startsAt);      // 复用现成工具（datetime.ts:146-150）
  const e = dueToMs(x.endsAt);
  if (s === null) return 'unknown';
  if (nowMs < s) return 'upcoming';
  if (e === null) return nowMs >= s ? 'ongoing' : 'unknown'; // 无结束时间：按「进行中」保守处理，文案标注不确定
  return nowMs < e ? 'ongoing' : 'ended';
}
```

理由：`examState` 值域未验证（C.9），且已被前端用 `publishStatus` 合成过（`module_course_exam_examController.js:135`）⇒ 不可信。本地时间推导的 phase 只依赖我们自己归一化的 `startsAt/endsAt`，可单测、可解释。

### 5.7 文案（kind 必须参与，禁止复用作业文案）

| 场景 | 标题 | 正文 |
|---|---|---|
| 提前 ≥1 天 | `考试提醒（还有 N 小时开考）` | `《{title}》（{courseName}）将于 {startTime} 开考，请提前准备。` |
| 提前 ≤2 小时（urgent） | `⚠️ {N} 分钟后开考` | 同上 + `请确认考场与设备。` |
| offset = 0（开考时刻） | `考试已开始` | `《{title}》已于 {startTime} 开考，结束时间：{endTime 或「未提供」}。` |
| end 锚点（若 D1 选 B/C） | `考试即将结束（还剩 N 分钟）` | `《{title}》将于 {endTime} 结束。` |
| 时间来自**未验证**字段（phase-1 灰度期） | 前缀 `请核对考试时间` | `《{title}》考试信息来自未验证的接口字段，请打开优学院核对。` |
| 参加状态未知 | **不单独成句** | 考试提醒不涉及「你交没交」，因此不写「你还没参加」；`attendance` 仅在列表状态列展示为「未知」 |

`PlannedReminder` 需要扩展（`planner.ts:16-33`）：新增 `kind: 'homework' | 'exam'`、`examPhase?`、`anchor?`、`offsetMinutes?`；保留 `thresholdHours`（作业用）并新增 `thresholdMinutes?`（考试用）。`reminderText()`（`planner.ts:164-190`）与 `ToastManager.toItem()`（`toast-manager.ts:122-149`）必须按 `kind` 分支 —— 现状两处都硬编码「作业即将截止」，直接复用会产出**错误文案**。

### 5.8 `urgent` 与静默时段

- 现状机制已满足需求：`scheduler.ts:121-129` 把 `planned` 拆成 `urgent` / `normal`，静默时段内只发 urgent、normal 只记录不弹（`:124-129`），`toSend = inQuiet ? urgent : planned`（`:141`）。
- 考试侧默认 urgent 的项：`offset ∈ {120, 30, 0}`（开考前 2 小时 / 30 分钟 / 开考瞬间）。**开考瞬间必须 urgent**：错过即为 0 分风险。
- 静默时段例外**不需要新代码**，只需考试阈值正确设置 `urgent`。
- 需新增一条不变式测试：静默时段内「开考中」的考试**仍然弹出**（§9.2）。

### 5.9 不该做的事（红线）

- ❌ 用 `answerTimes > 0` 或 `examFinish` 判定「已参加」后**抑制**提醒 —— 依据不足（§2.2），会漏提醒。
- ❌ 用考试级 `startTime` 兜底场次时间 —— B.5 已证明它允许为空，且学生端根本不读它。
- ❌ 考试无时间时按「今天」或「下一整点」猜一个 —— 直接违反红线 3。
- ❌ 提醒文案里出现「未参加」「你还没考试」。

---

## §6 同步与缓存（per-kind outcome）

### 6.1 问题：现有 `SyncEngine` 是「一平台一结果」

现状 `SourceSyncResult`（`sync-engine.ts:15-24`）只有一个 `outcome`；`syncOne()` 失败时保留该平台全部缓存（`sync-engine.ts:156-190`）。若考试与作业共用一次 `listAssignments()` 调用，则：
- 考试接口失败 ⇒ 整平台 `failed` ⇒ 作业也拿不到新数据（过度失败）；
- 或作业成功、考试失败时若共用 `replaceAssignments()` ⇒ **考试失败会把作业缓存一起清掉**（直接违反 AGENTS.md「失败不得清空缓存」）。

故必须 **per-kind 独立结果 + 按 kind 部分替换**。

### 6.2 契约改动

```ts
// packages/shared/src/source/assignment-source.ts
export interface ListItemsResult<T extends ListItem = ListItem> {
  items: T[];
  /** 是否覆盖了全部课程/分页。 */
  complete: boolean;
  /** 非致命告警（单课程失败、字段缺失跳过、容器降级等）。必须透传到 UI 诊断。 */
  warnings: string[];
}

export interface AssignmentSource {
  readonly source: SourceId;
  readonly displayName: string;
  /** 本平台支持的列表类型。hw = ['homework']；ulearning = ['homework', 'exam']。 */
  readonly supportedKinds: readonly ListItemKind[];
  connect(): Promise<SessionStatus>;
  checkSession(): Promise<SessionStatus>;
  /** 作业列表（由现 listAssignments 改名/包装，语义不变）。 */
  listHomework(options?: ListOptions): Promise<ListItemsResult<HomeworkItem>>;
  /** 考试场次列表。仅 supportedKinds 含 'exam' 的平台实现。 */
  listExams?(options?: ListOptions): Promise<ListItemsResult<ExamItem>>;
  close(): Promise<void>;
}
```

**关键点**：`supportedKinds` 代替「给 hw 也编一个空考试结果」。hw 平台没有考试功能，若返回 `empty` 会让 UI 显示「考试 0 条 = 你没有考试」，属于把「不具备该能力」伪装成「没有数据」—— 同样触红线 3。

### 6.3 结果结构

```ts
// src/main/sync/sync-engine.ts
export interface KindSyncResult {
  kind: ListItemKind;
  outcome: SyncOutcome;      // 复用 packages/shared/src/model/sync.ts:36-64
  /** 本次有效条数（失败时为缓存条数）。 */
  count: number;
  /** 本 kind 的数据是否可能过期。 */
  stale: boolean;
  warnings: string[];
  durationMs: number;
}

export interface SourceSyncResult {
  source: SourceId;
  kinds: KindSyncResult[];
  session: SessionStatus;
  /** 兼容旧字段：作业条数（= kinds 中 homework 的 count）。 */
  assignmentCount: number;
  durationMs: number;
}
```

`allOk` / `anyOk`（`sync-engine.ts:76-77`）改为按 kind 聚合：`allOk = 每个 platform 的每个 kind 都非 failed`；并新增 `partialKinds`（部分 kind 失败）供 UI 顶栏使用。

### 6.4 考试拉取策略（含分支回退，对齐 EVIDENCE §D Q1）

```
listExams():
 1. 前置：checkSession() === connected（复用现实现，ulearning-source.ts:229-313）
 2. 取课程列表：GET /courseapi/courses/students?pn=1&ps=50&lang=zh   （已实测，ulearning-source.ts:370-380）
    失败 => throw（由 SyncEngine 归类 failed）
 3. 逐课程（限 maxCourses，默认 40，同现状 ulearning-source.ts:338）：
      a. 先打新分支：GET /utestapi/exams/student?ocId=<id>&pn=1&ps=20
      b. 若 HTTP 404 / 业务码表示「无此接口」/ 响应体非 JSON => 回退旧分支：
         GET /courseapi/exams/student?ocId=<id>&keyword=&pn=1&ps=20&lang=zh
      c. 401/403/业务码 2001/2101/2201 => 会话失效 => 整次 throw needs_login（不要逐课程重试）
      d. 两条都失败 => 该课程计 warning，若全部课程失败 => throw parse_error
      e. 成功 => 解析容器；容器不识别 => parse_error（★ 不能当空列表）
 4. 场次展开：examList[].examRelationTimeList[] 每项 => 一个 ExamItem（§4.2/4.3）
     examRelationTimeList 为空/缺失 => 生成一条 @nostart 兜底项（不提醒，仅可见）
 5. warnings 汇总：单课程失败、字段缺失跳过、考试级时间缺失、未验证形状命中
 6. 限流：复用 RateLimiter（ulearning-source.ts:104、rate-limit.ts），与作业共享串行队列
```

**为什么要「先新后旧」而不是先判 `hasMenu(54)`**：判分支需要一次额外 GET，且其响应形状未验证（C.4），失败时还要再兜一次；而「先打新分支、404 回退」最多两次 GET 且不需要理解 `hasMenu` 语义（evidence §D Q1 结论）。

**请求预算**：25 门课 × 最多 2 次 = ≤50 次 GET，串行 + 限流；这是 C.11 未定前的可接受上限，二期评估日历或日期范围接口。

### 6.5 失败与缓存

| 场景 | 结果 | 缓存动作 |
|---|---|---|
| 考试 kind 失败 | `kind: 'exam'` 的 outcome = `failed` | **只** `markSession()` + 记 exam 侧 stale；`assignments.*`（作业）**一个字节都不动** |
| 作业 kind 失败、考试成功 | homework failed / exam ok | 同理反向：只替换 `exams.ulearning` |
| 考试成功但 0 场次 | `outcome.kind === 'empty'`，`confirmedAt` | `replaceExamItems('ulearning', [], at)` + 记录 `lastSuccessByKind.ulearning.exam` |
| 考试容器不识别 | `failed / parse_error` | 保留旧考试缓存，UI 显示「考试同步失败」 |
| 会话失效 | 两 kind 都 `failed / needs_login` | 全部保留缓存（现状行为，`sync-engine.ts:101-125`） |

### 6.6 修既有缺陷：`warnings: []` 写死

`sync-engine.ts:150` 现为：

```ts
outcome: { kind: 'ok', source: sourceId, assignments: list, complete: true, warnings: [] },
```

`complete` 与 `warnings` 都写死 ⇒ 适配器无法表达「读了 25 门课，其中 3 门失败」。改造后：

```ts
const r = await source.listHomework({ timeoutMs });
outcome: { kind: 'ok', source, assignments: r.items, complete: r.complete, warnings: r.warnings }
```

并把 `warnings` 一路透传到 `AppSnapshot`（`ipc.ts:32-46` 新增 `warnings: SourceWarningDto[]`）与诊断导出（`src/main/index.ts:400-420`），UI 在 SourceStatus 上显示「部分数据可能不全」而非静默。

### 6.7 幂等与并发

- `syncAll()` 的复用同一 Promise 机制不变（`sync-engine.ts:55-61`）—— 考试会显著增加单次同步耗时（≤50 次 GET），必须保留「并发触发不重复请求」。
- **单 kind 超时独立（已实现）**：考试因逐课程请求而耗时更长，引擎内对 exam kind 使用 `Math.max(timeoutMs, EXAM_TIMEOUT_MS=120s)` 提升超时。
  上层 `index.ts` 仍传默认 90s 且不区分 kind，实际生效值由引擎内提升保证。
  > 原计划提议的 `ListOptions.perCourseTimeoutMs` **已放弃**：`lmsGet` 不支持 per-request 超时，
  > 加了也没人用，属死字段。若要真正控制单课程超时，需先让 `lmsGet` 支持 AbortSignal。

### 6.8 实现阶段发现的额外缺陷（计划未覆盖，已修）

**按 kind 部分成功时会静默清掉未读到的条目。** 当 `complete=false` 且 `items.length > 0` 时，
若直接整体替换缓存，则本次**读取失败的那些课程**下的旧条目会被静默删除 —— 这等价于
「按条目粒度清缓存」，违反「失败不得清空缓存」的本意。

实现改为 `mergeKeepingUnreadItems()`：
- `complete=true` ⇒ 整体替换（平台真删掉的条目应当消失）；
- `complete=false` ⇒ 本次读到的覆盖旧值，**没读到的保留旧条目**，同时标 `stale=true` + warning。

两条用例分别覆盖这两种情形（`sync-engine.test.ts`）。

### 6.9 场次时间部分非法时的取舍（与原任务书不同，已采纳）

当同一场考试有多个场次、其中**部分**场次时间解析失败时：
- 只列时间合法的场次 + 记 warning；
- **不再为每个非法场次补一条 `@nostart` 行** —— 否则同一考试会在列表里出现多条同名重复行，比「少一行」更误导；
- 只有当这场考试**完全没有任何可用时间**时，才兜底一条 `@nostart`（保证"它确实存在"这件事可见，只是不提醒）。

---

## §7 存储与迁移（schema v2 → v3）

### 7.1 现状

`schemaVersion = 2`（`app-store.ts:17`），`StoreSchema`（`:67-80`）：
`assignments: Record<SourceId, Assignment[]>`、`lastSuccess`、`sessions`、`reminders`、`overrides`。迁移函数 `migrate()` 在 `:119-156`，v1→v2 的写法可照抄。

### 7.2 新 schema（**纯追加，不移动现有键**）

```ts
export const SETTINGS_SCHEMA_VERSION = 3;

export interface StoreSchema {
  schemaVersion: number;
  settings: AppSettings;                       // + examThresholds
  /** 作业缓存。语义收窄为「只存 homework」，键路径不变 => 零数据搬迁。 */
  assignments: Record<SourceId, HomeworkItem[]>;
  /** 【新】考试场次缓存，按来源分键 => 考试失败不会碰到 assignments。 */
  exams: Record<SourceId, ExamItem[]>;
  lastSuccess: Partial<Record<SourceId, string>>;                       // 保留（作业）
  /** 【新】按 kind 的最近成功时间，用于 kind 级 stale 判定。 */
  lastSuccessByKind: Partial<Record<SourceId, Partial<Record<ListItemKind, string>>>>;
  sessions: Partial<Record<SourceId, SessionStatus>>;
  reminders: ReminderRecord[];                 // 键格式兼容（§5.3）
  overrides: Record<string, {...}>;            // 一期仅作业；考试不开放手动覆盖
}
```

为什么**新增 `exams` 而非把 `assignments` 改成 `Record<source, Record<kind, item[]>>`**：
- 认路径迁移 `assignments.ulearning` 等已存在于用户机器上的数据，改结构必须搬迁 121+20 条并承担写坏风险；
- 「按 kind 部分替换」用**拆键**即可天然满足（`replaceExamItems()` 只写 `exams.*`）；
- 回滚友好（§11.3）。

### 7.3 迁移算法（v2 → v3，幂等）

```
migrate():
  v = get('schemaVersion') ?? 0
  if (v >= 3) return                       // 幂等：重复启动不重复迁移
  if (v < 3):
    1) 若 !get('exams') => set('exams', { ulearning: [], hw: [] })
    2) 若 !get('lastSuccessByKind') => set('lastSuccessByKind', {})
    3) settings 补 examThresholds：
         若 settings.examThresholds 不是非空数组 => 复制 DEFAULT_EXAM_THRESHOLDS
       **不动** settings.thresholds（作业阈值用户已配置，不能重置）
    4) 缓存数据补判别字段（向后兼容关键）：
         for source of ['ulearning','hw']:
           for item of get(`assignments.${source}`):
             if (item.kind !== 'homework') item.kind = 'homework'
         原因：v2 期间写入的缓存与 scripts/seed-from-evidence.mjs 产出的数据都没有 kind；
         缺 kind 会让 TypeScript 之外的真实数据在运行时进入 exam 分支判断（undefined !== 'exam' 还算安全，
         但 exhaustive switch 会落到 default 分支，且 UI 徽标取值 undefined）。显式补齐。
    5) set('schemaVersion', 3)
```

**不做**的事：不清 `reminders`（键兼容，§5.3 已证明逐字节相同）、不重算 `overrides`、不动 `sessions`。

### 7.4 AppStore API 改动

| 现有方法 | 改动 |
|---|---|
| `getAllAssignments()`（`app-store.ts:181-183`） | 保留 = 作业合集；**新增** `getAllListItems(): ListItem[]`（作业 + 考试，按 `startsAt/dueAt` 由调用方排序） |
| `getAssignments(source)`（`:177-179`） | 保留语义 = 仅作业 |
| `replaceAssignments(source, list, at)`（`:186-189`） | 语义 = 仅替换作业；**新增** `replaceExamItems(source, list, at)` 写 `exams.${source}` + `lastSuccessByKind.${source}.exam` |
| `getLastSuccess(source)`（`:200-202`） | 保留；**新增** `getLastSuccessByKind(source, kind)` |
| `clearRemindersForAssignment(source, assignmentId)`（`:221-225`） | 改名/扩展为 `clearRemindersForListItem(itemId)`，前缀 `${itemId}:`；作业侧行为等价（因为 `id === source:sourceAssignmentId`） |
| — | **新增** `getExamItems(source)`、`getExamCount(source)`（给 SourceStatus 显示「N 条作业 / M 场考试」） |

---

## §8 UI / 交互

### 8.1 列表（`AssignmentTable.vue` → 建议更名 `ItemTable.vue`）

| 列 | 作业行 | 考试行 |
|---|---|---|
| 类型 | `作业` 徽标（灰） | `考试` 徽标（强调色） |
| 平台 | 现状（`AssignmentTable.vue:70-73`） | 同 |
| 标题 | 现状 | 现状 |
| 课程 | 现状 | 现状 |
| 时间 | `截止时间` + `duePrecision==='date'` 时「（时间待确认）」（`:12-17`） | `开考时间` / `结束时间`（两行），结束未知显示「未提供」 |
| 剩余 | `formatRemaining(now, dueAt, duePrecision)`（`:8-10`） | 到期前：`距开考 X`；进行中：`进行中（剩 X）`；结束：`已结束` |
| 状态 | 现状 `statusBadge()`（`:19-28`） | **`未知`**（attendance）+ 阶段徽标 `未开始/进行中/已结束/时间未知`；**禁止**出现「未参加」「未提交」 |
| 操作 | 现状「打开」（`:87`） | 同，`detailUrl === null` 时禁用 |

行样式：考试行不要复用 `row-pending/row-submitted`（`AssignmentTable.vue:64-69` 依赖 `submissionStatus`），改为按 `examPhase` 着色（进行中=强调，未开始=普通，已结束=灰）。

### 8.2 统计卡片（`App.vue:94-106, 208-224`）

现状三卡依赖 `submissionStatus`，对考试行会误计（`a.submissionStatus` 在 `ExamItem` 上不存在 ⇒ 改造后是编译错误，天然强制改写）：

| 卡片 | 新定义 |
|---|---|
| 未完成作业 | 仅 `kind==='homework' && (not_submitted || unknown)` |
| 72 小时内截止（作业） | 仅 homework |
| 考试（7 天内开考 + 进行中） | `kind==='exam' && (phase==='ongoing' || (upcoming && startsAt-now ≤ 7d))` |
| 已完成（作业） | 仅 homework `submitted` |

D2 若选「分 Tab」，卡片应按 Tab 语境切换文案（§12）。

### 8.3 状态文案红线

- 考试状态列**只允许**：`未知` / `未开始` / `进行中` / `已结束` / `时间未知`。
- 绝不允许：`未参加`（`nls_exam.js:58` 平台有这个词，但我们无可靠来源）、`未提交`、`已提交`。
- 工具提示必须说明原因：「平台未提供可靠的参加状态，本应用不做推断」——这是红线 3 的可见化。

### 8.4 筛选（`filter.ts` + `FilterBar.vue`）

新增 **类型** 维度：

```ts
export type KindFilter = 'all' | 'homework' | 'exam';
export interface FilterState { /* 现有 8 项（filter.ts:33-50） */ kind: KindFilter; }
export const DEFAULT_FILTER = { ..., kind: 'all' };   // filter.ts:52-61
```

行为细则：

| 筛选 | 作业 | 考试 |
|---|---|---|
| `status` 下拉 | 现状 4 项（`not_submitted/submitted/unknown/overdue`） | 仅 `unknown` 与 `overdue`（=已结束）有意义；`not_submitted`/`submitted` 对考试**不匹配任何行**（必须在 UI 上把这两个选项在「类型 = 考试」时置灰，避免用户看到空列表以为是没考试） |
| `dueRange` | 基于 `dueAt` | 基于 `startsAt`（`today/3d/7d/30d` = 距开考；`overdue` = 已结束；`unknown` = `startsAt === null`） |
| `remainRange` | 基于 `dueAt - now` | 基于 `startsAt - now`；`none` = 无开始时间 |
| `hideExpired` | `dueAt < now` | 见 8.5（D3） |
| `keyword` | 标题 + 课程 | 同 |
| `sort` | `dueAt`（`filter.ts:149-192`） | 统一锚点：`anchorOf(item) = homework.dueAt / exam.startsAt`；无锚点置底（`Number.MAX_SAFE_INTEGER`，同现状 `:158`） |

`isExpired()`（`filter.ts:67-70`）、`countBy()`（`:213-224`）、`sortList()` 全部要按 kind 分支 —— 这是**编译期**就会报错的点（`UiListItem` 上没有 `dueAt`/`submissionStatus`），清单见 §9.3。

### 8.5 `hideExpired` 与考试（D3 决策点）

技术基线（不依赖 D3 选择也要满足的约束）：**进行中的考试不得被默认隐藏**。

```ts
export function isExpired(item: UiListItem, nowMs: number): boolean {
  if (isExamItem(item)) {
    const end = dueToMs(item.endsAt) ?? dueToMs(item.startsAt);
    return end !== null && end < nowMs;      // 用 endsAt 判过期：已开考未结束 => 未过期
  }
  const d = dueToMs(item.dueAt);
  return d !== null && d < nowMs;            // 现状逻辑不变（filter.ts:67-70）
}
```

D3 的 A/B/C 只影响「是否有额外开关」，上面这段是三种选项的共同下限。

### 8.6 设置页（`SettingsPanel.vue`）

新增「考试提醒」区块（放在现有阈值表 `SettingsPanel.vue:89-142` 之后）：

| 列 | 内容 |
|---|---|
| 锚点 | 开考 / 结束 |
| 提前（分钟） | 数字输入（正整数），或「开考时」/「开考后 N 分钟」 |
| 启用 / 强制弹出 | checkbox，语义同现状 |
| 说明 | 运行时文案：`开考前 1 天`、`开考前 30 分钟（强提醒）` |
| 新增 | 分钟数输入 + 锚点选择 + 回车添加；限幅 `-1440 ~ 43200` |
| 提示语 | 「考试提醒不受静默时段限制的项会标『强制』；考试参加状态平台未提供，本应用不推断。」 |

同时新增一项全局开关 **「同步优学院考试」**（`settings.examSyncEnabled`）。

> **2026-11-11 用户决策变更：默认值由 `false` 改为 `true`（默认开启）。**
> 依据是用户要求「考试同步默认是开启」。这意味着每次同步都会真实请求考试接口。
>
> **默认开启的前提条件（已由实现满足，不可回退）：**
> 1. 适配器遇到「容器识别不了 / 会话失效 / 响应非 JSON」**必须抛错**，
>    由同步层归类为 `failed`（`parse_error` / `needs_login`），UI 显示「考试同步失败」；
>    绝不能返回空数组——那会把"读不懂"伪装成"你没有考试"（红线 3）。
> 2. 考试 kind 失败**不得影响作业缓存**（拆键存储 `exams.*` 保证）。
> 3. 失败时保留上次的考试缓存并标 `stale`，不清空。
> 4. 用户仍可在设置里显式关闭；关闭后不请求、也不清既有缓存。

关闭时：不请求考试接口、`exams.*` 保留缓存。开启时若失败，UI 必须明确提示失败原因。

---

## §9 测试计划

### 9.1 基线（实测，作为回归门槛）

| 项 | 基线（2026-11-10 15:23–15:24） | 命令 |
|---|---|---|
| 单测 | **180 passed / 9 files / 0 failed** | `$env:NODE_OPTIONS=''; npx vitest run` |
| 主进程类型 | 0 error | `$env:NODE_OPTIONS=''; npx tsc -p tsconfig.node.json --noEmit` |
| 渲染进程类型 | 0 error | `$env:NODE_OPTIONS=''; npx vue-tsc -p tsconfig.web.json --noEmit` |

> 本机 `NODE_OPTIONS=--require worker-events.cjs` 会污染 Electron/子进程，纯 vitest/tsc 实测不受影响，但脚本化调用仍建议置空（AGENTS.md §6）。

### 9.2 新增用例清单（全部 to-be）

| 新文件 | 用例（≥ 数量） | 必须覆盖 |
|---|---|---|
| `packages/shared/src/model/list-item.test.ts` | 8 | id 规则（作业/考试不撞车、`@nostart`）；`isExamItem` 收窄；`ExamItem` 上**不存在** `submissionStatus`（`@ts-expect-error` 断言）；`parseExamTime` 双格式（毫秒 / ISO / 空 / 非法 → null）|
| `packages/shared/src/model/datetime.test.ts`（追加） | 6 | `parseExamTime` 秒级误判保护、`YYYY-MM-DD`（仅日期）→ `null`、`""`/`null`/`undefined` → `null`、+08:00 输出 |
| `src/main/reminder/planner.test.ts`（追加） | 10 | 考试提前 1440/120/30/0 分钟各触发一次；`endsAt` 为空时 end 锚点跳过；`@nostart` 不提醒；已结束超 24h 不补发；`urgent` 标记正确；键含 `anchorAtMs`（改 `endsAt` 后旧键失效）；同一场次不同 offset 互不影响；**考试键与作业键前缀不互相匹配**；`examPhase` 四态 |
| `src/main/reminder/scheduler.test.ts`（追加） | 4 | 静默时段内「开考」提醒仍弹出（urgent）；静默时段内普通考试提醒只记录不弹；考试文案不含「未参加」；第二次 tick 幂等 |
| `src/main/sync/sync-engine.test.ts`（追加） | 8 | 考试 failed 不动作业缓存；作业 failed 不动考试缓存；考试容器不识别 → `parse_error` 而**非** `empty`；考试 empty 与 failed 区分；`warnings` 透传；`complete=false` 透传；`supportedKinds=['homework']` 的平台不产生考试结果；`allOk` 按 kind 聚合 |
| `src/main/store/app-store.migration.test.ts`（新增） | 5 | v2→v3 幂等（跑两次结果一致）；`exams` 初始化为空；`examThresholds` 补默认但`thresholds` 不动；v2 缓存补 `kind:'homework'`；`reminders` 原样保留 9 条 |
| `src/renderer/src/logic/filter.test.ts`（追加/改造） | 12 | 类型维度筛选；考试 `isExpired` 用 `endsAt`（进行中不隐藏）；`status=unknown` 命中考试；`status=submitted` 不命中考试；`dueRange=today` 按开考算；混合排序锚点正确；`countBy` 分类型计数；考试无开始时间置底 |
| `src/main/sources/ulearning-exam.test.ts`（新增） | 8 | `normalizeExamItem()` 纯函数：容器不识别 → 抛 `parse_error` 类错误；`examRelationTimeList` 展开成 N 项；`@nostart` 兜底 1 项；`examId` 缺失 → 跳过 + warning；时间非法 → `startsAt=null` + warning；`attendance` 恒 `unknown`；`detailUrl` 过 allowlist；场次重复（同 examId 同 startTime）去重 |
| `scripts/exam-e2e.mjs`（新增，UI 端到端） | — | 用「**非真实响应的合成夹具**」灌 store，验证考试行渲染、状态列显示「未知」、统计卡片、筛选；不得宣称可替代真实接口验证 |

### 9.3 既有测试/代码的破坏面（改造必然破，需同批修改）

| 位置 | 为什么会破 | 修法 |
|---|---|---|
| `src/renderer/src/logic/filter.test.ts:18-38` 的 `mk()` 夹具 | 末尾 `as UiAssignment` 断言下缺 `kind` | 夹具加 `kind: 'homework'` |
| `src/main/sources/hw-source.test.ts`（22 例） | `normalize()` 返回 `Assignment` 缺 `kind` | 生产代码 `hw-source.ts:446-464` 加 `kind:'homework'`；测试不必改断言（值断言不受影响） |
| `src/main/sources/ulearning-source.test.ts`（14 例） | 同上，`normalizeHomework()`（`ulearning-source.ts:466-506`） | 同上 |
| `src/main/sync/sync-engine.test.ts`（14 例） | 假 Source 未实现 `supportedKinds` / `listHomework`；结果结构从 `outcome` 变 `kinds[]` | 假 Source 加 `supportedKinds:['homework']`、把 `listAssignments` 改名包装；断言改读 `kinds[0].outcome` |
| `src/main/reminder/planner.test.ts`（23 例） | 夹具缺 `kind`；`planReminders` 入参类型变 `ListItem[]` | 夹具加 `kind`，其余逻辑不变 |
| `src/main/reminder/scheduler.test.ts`（15 例） | 同上 + `PlannedReminder` 新字段 | 夹具加 `kind` |
| `src/main/store/demo-data.ts:73-97` | 返回 `Assignment[]` 缺 `kind` | 加 `kind:'homework'`；并补 2 条 `ExamItem` 演示数据（标题前缀 `【演示】`，`isDemoAssignment()` 判定须同步支持 exam） |
| `src/main/ipc/snapshot.ts:25-45` | 覆盖合并读 `a.submissionStatus`，`ListItem` 上不存在 | 按 kind 分支；考试不参与 overrides（一期） |
| `src/main/ipc/snapshot.ts:48-55` | 排序只用 `dueAt` | 改 `anchorOf(item)` |
| `src/main/index.ts:241-250`（打开链接） | `store.getAllAssignments()` 找不到考试 id | 改查 `getAllListItems()` |
| `src/main/index.ts:400-420`（诊断导出） | `reduce` 按 `submissionStatus` 分组，考试项为 undefined | 按 kind 分组 |
| `src/renderer/src/App.vue:94-106` | 统计读 `submissionStatus` | 按 kind 分支（§8.2） |
| `src/renderer/src/components/AssignmentTable.vue:19-37` | 状态/剩余读 `submissionStatus`/`dueAt` | 按 kind 分支（§8.1） |
| `scripts/e2e-ui.mjs:27`、`filter-e2e.mjs:60`、`fluent-ui-e2e.mjs:16`、`offline-e2e.mjs:50`、`reminder-e2e.mjs:49`、`resume-e2e.mjs:51`、`toast-e2e.mjs:36` | 这些脚本**手写 `schemaVersion: 2`** 的 store 负载 | 升级为 3 并补 `exams: {}`、`examThresholds`；或让迁移逻辑兜住（推荐两者都做：脚本显式写 3 + 迁移幂等） |
| `scripts/seed-from-evidence.mjs:44-85` | 产出条目无 `kind` | 加 `kind:'homework'`，并让 `schemaVersion: 3` |

> 以上破坏面**全部由编译器点名**（`kind` 必填 + `ListItem` 联合），属于本次设计的有意收益；不允许用 `as any` 或可选 `kind` 绕过。

### 9.4 必须保持的既有不变量（回归清单）

| 不变量 | 保护点 |
|---|---|
| 只有日期无时间不得补 23:59 | `datetime.test.ts`（21 例） |
| 无截止时间必须 `dueAt=null, duePrecision='none'` | `datetime.test.ts`、`normalize.test.ts:100` |
| 未提交/未知严格区分 | `hw-source.test.ts`、`ulearning-source.test.ts:118-137` |
| 失败不得清空缓存 | `sync-engine.test.ts:129-160` + 新增 per-kind 版 |
| 跳转链接必须过 allowlist | `normalize.test.ts:36-61` |
| hw `deadline` 是布尔 | `hw-source.test.ts` |
| 提醒键含锚点时间，改期后旧键失效 | `planner.test.ts:110-136` + 新增考试版 |
| **新增**：作业键与考试键不得互相匹配 | 新 `planner.test.ts` 用例 |
| **新增**：考试 `attendance` 恒 `unknown`，UI 不出现「未参加」 | 新 `list-item.test.ts` + `filter.test.ts` + UI 断言 |

---

## §10 分步实施序列

> 原则：**纯逻辑层先行**（可单测闭环），UI 其次，真实网络解析最后（受 C.1 阻塞）。每步都必须过门槛才进下一步。

| 步 | 内容 | 改动文件 | 验证命令 | 门槛 |
|---|---|---|---|---|
| S0 | **证据闸门**：确认 C.1 是否已回填（`investigation/lms/exam-probe-result.json` 出现真实 `$fields`） | 无代码 | `node scripts/probe-lms-exam.mjs --profile <副本> --json` | **不阻塞 S1–S4**；S8 必须等它通过，否则 S8 只能以「未验证 + 默认关闭」形态落地 |
| S1 | 模型层：判别联合 + `parseExamTime` + 考试阈值类型 + 全部构造点补 `kind` | `packages/shared/src/model/list-item.ts`(新)、`assignment.ts`、`datetime.ts`、`index.ts`、`src/shared/thresholds.ts`、`hw-source.ts:446`、`ulearning-source.ts:486`、`demo-data.ts` | `npx tsc -p tsconfig.node.json --noEmit`；`npx vitest run packages/shared` | 类型 0 error；shared 单测全绿；作业侧 180 例中除「缺 kind 的夹具」外不新增失败 |
| S2 | 提醒层：考试键/阈值/phase/文案 + `PlannedReminder.kind` | `planner.ts`、`scheduler.ts`、`toast-manager.ts`、`src/renderer/src/toast-main.ts` | `npx vitest run src/main/reminder` | 新增 14 例全绿；既有 38 例（planner 23 + scheduler 15）全绿 |
| S3 | 存储层：schema v3 + 迁移 + `replaceExamItems` + `clearRemindersForListItem` | `app-store.ts`、`app-store.migration.test.ts`(新) | `npx vitest run src/main/store` | 迁移幂等用例全绿；旧 store 副本可读出 121/20 条且 `kind` 已补齐 |
| S4 | 同步层：`supportedKinds` + `listHomework`/`listExams` + per-kind outcome + `warnings` 透传 | `assignment-source.ts`、`sync-engine.ts`、`sync-engine.test.ts` | `npx vitest run src/main/sync` | per-kind 隔离用例全绿；`warnings` 不再是 `[]` 写死 |
| S5 | IPC/快照契约：`UiListItem`、`AppSnapshot.warnings`、`SettingsDto.examThresholds`、`examSyncEnabled` | `src/shared/ipc.ts`、`snapshot.ts`、`src/main/index.ts`(updateSettings/校验)、`src/preload/index.ts`(类型无需改) | `npx tsc -p tsconfig.node.json --noEmit` | 0 error；`getSnapshot()` 手测含考试字段 |
| S6 | 渲染逻辑层：`filter.ts` kind 维度 + `isExpired`/`countBy`/`sortList`/`anchorOf` | `filter.ts`、`filter.test.ts` | `npx vitest run src/renderer` | 既有 35 例 + 新增 12 例全绿 |
| S7 | UI 组件：表格类型列/状态文案、统计卡片、筛选栏、设置页考试阈值表 + 全局开关 | `AssignmentTable.vue`、`FilterBar.vue`、`SettingsPanel.vue`、`App.vue` | `npx vue-tsc -p tsconfig.web.json --noEmit`；`$env:NODE_OPTIONS=''; node scripts/ui-shot.mjs`；`node scripts/filter-e2e.mjs` | 0 error；截图人工核对：考试行状态列只出现「未知/未开始/进行中/已结束」；缩放 100/125/150% 无溢出（对齐 `scripts/dpi-e2e.mjs`） |
| S8 | 考试适配器：`listExams()` 按 §6.4 实现，**整段 `未验证` 注释**，受 `examSyncEnabled`（默认 true）门控；容器不识别必须抛 `parse_error` | `ulearning-source.ts`、`src/main/sources/lms-exam.test.ts`(新) | `npx vitest run src/main/sources`；`$env:NODE_OPTIONS=''; node scripts/offline-e2e.mjs` | 单测全绿；断网/未登录路径仍显示「同步失败」而非「0 场考试」 |
| S9 | 端到端 + 文档回填 | `scripts/exam-e2e.mjs`(新)、`docs/PLATFORM_FINDINGS.md`、`docs/TESTING.md`、`docs/DECISIONS.md`（新增 ADR-010「考试=场次粒度」、ADR-011「考试提醒键为 id+锚点」）、`AGENTS.md` §5/§8 更正 | `node scripts/acceptance.mjs` | 一键验收通过；AGENTS.md 单主机+路径前缀的表述被更正；ADR 落地 |

**并行建议**：S1 与 S2 有依赖（S2 用 S1 类型）→ 串行；S3 与 S4 可并行（拆键后互不依赖）；S5 依赖 S1/S3/S4；S6 只依赖 S1（`UiListItem` 可在 S5 前先行），S7 依赖 S6+S5。

**中断安全**：任一步中断都不会产生「半迁移」—— S3 的迁移是单函数幂等；S8 受开关门控。

---

## §11 风险与回滚

### 11.1 风险清单

| # | 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | 考试字段形状猜错（C.1/C.5/C.6） | 真实响应与 §2 不符 | 时间解析为 null → 考试全部无提醒（静默失效，比报错危险） | 容器/字段强校验：任何一项不符合 → `parse_error` + `warnings` + UI「考试同步失败」（**默认已开启，故这条强校验是最后防线**）；用户可手动关闭开关 |
| R2 | 时间类型误判（毫秒 vs 字符串） | C.6 假设错了 | 同上 | `parseExamTime` 双格式探测 + 秒级阈值保护 + 解析失败计 warning（§4.5） |
| R3 | 场次爆炸 | 一场考试 N 个场次、25 门课 | 列表过长、提醒过多 | 每场次一条但 UI 按考试聚合展示可选；提醒去重按场次键；设 `maxCourses`（40）与每课程 `ps=20` |
| R4 | 请求量上升 | 逐课程 × 2 分支 | 同步变慢、对学校平台压力 | 串行 + `RateLimiter`；`checkSession` 前置；C.11 后换批量接口；**默认已开启**，故请求量是常态，须监控同步耗时 |
| R5 | 提醒键冲突复发 | 未来有人改回 `sourceAssignmentId` | 作业与考试互相吃提醒 | 新增单测断言「作业键前缀与考试键前缀不互相匹配」+ ADR-011 记录 |
| R6 | 缓存被误清 | 有人把考试写入 `assignments.*` | 违反红线「失败不得清空缓存」 | 拆键（§7.2）+ per-kind 测试（§9.2）+ 代码评审检查点 |
| R7 | 迁移写坏用户数据 | v2→v3 逻辑缺陷 | 用户 121 条作业缓存丢失 | 纯追加迁移、不清 `reminders`、幂等、迁移前 `store.path` 备份（诊断导出已含路径）；S3 门槛要求用真实 store 副本验证 |
| R8 | UI 出现「未参加」 | 有人复用平台词表 `nls_exam.js:58` | 违反红线 3 | `ExamItem` 类型上根本没有该字段（物理不可写）+ 文案断言测试 |
| R9 | 已开考考试被默认隐藏 | 有人把开始时间塞进 `dueAt` | 考试中列表为空 | `isExpired` 按 kind 分支（§8.5）+ 专项测试 |
| R10 | 静默时段吞掉开考提醒 | 考试阈值 `urgent` 配置错误 | 错过考试 | 开考瞬间强制 urgent + 静默时段弹窗测试 |
| R11 | 通知文案错写成作业 | `reminderText`/`toItem` 未分支 | 用户看到「作业即将截止」 | 两处强制按 `kind` 分支 + 文案单测 |

### 11.2 同步开关

| 开关 | 默认 | 作用 |
|---|---|---|
| `settings.examSyncEnabled` | **true**（用户 2026-11-11 决策） | 关闭时：不发考试请求、不清既有缓存；开启时若失败，UI 必须显示「考试同步失败」，**不得**渲染成「0 场考试」 |
| 环境变量 `DGUT_EXAM_E2E=1` | 未设置 | 仅 e2e 脚本用，允许用合成夹具渲染考试行 |

> **默认开启的代价**：每次同步会多打 ≤50 次 GET（逐课程 × 两条分支回退）。
> 已用 `RateLimiter` 串行 + 最小间隔约束；若学校平台出现压力迹象，应把默认值改回 `false` 并提示用户手动开启。
> 该默认值是**用户明确要求**的产品决策，不是工程默认。

### 11.3 回滚

1. **代码回滚**：`git revert` 对应提交即可 —— schema v3 是**纯追加**（新增 `exams`/`lastSuccessByKind`/`settings.examThresholds`），v2 代码读 v3 store 时会忽略未知键（electron-store 保留未知键），**不需要**降级迁移。
2. **数据回滚**：`exams.*` 可整体删除（不影响作业）；`reminders` 中考试键（`ulearning:exam:` 前缀）可一次性过滤掉，作业 9 条记录不受影响。
3. **功能回滚**：把 `examSyncEnabled` 置 false（用户在设置里取消勾选即可），
   或把 `DEFAULT_SETTINGS.examSyncEnabled` 改回 `false` 并新增一次 schema 迁移。
   注意：仅改默认值**不会**影响已保存该字段的用户——他们机器上已有明确值，迁移不会覆盖（已用测试守住）。
4. **不可回滚项**：一旦 S9 更新了 `AGENTS.md`/ADR，需同步再改一次文档（无技术风险）。

---

## §12 待用户确认的 3 个产品决策

> 这三项**不能由工程侧拍板** —— 都会改变用户可见行为。在其确定前，S1–S7 可按「作业行为完全不变、考试行为取最保守默认」推进；S8/S9 的 UI 默认值必须等答复。

### D1 —— 考试提醒锚点

- **A) 只提醒开始**：开考前 1 天 / 2 小时 / 30 分钟（+ 开考瞬间）。
  - 优点：噪音最低，覆盖「别错过开考」这一核心诉求；实现最简（只 `startsAt` 一条链）。
  - 缺点：不提醒结束，用户需自己盯结束时间。
- **B) 开始 + 结束都提醒**：A 的全部 + 结束前 30 分钟 / 结束时刻。
  - 优点：完整覆盖一场考试的两端；对「考试有时间上限」类课程更安全。
  - 缺点：单场考试最多 5–6 条提醒，可能被认为是打扰。
- **C) 只提醒开始，但临近结束补一条**：A 的全部 + 结束前 30 分钟一条「考试即将结束」。
  - 优点：折中，只多一条且是高价值提醒；噪音可控。
  - 缺点：需要 `endsAt` 可靠（当前未验证），`endsAt` 缺失时该条静默消失（需在设置页注明）。

（工程默认倾向：C；`examThresholds` 已按 `anchor: 'start' | 'end'` 设计，三种选项都只需改默认配置，无需改代码结构。）

### D2 —— 考试与作业是否混在一个列表

- **A) 混排**：按时间统一排序，加类型列/徽标。
  - 优点：只看一个列表，最贴近「今天我要做什么」；实现最省（复用现有表格 + 一列）。
  - 缺点：考试与作业的时间语义不同（开考 vs 截止），混排时「剩余时间」列需要两套文案。
- **B) 分 Tab**：作业 / 考试 两个 Tab。
  - 优点：语义清晰，筛选器可按 Tab 简化；「考试」Tab 可以做日历视图。
  - 缺点：用户可能忘记切 Tab 而漏看考试；顶部统计卡片要按 Tab 切换。
- **C) 混排但考试置顶**：先考试（按开考时间）后作业（按截止时间）。
  - 优点：考试优先级显式表达；仍是一个列表。
  - 缺点：置顶会打断「最近截止优先」的既有默认排序（用户当初明确要求「截止最近排最前」）。

（工程默认倾向：A + 类型徽标；若选 B，S7 需增加 Tab 组件与按 Tab 的筛选上下文。）

### D3 —— 考试默认是否参与「隐藏已截止」

- **A) 考试按 `endsAt` 判定过期**：正在进行（已开考未结束）的考试**不隐藏**，结束后隐藏。
  - 优点：符合直觉，且与「默认只看未截止」的既有默认一致；实现即 §8.5 的 `isExpired`。
  - 缺点：`endsAt` 缺失时只能退化用 `startsAt` 判过期（会提前隐藏，需提示）。
- **B) 考试永远显示，直到 `endsAt` 过去**：等价于 A 但额外要求「结束后仍保留一段时间（如 24h）以便回看」。
  - 优点：考完还能回看考场/座位；减少「列表突然空了」的困惑。
  - 缺点：与「隐藏已截止」开关的语义有冲突，需要额外解释（或新增「保留已结束考试 N 天」）。
- **C) 单独一个「考试」筛选开关**：`hideExpired` 只管作业，考试由独立开关 `hideEndedExams` 控制。
  - 优点：两套时间语义彻底解耦，用户可自由组合；最不容易误伤。
  - 缺点：筛选栏多一个开关（现有 6 个控件已较密），UI 复杂度上升。

（工程默认倾向：A + 「已结束考试保留 24h」作为 A/B 之间的软折中，可在设置页做成数字项。）

### D4 —— ~~如何避免「同一场考试被作业流和考试流各提醒一次」~~ **已作废（2026-11-11）**

**用户决策**：「在作业模块出现的不管叫什么都算作作业 tab，在考试模块出现的不管叫什么都算作考试 tab」「不会出现重复」。

⇒ 分类标准 = **数据来源模块**，不按标题内容推断。本节原有 A/B/C 三选项全部不需要，此决策点**关闭**。详见 §4.7。

### D2 补充说明（2026-11-11 用户决策）

用户在 D2 同时选了 A 与 B，并补充口径：**「在作业模块出现的不管叫什么都算作作业 tab，在考试模块出现的不管叫什么都算作考试 tab」**。

落地含义：`kind` 由**接口来源**决定，不由标题决定；Tab 即 `kind` 的视图。因此 D2 按 **A+B 合并**实现 —— 默认「全部」Tab 混排（按锚点时间排序、带类型徽标），另提供「作业」「考试」两个 Tab 仅作筛选。这样既保留「截止最近优先」的既有默认，又能干净分流。

### D3 已确认（2026-11-11）

采纳 §8.5 的 `isExpired` 按 kind 分支：考试以 `endsAt` 判定过期（**进行中的考试不会被默认隐藏**），已结束考试保留 24h 便于回看（设置页可调）。

---

## 附：本文的引用索引

| 引用 | 位置 |
|---|---|
| 实测证据表 | `investigation/lms/exam-evidence.md` §A（`:17-169`） |
| 代码证据表 | 同上 §B（`:173-375`）；`investigation/lms/Exam.js:150,171,1786`、`module_course_exam_examController.js:64-76,108-135,172-178,297-325`、`module_course_exam_exam.html:249-280`、`exam_gradeController.js:76-102,168-175`、`config.js:131-219` |
| 未知清单 | 同上 §C（`:379-394`） |
| 提醒现状 | `src/main/reminder/planner.ts:62-64,84-136,164-190`；`scheduler.ts:98-179`；`toast-manager.ts:122-149` |
| 阈值现状 | `src/shared/thresholds.ts:9-36,50-71`（`Math.round` 在 `:59`） |
| 同步现状 | `src/main/sync/sync-engine.ts:15-24,55-61,82-190`（`warnings: []` 在 `:150`） |
| 存储现状 | `src/main/store/app-store.ts:17,67-80,119-156,177-189,200-225` |
| 筛选现状 | `src/renderer/src/logic/filter.ts:33-61,67-70,97-140,213-224` |
| 快照/IPC 现状 | `src/main/ipc/snapshot.ts:25-70`；`src/shared/ipc.ts:12-58` |
| 模型现状 | `packages/shared/src/model/assignment.ts:19-22,36-70,72-74,80-92,94-107`；`sync.ts:36-64` |
