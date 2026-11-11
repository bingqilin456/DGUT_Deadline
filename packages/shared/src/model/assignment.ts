/**
 * 莞工 Deadline —— 列表实体领域模型（平台无关的归一化层）
 *
 * 两种实体（用户 2026-11-11 决策）：
 *   - 作业：来自平台「作业」模块（hw `/api/student/plan`、LMS `/courseapi/homeworks/student/v2`）
 *   - 考试：来自平台「考试」模块（LMS `/courseapi|utestapi/exams/student`）
 *   **分类依据是接口来源，不是标题内容**。叫「期末考试」但来自作业接口的条目，就是作业。
 *
 * 设计原则（见 docs/PLATFORM_FINDINGS.md）：
 *  1. 任何字段无法从平台证据中确定时，一律保留 `unknown`/`null`，绝不猜测默认值。
 *  2. 作业 `dueAt` 必须带时区偏移；平台只给日期不给时间时，不得补 23:59，改为 dueAt=null + duePrecision='date'。
 *  3. 考试用独立 `startsAt`/`endsAt`，**不复用 dueAt**：`dueAt` 是「截止」，考试锚点是「开考」，
 *     复用会让已开考未结束的考试被「隐藏已截止」默认过滤掉（用户正在考试，列表里反而没了）。
 *  4. 考试没有「提交状态」这个概念，因此 `ExamItem` 上**物理上不存在** submissionStatus 字段，
 *     `attendance` 一期恒为 'unknown' —— 靠类型堵死"凭空编造状态"。
 */

export const SOURCE_IDS = ['ulearning', 'hw'] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SOURCE_LABELS: Record<SourceId, string> = {
  ulearning: '优学院 LMS',
  hw: '莞工作业平台',
};

/** 作业列表页 URL 白名单：用于“打开源站”按钮，防止任意跳转。 */
export const SOURCE_ALLOWLIST: Record<SourceId, readonly string[]> = {
  ulearning: ['lms.dgut.edu.cn'],
  hw: ['hw.dgut.edu.cn'],
};

/**
 * 提交状态。`unknown` 与 `not_submitted` 必须严格区分：
 * 只有平台明确显示"未提交/未交"时才是 not_submitted。
 */
export type SubmissionStatus = 'not_submitted' | 'submitted' | 'overdue' | 'unknown';

/**
 * 截止时间的精度。平台只给到日期时使用 `date`，UI 显示为"日期待确认"，
 * 不参与精确到小时的倒计时提醒阈值（3h）计算。
 */
export type DuePrecision = 'datetime' | 'date' | 'none';

/** 列表实体类型。必填 —— 缺失即编译错误，防止 exam 被当成 homework 处理。 */
export type ListItemKind = 'homework' | 'exam';

export const ITEM_KIND_LABELS: Record<ListItemKind, string> = {
  homework: '作业',
  exam: '考试',
};

/** 两种实体共有的字段。 */
interface ListItemBase {
  /** 平台标识。 */
  source: SourceId;
  /** 平台内稳定唯一键；缺失时用 fallbackKey() 生成的稳健回退键。 */
  sourceAssignmentId: string;
  /** 去重主键 = `${source}:${sourceAssignmentId}` */
  id: string;

  courseId: string | null;
  courseName: string | null;
  title: string;

  /** 打开源站的合法 URL（已过 allowlist 校验），null 表示无法构造。 */
  detailUrl: string | null;

  /** 首次被本应用看到的时间（ISO8601）。 */
  firstSeenAt: string;
  /** 最近一次被本应用看到的时间（ISO8601）。 */
  lastSeenAt: string;
  /** 最近一次成功同步该实体所属平台+模块的时间（ISO8601）。 */
  lastSyncAt: string;
  /** 平台侧更新时间（若可得）。 */
  sourceUpdatedAt: string | null;
}

/** 作业。字段与改造前完全一致，只多一个 kind。 */
export interface Assignment extends ListItemBase {
  kind: 'homework';

  /** ISO8601 字符串，含时区偏移（例如 2026-11-10T23:59:00+08:00）；未知为 null。 */
  dueAt: string | null;
  duePrecision: DuePrecision;

  submissionStatus: SubmissionStatus;
  /** 判定依据：来源字段名 + 原始值摘要（脱敏）。 */
  statusEvidence: string;

