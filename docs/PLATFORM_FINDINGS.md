# 平台调研记录（PLATFORM_FINDINGS）

> 只记录**实测验证**的事实与**明确未知项**。未经验证的一律标注「未验证」，代码中不得当作事实使用。
>
> 采集环境：Windows 11 x64 · Microsoft Edge 156.0.4314.58 · Node 24.11.1 · Electron 38.8.6
> 采集时间：2026-11-04（初次探明）、2026-11-08（真机登录验证）

---

## 0. 结论速览

| 平台 | 可达性 | 登录方式 | 数据接口 | 是否"已接通" |
|---|---|---|---|---|
| 莞工作业平台<br>`hw.dgut.edu.cn` | ✅ 可达 | 中央认证 CAS OAuth2（wisedu） | `/api/student/*` REST | ✅ **已接通**，真实读取 20 条 |
| 优学院 LMS<br>`lms.dgut.edu.cn` | ✅ 可达 | 中央认证（service 须指向应用中心） | `/courseapi/*` REST | ✅ **已接通**，真实读取 121 条 |

> **2026-11-08 里程碑：两个平台均已完成真实只读接入。**
> 合计读取 **141 条真实作业**（LMS 121 + hw 20），其中 8 条未完成、
> 2 条在 72 小时内截止（经核实为真实作业）。

---

## 1. 网络与可达性实测

### DNS
```
lms.dgut.edu.cn        -> 27.39.220.17
hw.dgut.edu.cn         -> 27.39.220.17
dgut.edu.cn            -> 27.39.220.1, 219.222.191.1
auth.dgut.edu.cn       -> 120.197.170.63      （wisedu 中央认证）
cas.dgut.edu.cn        -> 27.39.220.17        （DPtech 网关）
application.dgut.edu.cn-> 应用中心（融合门户）
homework.dgut.edu.cn   -> 27.39.220.17        （作业子系统，对外 404）
```

### 端口
| 目标 | 443 | 80 |
|---|---|---|
| lms.dgut.edu.cn | ✅ | ✅ |
| hw.dgut.edu.cn | ✅ | ✅ |

### 重要环境事实
- 本机设有系统级 HTTP 代理 `127.0.0.1:7890`；**直连（`--noproxy`）同样可访问**，说明当前两平台不强依赖校园网。
- 但 `homework.dgut.edu.cn` / `homeworkapi.dgut.edu.cn` / `courseapi.dgut.edu.cn` 对外一律 302 → `nic.dgut.edu.cn/ymwzd404.htm`，属网关层拦截。**未验证**这些子域在登录态下是否可用。

---

## 2. 莞工作业平台（hw）—— ✅ 已接通

### 2.1 登录方式（实测提取自前端 bundle）

| 方式 | 地址 | 状态 |
|---|---|---|
| **中央认证 OAuth2** | `https://auth.dgut.edu.cn/authserver/oauth2.0/authorize?response_type=code&client_id=971734811307233280&redirect_uri=https%3A%2F%2Fhw.dgut.edu.cn%2Fnewlogin` | ✅ 302 → wisedu 登录页 |
| CAS 旧入口 | `https://cas.dgut.edu.cn/?appid=hwcss` | ❌ 已废弃，跳 404 |
| 站内账号登录 | `POST /api/login` body `{userName, password}` | ⚠️ 密码需前端加盐加密；明文 POST 返回「登陆失败，系统无此用户」 |

**工程结论**：必须由用户在受控 Edge 中手工完成中央认证登录。应用不代填密码、不绕过验证码。

### 2.2 会话机制（架构决定性实测）
- Cookie：`server_session_0910b76b`、`SESSION`、`XSRF-TOKEN`
- **浏览器进程关闭后会话即失效**（再次访问 302 → `/login`）。因此：
  1. 应用必须长驻持有浏览器实例；
  2. 需用 `storageState` 落盘并在重启后尝试恢复；
  3. 恢复失败必须提示重新登录。

