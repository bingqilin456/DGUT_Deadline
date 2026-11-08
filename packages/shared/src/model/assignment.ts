/**
 * 莞工 Deadline —— 作业领域模型（平台无关的归一化层）
 *
 * 设计原则（见 docs/PLATFORM_FINDINGS.md）：
 *  1. 任何字段无法从平台证据中确定时，一律保留 `unknown`/`null`，绝不猜测默认值。
 *  2. `dueAt` 必须带时区偏移；平台只给日期不给时间时，不得补 23:59，改为 dueAt=null + duePrecision='date'。
 *  3. `statusEvidence` 记录"为什么判定为这个状态"，不含任何凭证、Cookie、Token。
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

export interface Assignment {
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

  /** ISO8601 字符串，含时区偏移（例如 2026-11-10T23:59:00+08:00）；未知为 null。 */
  dueAt: string | null;
  duePrecision: DuePrecision;

  submissionStatus: SubmissionStatus;
  /** 判定依据：来源字段名 + 原始值摘要（脱敏）。 */
  statusEvidence: string;

  /** 用户手动覆盖过截止时间/状态时标注，避免伪装成平台原值。 */
  manuallyOverridden?: { field: 'dueAt' | 'submissionStatus'; at: string };

  /** 首次被本应用看到的时间（ISO8601）。 */
  firstSeenAt: string;
  /** 最近一次被本应用看到的时间（ISO8601）。 */
  lastSeenAt: string;
  /** 最近一次成功同步该作业所属平台的时间（ISO8601）。 */
  lastSyncAt: string;
  /** 平台侧更新时间（若可得）。 */
  sourceUpdatedAt: string | null;
}

export function assignmentId(source: SourceId, sourceAssignmentId: string): string {
  return `${source}:${sourceAssignmentId}`;
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
