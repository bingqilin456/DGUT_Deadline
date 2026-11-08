# 产品需求（PRD）

## 1. 目标用户

东莞理工学院在读学生。典型场景：同时在优学院 LMS 与学院作业管理平台上有多门课程的作业，
截止时间分散，容易漏交。

## 2. 核心价值

把分散在两个学校平台的作业截止信息聚合到一个本地桌面应用里，**提前提醒**，避免漏交。

## 3. 功能范围

### 3.1 必须做（P0）

| 编号 | 功能 | 验收标准 |
|---|---|---|
| F1 | 双平台独立连接状态 | 每个平台单独显示"已连接/需登录/网络不可达/维护中/异常"，互不影响 |
| F2 | 首次人工登录 | 点击登录弹出受控 Edge 窗口，用户手工完成认证；应用不接触密码 |
| F3 | 会话失效提示与重连 | 会话过期时明确提示"需重新登录"，不静默失败 |
| F4 | 手动刷新 + 定时同步 | 支持"立即同步"按钮与可配置间隔（0 = 关闭） |
| F5 | 作业列表 | 显示来源、课程、标题、截止时间、剩余时间、提交状态、跳转按钮 |
| F6 | 按截止时间升序 | 无截止时间的排在末尾并标注 |
| F7 | 截止前提醒 | 默认 72h / 24h / 3h，可自定义 |
| F8 | 提醒去重 | 同一作业同一阈值只提醒一次；已提交不提醒；改期后重新计算 |
| F9 | 离线缓存 + 过期提示 | 同步失败时保留旧数据并标注"数据可能过期"，**不得显示成"没有作业"** |
| F10 | 托盘驻留 | 关闭窗口最小化到托盘；真正退出走托盘菜单 |
| F11 | Windows 通知 | 截止提醒以系统通知弹出，点击可定位到应用内条目 |
| F12 | 开机自启（可选） | 默认关闭，可在设置中开启 |

### 3.2 明确不做（非目标）

- ❌ 自动答题、自动提交、自动上传
- ❌ 修改学校系统任何数据
- ❌ 绕过验证码 / MFA / VPN / 登录限制
- ❌ 读取用户日常浏览器的 Cookie
- ❌ 接入 AI、云数据库、服务器、遥测
- ❌ 收集、上传任何个人数据

## 4. 数据模型

```ts
Assignment {
  source: 'ulearning' | 'hw'
  sourceAssignmentId: string      // 平台内稳定键
  id: string                      // `${source}:${sourceAssignmentId}`
  courseId: string | null
  courseName: string | null
  title: string
  detailUrl: string | null        // 必须过 allowlist
  dueAt: string | null            // ISO8601 带 +08:00
  duePrecision: 'datetime' | 'date' | 'none'
  submissionStatus: 'not_submitted' | 'submitted' | 'overdue' | 'unknown'
  statusEvidence: string          // 判定依据，不含凭证
  firstSeenAt / lastSeenAt / lastSyncAt / sourceUpdatedAt
  manuallyOverridden?: { field, at }
}
```

**关键规则**：
- 平台只给日期不给时间时，`duePrecision='date'`，**不补 23:59**。
- 无法确定截止时间时 `dueAt=null, duePrecision='none'`，UI 显示"待确认"，绝不猜测。
- 只有平台**明确**显示未提交才是 `not_submitted`；其余为 `unknown`。
- 用户手动改过的值必须标注"已手动修正"，不能伪装成平台原值。

## 5. 提醒规则

1. 已提交 → 不提醒。
2. 无截止时间 → 不参与阈值提醒（无法在未知时间上推算）。
3. `duePrecision='date'` → 只对 ≥24h 的阈值提醒，跳过 3h 阈值（不知具体时刻）。
4. 幂等键：`${source}:${sourceAssignmentId}:${dueAt}:${thresholdHours}`。
   包含 `dueAt`，所以改期后旧键自然失效。
5. `unknown` 状态 → 提醒文案为"请核对作业状态"，**不写"你还没交"**。
6. 休眠/断网恢复后补偿提醒，但过期超过 24h 的不再补发，避免通知轰炸。
7. 静默时段内不弹通知（支持跨零点）。

## 6. 界面要求

- 中文、简约、清爽、紧凑，浅色为主，支持深色模式。
- 支持 100% / 125% / 150% 显示缩放，窗口可缩放。
- 主界面：顶部同步状态 + 三个统计卡片 + 作业表格。
- 必须有：空状态、加载状态、异常状态、长标题省略 + tooltip、键盘可达。
- 演示数据必须带「演示」标识。

## 7. 非功能需求

| 项 | 要求 |
|---|---|
| 启动时间 | 冷启动 < 5s |
| 内存 | 空闲 < 300MB（不含浏览器实例） |
| 安全 | contextIsolation + sandbox + nodeIntegration:false + CSP + URL allowlist |
| 隐私 | 无遥测；诊断导出脱敏 |
| 网络 | 温和采集，请求频率受限，超时与退避 |
| 可维护性 | 平台改版时只改对应适配器，故障隔离 |