### 2.3 已验证接口（全部为页面自身发出的 GET）

| 接口 | 用途 |
|---|---|
| `GET /api/user/profile` | 当前用户；`data.userType` ∈ `student`/`teacher`/`admin` |
| `GET /api/config` | 学期配置 `{startTime, xn, xq, isCourseSync}`，实测 `xn=2026, xq=0` |
| `GET /api/student/term` | `{startXn, endXn, endXq}` |
| `GET /api/student/course` | 课程列表 |
| `GET /api/student/plan?size&page&sort=create_time,desc` | **作业计划（含未提交 + submitted 标记）** |
| `GET /api/student/homework?size&page&sort=uploadDate,desc` | **已上传作业记录** |

包络：`{ code, msg, data }`
**未登录：`{"code":-11,"msg":"unauthorized"}`，但 HTTP 状态仍是 200** —— 只判 HTTP 会误判成功。

### 2.4 分页容器（实测，推翻了早期假设）
```json
{ "code": 0, "msg": "成功", "data": { "total": 15, "data": [ ... ] } }
```
注意是 `data.data`，不是 `data.content`。

### 2.5 字段语义（**实测确认，修正了早期错误假设**）

| 字段 | 实测语义 |
|---|---|
| `deadline` | **boolean**，表示"是否设置截止时间"（实测恒 true）**不是时间字符串** |
| `deadlineDate` | **string `"YYYY-MM-DD HH:mm"`**，真实截止时间，**含时间部分** |
| `submitted` | **boolean**，仅 `/student/plan` 返回 |
| `homeworkId` | 未提交为 `null`，已提交为数字（上传记录 ID） |
| `markedStatus` | `"marked"` \| `"unmarked"` \| `null` |
| `entityStatus` | `"Enabled"` |
| `checkStatus` | `"Disable"` \| `"Enabled"`（查重开关，与提交无关） |
| `completeWay` | `"single"`（个人）/ 其它为分组 |
| `scoreType` | `"hundredMark"`（百分制） |
| `homeworkType` | `"平时考核-平时作业"` / `"平时考核-实验报告"` / `"平时考核-期中考试"` |
| `xn` / `xq` | 学年 / 学期（实测 `2026` / `0`） |

### 2.6 去重键（实测依据）
两接口主键不同：
- `/student/plan` → `id` 是**作业计划 ID**
- `/student/homework` → `id` 是**上传记录 ID**，`homeworkPlanId` 才指向 plan 的 `id`

**统一用 plan 侧 `id`** 作为 stable key，两接口即可合流。

### 2.7 真实数据验证结果（2026-11-08）

用真实采集数据跑归一化，得到 **14 条作业**：

| 指标 | 数量 |
|---|---|
| 总作业数 | 14 |
| 已提交 | 10 |
| 未提交 | 4 |
| 状态 unknown | **0** |
| 无截止时间 | **0** |

4 条未提交作业（真实）：
| 作业 | 课程 | 截止 |
|---|---|---|
| 实验5 | 面向对象程序设计(Java) | 2026-11-13 00:00 |
| 实验二 SQL查询实验 | 数据库系统原理 | 2026-11-21 23:00 |
| 作业三 SQL语言 | 数据库系统原理 | 2026-11-22 23:00 |
| 实验二_基于神经网络的图像分类 | 人工智能A | 2026-11-28 23:59 |

✅ 中文标题、课程名、截止时间、提交状态全部正确解析，无乱码、无状态误判。

### 2.8 仍待人工核对
- ❓ 分组作业（`completeWay != 'single'`）下 `submitted` 的语义
- ❓ `deadline=false`（未设截止）时的真实表现
- ❓ 跨学期（`xn`/`xq`）是否需要显式参数过滤
- ❓ 作业详情页的精确 URL 模式（当前统一跳 `#/student/homeworkPlan`）

---

## 3. 优学院 LMS —— ✅ 已接通（真实读取 121 条作业）