  /** 用户手动覆盖过截止时间/状态时标注，避免伪装成平台原值。 */
  manuallyOverridden?: { field: 'dueAt' | 'submissionStatus'; at: string };
}

/**
 * 考试**场次**（不是考试本身）。一场考试可能有多场次 => 多个 ExamItem。
 *
 * 为什么按场次而不是按考试：
 *   · 学生端模板只遍历 examRelationTimeList（场次），从不读考试级 startTime；
 *   · 考试级时间允许为空（实测代码把空值转成 ""），拿它做锚点会丢提醒。
 *
 * ⚠️ 未验证（见 investigation/lms/exam-evidence.md §C）：
 *   · 场次唯一标识字段名未知（batchId/roomId 在全部 bundle 中不存在），
 *     故身份 = examId + 场次 startTime；
 *   · 时间字段类型未知（毫秒 / ISO），归一见 parseExamTime()。
 */
export interface ExamItem extends ListItemBase {
  kind: 'exam';

  /** 考试 ID（未验证类型，一律 String() 归一）。 */
  examId: string;
  /** 场次开始（提醒主锚点）。未验证；未知则 null。 */
  startsAt: string | null;
  /** 场次结束。未验证；未知则 null。 */
  endsAt: string | null;
  /** 只有 datetime 才允许阈值提醒。 */
  timePrecision: 'datetime' | 'none';
  /** 考场/座位（仅展示）。未验证字段名。 */
  venue: { roomName: string | null; seatNo: string | null } | null;
  /**
   * 个人参加状态。一期**只能**是 'unknown'：列表接口没有任何字段能可靠回答
   * "我参加了没"（examState 是考试级状态，会把缺考误判为已完成）。
   * 等拿到真实响应且确认可用的个人状态字段后再扩展此联合类型。
   */
  attendance: 'unknown';
  /** 判定依据（脱敏），便于日后回填真实来源。 */
  attendanceEvidence: string;
}

/** 列表读取的统一返回类型。 */
export type ListItem = Assignment | ExamItem;

/** 编译期判别助手：渲染层/提醒层必须先经它收窄，再访问专有字段。 */
export function isExamItem(i: ListItem): i is ExamItem {
  return i.kind === 'exam';
}
export function isHomeworkItem(i: ListItem): i is Assignment {
  return i.kind === 'homework';
}

/** 作业/考试统一的「时间锚点」：作业看截止，考试看开考。无锚点返回 null。 */
export function anchorOf(i: ListItem): string | null {
  return isExamItem(i) ? i.startsAt : i.dueAt;
}

/** 统一的「结束/过期时刻」：作业=截止；考试=场次结束（缺失时退化用开考）。 */
export function endOf(i: ListItem): string | null {
  if (!isExamItem(i)) return i.dueAt;
  return i.endsAt ?? i.startsAt;
}

export function assignmentId(source: SourceId, sourceAssignmentId: string): string {
  return `${source}:${sourceAssignmentId}`;
}

/**
 * 考试场次的 stable key。
 *
 * 用毫秒而非 ISO 文本：ISO 可能因平台格式差异（有无秒、T/空格）漂移，毫秒是稳定数值。
 * 场次开始变化 => key 变化 => 旧提醒键自然失效（与 ADR-007 同一套机制）。
 */
export function examSourceId(examId: string, startsAtMs: number | null): string {
  return `exam:${examId}@${startsAtMs ?? 'nostart'}`;
}

/**
 * 稳健回退键：当平台没有稳定 ID 时，用 课程 + 标题 + 截止时间 组合。
 * 注意：这是最后手段；一旦平台提供稳定 ID，应优先使用。
 */
export function fallbackKey(parts: {
  courseId?: string | null;
  courseName?: string | null;
  title: string;
  dueAt?: string | null;
}): string {
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return [
    norm(parts.courseId) || norm(parts.courseName) || 'unknown-course',
    norm(parts.title),
    norm(parts.dueAt) || 'no-due',
  ].join('|');
}

/** 允许跳转的 URL 校验：协议必须是 https，且 host 在 allowlist 内。 */
export function isAllowedDetailUrl(source: SourceId, url: string | null): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return SOURCE_ALLOWLIST[source].some(
    (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
  );
}