### 3.1 技术形态（实测）
- 入口：`https://lms.dgut.edu.cn/courseweb/ulearning/index.html`
- **不是** Vue/React SPA，而是 **require.js + knockout.js + jQuery** 的传统模块化应用
- 入口脚本链：`index.html` → `common/js/config.js` → `init.js` → `mainController.js`

### 3.2 🔑 鉴权：需要 `Authorization` **请求头**，不是仅靠 cookie

这是打通 LMS 的关键发现。

`init.js` 中：
```js
window.Authorization = getCookie("AUTHORIZATION");
$.ajaxSetup({
  beforeSend: function (xhr, info) {
    xhr.setRequestHeader("Authorization", Authorization);
    xhr.setRequestHeader("version", 1);
  },
});
```

**实测对比**（同一登录态，请求 `/courseapi/courses/students`）：

| 方式 | 结果 |
|---|---|
| 只带 cookie（`credentials:'include'`） | ❌ 401 `{"code":2001,"message":"缺少访问token"}` |
| 带 `Authorization` + `version: 1` 头 | ✅ **200，返回 25 门课程** |

> 这是之前一直判定"未登录"的根本原因——不是没登录，而是请求方式不对。

### 3.3 🔑 登录链路：CAS 的 `service` 必须指向**应用中心**

> **2026-11-11 更新（旧结论已修正，见 §3.9）**：本节表格中「LMS 自家登录页 `/sld/pc.html#/login`
> 返回 404」是**永久下线**而非临时故障；且「带 token 跳转」的参数名是 **`token`** 且必须在 **hash** 里，
> 不是 `AUTHORIZATION`。以 §3.9 为准。

社区逆向资料（[博客园](https://www.cnblogs.com/resea/p/20135197)、
[Greasy Fork](https://greasyfork.org/zh-CN/scripts/561583)）与实测共同确认：

**认证中心只信任来自应用中心 `application.dgut.edu.cn` 的请求。**

| 做法 | 结果 |
|---|---|
| CAS `service` 指向 LMS | ❌ 被跳回门户，`AUTHORIZATION` 不写入 LMS |
| LMS 自家登录页 `/sld/pc.html#/login` | ❌ **HTTP 404**（永久下线，见 §3.9） |
| **CAS `service` 指向应用中心** | ✅ 拿到 `.dgut.edu.cn` 域下的 `AUTHORIZATION`(32位) + `token` |

正确入口：
```
https://auth.dgut.edu.cn/authserver/login
  ?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas
```

### 3.4 已验证接口（全部实测）

| 接口 | 说明 | 实测结果 |
|---|---|---|
| `GET /courseapi/courses/students?pn&ps&lang=zh` | 学生课程列表 | ✅ `{pn,ps,total:25,courseList:[...]}` |
| `GET /courseapi/homeworks/student/v2?ocId=&pn&ps&lang=zh` | **某课程作业列表** | ✅ `{pn,ps,total,homeworkList:[...]}` |
| `GET /courseapi/users/login/refresh10Session?uaToken=…` | 会话续期 | ✅ |
| `GET /courseapi/homepage/*` | 首页数据 | ✅ |

**⚠️ 两个关键参数陷阱**：
1. 作业接口的参数名是 **`ocId`**（不是 `courseId`）——用错返回 **400**
2. 课程接口的 `ps=1` 会让服务端抛 **NPE（500）**——必须用 `ps>=15`

### 3.5 作业字段语义（实测）

```json
{
  "id": 500750,
  "type": 9,
  "homeworkTitle": "《大学生职业生涯规划》(26-27-1)期末考试",
  "startTime": 1793705220000,
  "endTime": 1798646400000,
  "state": 0,
  "timeStatus": "2",
  "status": 2,
  "publisher": "[发布者姓名已脱敏]",
  "showLevel": 0,
  "personStatus": 1
}
```

| 字段 | 含义 | 观测取值 |
|---|---|---|
| `id` | 作业 ID（稳定键） | 数字 |
| `homeworkTitle` | 标题 | 字符串 |
| `startTime` | 开始时间 | 毫秒时间戳 |
| `endTime` | **截止时间** | 毫秒时间戳 |
| `status` | 提交状态 | `2` 未完成 / `3` 已完成 |
| `personStatus` | 个人状态 | `1` / `2`（2 = 已完成）|
| `timeStatus` | 时间状态 | `"2"` 未过期 / `"3"` 已过期 |
| `type` | 作业类型 | `3` / `8` / `9`（含义待确认）|
| `publisher` | 发布教师 | 字符串 |

**保守判定**：只有 `status === 3` 或 `personStatus === 2` 才判为已提交；
`status === 2` 判为未提交；其余取值一律 `unknown` 并记录原始值。

### 3.6 真实数据验证结果

| 指标 | 值 |
|---|---|
| 课程总数 | 25 |
| 有作业的课程 | 16 |
| 读取到的作业总数 | **121 条** |
| 状态判定 | 全部带 `statusEvidence`（如 `status=3 personStatus=1`）|
| 时间解析 | 全部转为 `+08:00` ISO，0 条失败 |

### 3.7 已修复的埋点（重要教训）

| 问题 | 现象 | 修复 |
|---|---|---|
| 缺 `Authorization` 头 | 401「缺少访问token」 | 从 cookie 读值注入请求头 + `version:1` |
| 作业接口用 `courseId` | 400 | 改用 **`ocId`** |
| 课程接口 `ps=1` | 500 NPE | 改用 `ps=15` |
| `getPage()` 总返回 pages[0] | 登录了却读空白页 | 优先复用目标域页面 |

### 3.8 仍待确认（不影响当前可用性）
- `type` 字段（3/8/9）的精确含义
- 小组作业的提交状态语义
- `homework.dgut.edu.cn` 独立子系统（当前对外 404，但主站 `/courseapi/homeworks/` 已可读，无需它）

### 3.9 🔴 2026-11-11 登录跳转修复（**本节纠正了 §3.3 的旧结论**）

用户报告两个 bug：点「立即同步」→ 受控 Edge 停在 LMS 课程列表并显示
「网络错误，点击重新加载」；点「登录」→ 打开 `/sld/pc.html#/login` 得到 nginx 404。

#### 实测证据（2026-11-11，校内网络）

| 探测项 | 结果 |
|---|---|
| `GET /sld/pc.html` | **404**（nginx，永久下线） |
| `GET /courseweb/ulearning/index.html` | 200 |
| `GET /ulearning/tip/timeout.html` | 200（LMS **官方**的会话失效页） |
| `GET /courseapi/users/isValidToken/<假token>` | 200，裸响应 `false`（可做无副作用探活） |
| `GET /organization/index.html` | 301 → `https://application.dgut.edu.cn/#/portal` |
| `GET /courseapi/courses/students`（无 token） | 401 |

#### 根因一：「登录」指向了已下线的页面（图2）

`/sld/pc.html#/login` 是 LMS 自带的登录按钮目标，该目录**已整站下线**。
LMS 自己遇到 401 时的跳转是 `timeout.html` → `/` → 应用中心（实测导航轨迹）：
```
index.html#/index/courseList
  → /ulearning/tip/timeout.html
  → /
  → https://application.dgut.edu.cn/#/portal
```
⇒ **唯一可用的登录入口是应用中心** `https://application.dgut.edu.cn/#/login`
（实测含「校园统一身份认证登录」按钮）。

#### 根因二：免密参数名/位置写错了（图1）

`init.js` 开头：
```js
var token = getHashParam("token");
if (token) { setCookie("AUTHORIZATION", token, null, "/", UMOOC_COOKIE_DOMAIN); }
```
`getHashParam` 只读 `location.hash`，正则 `(^|\?|&)token=([^(&|/)]*)(&|/|$)`。
全 LMS 核心 JS 中 `getHashParam("AUTHORIZATION")` / `getUrlParam("AUTHORIZATION")` 命中 **0 次**。

旧实现写的是 `` `${LMS_HOME}?AUTHORIZATION=...` `` —— 参数名错 + 位置错，**前端完全不读**，
等于没传 token。于是 `checkSession` 的 `init.js` `judgeToken()` 判无效 → logout → 弹回应用中心，
课程列表请求失败 → 渲染「网络错误，点击重新加载」。

| 写法 | 前端是否落成 AUTHORIZATION cookie |
|---|---|
| `#/index/courseList?token=xxx`（hash + `token`） | ✅ 是（实测桩验证） |
| `?token=xxx`（查询串） | ❌ 否 |
| `#/index/courseList?AUTHORIZATION=xxx`（旧代码） | ❌ 否 |

#### 根因三：Cookie 是域级共享的

应用中心前端以 `Domain=.dgut.edu.cn` 写 `AUTHORIZATION` / `USER_INFO`，
lms / auth / application 同域共享。CAS 回跳 `appapi/cas/fromcas` 后
**必须让应用中心前端真正渲染一次**才会写 cookie；不等它落地就跳 LMS，就还是未登录态。

#### 「网络错误」不是断网

该文案来自 `courseweb/common/nls/public.js` 的 `netError`，是 `/courseapi/*`
拿不到有效 token 时课程列表渲染的兜底 UI。识别特征：页面同时含「网络错误」与「重新加载」。
⇒ 必须归类为 `needs_login`，**不能**报成 `network_blocked`。

#### 落地修复（`src/main/sources/ulearning-source.ts`）

1. 登录入口改为应用中心；**任何情况下都不再导航到 `/sld/`**（`resolveLmsLoginTarget()` 有单测）。
2. 停在 LMS 坏页面时**主动把窗口带走**到应用中心（旧实现只提示"点右上角登录"，而那个按钮正是 404）。
3. 免密 URL 改为 hash 里的 `token`（`buildLmsTokenUrl()` 有单测）。
4. 「网络错误」页识别为登录失效（`detectNetworkError()`）。
5. 无 CAS 票据时**不再空等 90 秒**（原来点登录会卡住 94 秒），改为立即返回。
6. `app:login` 现在会把 `connect()` 结果写回 store —— 否则 UI 状态永远不刷新。

验证脚本：`node scripts/lms-login-fix-e2e.mjs`（真实 Electron + 真实受控 Edge）。

### 3.10 🟢 2026-11-13 优学院考试接口与交卷状态实测验证

通过 `node scripts/probe-lms-exam.mjs --profile <副本>` 在真实登录态下验证了 6 门课程（18 场考试）：

| 接口 | 状态码 | 实测结论 |
|---|---|---|
| `GET /utestapi/exams/student?ocId=<ocId>&pn=1&ps=20&lang=zh` | **200** | ✅ 新分支生效，返回 `{ pn, ps, total, examList: [...] }` |
| `GET /courseapi/exams/student?ocId=<ocId>&keyword=&pn=1&ps=20&lang=zh` | **400** | ❌ 旧分支在 DGUT 已将 `student` 当成 `{examId}` 转型抛 400 |
| `GET /utestapi/exams/{id}/score` | **400** | 教师端接口（要求 `examStatus` 参数） |
| `GET /utestapi/exams/{id}/result` | **500** | 服务端 `NullPointerException`，学生端不可用 |

#### 考试行真实字段与个人交卷状态（脱敏样本：`examId=146063`《3. 组合逻辑电路》）

```json
{
  "examId": 146063,
  "title": "3. 组合逻辑电路",
  "answerTimes": 1,
  "limitTimes": 2,
  "isLimitTimes": "1",
  "subjective": 30,
  "objective": 30,
  "examTime": 180,
  "examState": 2,
  "examType": 5,
  "isInExam": 1,
  "showExamRecord": 1,
  "showExamRecodAfterDate": 888,
  "examFinish": "1;3",
  "allExamBatchEnd": 0,
  "examRelationTimeList": [
    { "startTime": 1793286240000, "endTime": 1793973600000, "examRoomName": null, "seatNo": null },
    { "startTime": 1794321420000, "endTime": 1794578400000, "examRoomName": null, "seatNo": null }
  ]
}
```

| 字段 | 实测类型与取值 | 语义（对照 `utest` 与 `nls/exam.js`） |
|---|---|---|
| `answerTimes` | `number`（实测 `0`, `1`, `2`） | **已用提交次数**（`usedTimesNew: "已用提交次数"`）：`0` = 未交卷，`>= 1` = 已交卷 |
| `limitTimes` + `isLimitTimes` | `number` + `"0" \| "1"` | **允许提交次数**（`isLimitTimes="0"` 或 `limitTimes=0` 表示不限次数） |
| `subjective` / `objective` | `number \| null` | 主观题 / 客观题得分；未交卷时恒为 `null`，已交卷时可求和为总分 |
| `examState` | `1` / `2` / `3` | 考试级状态（未开始 / 进行中 / 已结束），不代表个人是否交卷 |
| `examRelationTimeList[]` | `{ startTime, endTime, examRoomName, seatNo }[]` | 场次毫秒时间戳列表 |

**判定规则（已落地 `resolveExamAttendance()`）**：
- `answerTimes >= 1` ⇒ `attendance = 'submitted'`（显示「已交卷 X/Y」或「已交卷 X次」，悬停显示得分，并抑制后续考试提醒）；
- `answerTimes === 0` ⇒ `attendance = 'not_submitted'`（显示「未交卷 0/Y」或「未交卷」）；
- `answerTimes` 缺失或非有效非负数值 ⇒ 保守回退 `attendance = 'unknown'`（显示「参加状态未知」）。


---

## 4. 对架构的影响（已落实到代码）

1. **长驻浏览器会话**（`src/main/browser/session.ts`）
   `launchPersistentContext` + `channel:'msedge'`，`userDataDir` 位于 `app.getPath('userData')/browser-profile`。

2. **同源 fetch 读取，不导出 Cookie**
   在页面上下文内 `fetch(path, {credentials:'include'})`，不落盘、不打日志任何凭证。

3. **业务 code 与 HTTP 状态双判**（hw 特有：未登录仍返回 200）

4. **维护页识别**（LMS：503 或公告特征 → `platform_maintenance`）

5. **失败保留缓存**（`SyncEngine` 失败只更新 `sessions`，不动 `assignments`）

6. **LMS 适配器诚实降级**
   `UlearningAssignmentSource.listAssignments()` 在拿到课程后会抛 `UnverifiedEndpointError`，
   明确表示"接口未验证，不返回伪造数据"，而不是返回空数组。

7. **LMS 登录只有一条可行链路**（2026-11-11 修复，见 §3.9）
   `应用中心(#/login) → CAS → 应用中心(渲染落 cookie, Domain=.dgut.edu.cn) → LMS(hash ?token=)`。
   `/sld/pc.html` 已永久 404，**代码中不得再出现该路径作为导航目标**
   （`resolveLmsLoginTarget()` 单测会拦住）。

---

## 5. 待用户人工完成的操作

| # | 操作 | 目的 | 状态 |
|---|---|---|---|
| 1 | 受控 Edge 登录 hw（中央认证） | 采集真实作业 | ✅ 已完成 |
| 2 | 目视核对 hw 作业截止时间与提交状态 | 验证归一化 | ⏳ 待确认 |
| 3 | 登录 LMS 并进入作业板块 | 拿到 LMS 作业接口 | ⏳ 待完成 |
| 4 | 如 LMS 需校园网/VPN，连接后重试 | 排除网络拦截 | ⏳ 视情况 |
