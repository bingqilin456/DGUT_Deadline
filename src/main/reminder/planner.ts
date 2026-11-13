/**
 * 提醒规则（纯逻辑，可注入时钟做测试）。
 *
 * 幂等键设计（两种实体各自一套）：
 *  - 作业：`${item.id}:${dueAt}:${thresholdHours}`
 *  - 考试：`${item.id}:${anchor}:${offsetMinutes}:${anchorAtMs}`
 *
 * 共同点：键里**包含锚点时间**，所以改期后旧键天然失效，会在新时间点重新计划
 * （ADR-007 的核心不变式，两种实体都遵守）。
 *
 * ⚠️ 历史缺陷已修（2026-11-11）：旧键用 `a.sourceAssignmentId`，不含 kind。
 * 作业与考试的 source 都是 'ulearning'，若考试 examId 与作业 id 数值相同，
 * 两条记录会共用同一个提醒键，被 firedKeys 去重吃掉 ⇒ 漏提醒。
 * 现在改用 `a.id`（考试侧已含 `exam:` 前缀，物理上不可能与作业撞车）。
 * 对作业而言新键与旧键**逐字节相同**（因为 id === `${source}:${sourceAssignmentId}`），
 * 所以升级不需要清理历史 reminders，也不会重放旧通知。
 */

import type { Assignment, ExamItem, ListItem, SubmissionStatus } from '@dgut-deadline/shared';
import { dueToMs, isExamItem } from '@dgut-deadline/shared';
import type { ExamThresholdSetting, ThresholdSetting } from '@shared/thresholds';

export interface ReminderThreshold {
  hours: number;
}

export interface PlannedReminder {
  key: string;
  assignmentId: string;
  /** 实体类型：决定文案与「打开」行为的差异。 */
  kind: 'homework' | 'exam';
  source: string;
  title: string;
  courseName: string | null;
  /** 作业=截止时间；考试=本次提醒的锚点时间（开考或结束）。 */
  dueAt: string | null;
  /** 作业用：提前小时数。考试时为 0（不使用该字段）。 */
  thresholdHours: number;
  /** 考试用：提前分钟数（负值表示锚点之后）。作业时为 0。 */
  thresholdMinutes: number;
  /** 考试用：锚点。 */
  anchor?: 'start' | 'end';
  /** 应触发的绝对时间（毫秒）。 */
  fireAtMs: number;
  /**
   * 文案的确定性等级。
   * definite = 平台明确状态；needs_check = 状态/时间未知，文案必须降级为"请核对"。
   */
  certainty: 'definite' | 'needs_check';
  /**
   * 是否强制弹出：不自动消失 + 有提示音 + **不受静默时段抑制**。
   */
  urgent: boolean;
}

export interface PlanContext {
  /** 当前毫秒时间。 */
  nowMs: number;
  /**
   * 用户设置的作业阈值。支持两种形式：
   *  - number[]（旧式，全部视为启用、非强制）—— 保持向后兼容
   *  - ThresholdSetting[]（新式，带 enabled / urgent）
   */
  thresholdsHours: number[] | ThresholdSetting[];
  /** 考试阈值（分钟级）。缺省时不做考试提醒。 */
  examThresholds?: readonly ExamThresholdSetting[];
  /** 是否对 unknown 状态给出低确定性提醒。 */
  notifyUnknownStatus: boolean;
  /** 已触发过的键集合（幂等去重）。 */
  firedKeys: ReadonlySet<string>;
  /** 静默时段。 */
  quietHours: { enabled: boolean; start: string; end: string };
}

/** 把两种阈值形式统一成 ThresholdSetting[]。 */
function toThresholds(input: number[] | ThresholdSetting[]): ThresholdSetting[] {
  if (input.length === 0) return [];
  if (typeof input[0] === 'number') {
    return (input as number[]).map((h) => ({ hours: h, enabled: true, urgent: false }));
  }
  return input as ThresholdSetting[];
}

/** 作业幂等键（与改造前逐字节相同，保证历史 reminders 继续有效）。 */
export function reminderKey(a: Assignment, thresholdHours: number): string {
  return `${a.id}:${a.dueAt ?? 'no-due'}:${thresholdHours}`;
}

/**
 * 考试幂等键。
 *
 * 含 anchorAtMs：场次改期 => id 变 => 键变；只改结束时间 => id 不变但键里的
 * anchorAtMs 变 => 旧键仍失效。两个方向都安全。
 */
export function examReminderKey(
  x: ExamItem,
  anchor: 'start' | 'end',
  offsetMinutes: number,
  anchorAtMs: number,
): string {
  return `${x.id}:${anchor}:${offsetMinutes}:${anchorAtMs}`;
}

/**
 * 提交状态是否应抑制提醒。
 * 只有 **明确已提交** 才抑制；unknown 不抑制（但降低文案确定性）。
 */
export function shouldSuppress(status: SubmissionStatus): boolean {
  return status === 'submitted';
}

/**
 * 生成到期的提醒列表（作业 + 考试）。
 *
 * 作业规则（与改造前一致）：
 *  - 已提交 => 不提醒。
 *  - 无截止时间（dueAt=null）=> 不参与阈值提醒。
 *  - duePrecision='date' => 只对 >=24h 的阈值提醒。
 *  - 键已触发过 => 跳过。
 *  - fireAt 已过 & 未触发且未截止超过 graceMs => 补偿提醒。
 *
 * 考试规则：
 *  - 锚点 = startsAt（作业的 dueAt 语义完全不同，不可混用）。
 *  - startsAt 缺失（@nostart 兜底项）=> 不提醒。
 *  - 参加状态恒 unknown => 一律**不抑制**（不能因"不知道交没交"就漏考）。
 *  - 以场次为单位，同一场考试可有多个提醒（不同 offset）。
 */
export function planReminders(
  items: readonly ListItem[],
  ctx: PlanContext,
  opts: { graceMs?: number } = {},
): PlannedReminder[] {
  const graceMs = opts.graceMs ?? 24 * 60 * 60 * 1000; // 过期超过 24h 不再补提醒
  const out: PlannedReminder[] = [];

  for (const a of items) {
    if (isExamItem(a)) {
      out.push(...planExamReminders(a, ctx, graceMs));
    } else {
      out.push(...planHomeworkReminders(a, ctx, graceMs));
    }
  }

  return out.sort((x, y) => y.fireAtMs - x.fireAtMs);
}

/** 作业提醒（改造前逻辑，逐条保持语义不变）。 */
function planHomeworkReminders(
  a: Assignment,
  ctx: PlanContext,
  graceMs: number,
): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  if (shouldSuppress(a.submissionStatus)) return out;
  const dueMs = dueToMs(a.dueAt);
  if (dueMs === null) return out;

  // 提交状态未知时：用户若关闭了低确定性提醒，则整条作业都不提醒。
  // 绝不能降级成"确定语气"的提醒——那会变成误报"你还没交"。
  const isUnknown = a.submissionStatus === 'unknown';
  if (isUnknown && !ctx.notifyUnknownStatus) return out;

  const certainty: PlannedReminder['certainty'] = isUnknown ? 'needs_check' : 'definite';

  for (const t of toThresholds(ctx.thresholdsHours)) {
    const hours = t.hours;
    if (!t.enabled) continue;

    // 只有日期精度时，无法确定 <24h 内的时刻
    if (a.duePrecision === 'date' && hours < 24) continue;

    const fireAtMs = dueMs - hours * 60 * 60 * 1000;
    if (fireAtMs > ctx.nowMs) continue;

    if (ctx.nowMs - dueMs > graceMs) continue;

    const key = reminderKey(a, hours);
    if (ctx.firedKeys.has(key)) continue;

    out.push({
      key,
      assignmentId: a.id,
      kind: 'homework',
      source: a.source,
      title: a.title,
      courseName: a.courseName,
      dueAt: a.dueAt,
      thresholdHours: hours,
      thresholdMinutes: 0,
      fireAtMs,
      certainty,
      urgent: t.urgent === true,
    });
  }
  return out;
}

/**
 * 考试提醒。
 *
 * 已交过卷（`attendance === 'submitted'`，即 `answerTimes >= 1`）时抑制提醒；
 * 未交卷（`not_submitted`）或未知（`unknown`）均照常提醒 —— 漏考比多提醒一次严重得多。
 */
function planExamReminders(
  x: ExamItem,
  ctx: PlanContext,
  graceMs: number,
): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  if (x.attendance === 'submitted') return out;
  const thresholds = ctx.examThresholds ?? [];
  if (thresholds.length === 0) return out;

  const startMs = dueToMs(x.startsAt);
  const endMs = dueToMs(x.endsAt);
  // 开考时间未知 => 所有锚点都无法定位（@nostart 兜底项），不提醒
  if (startMs === null) return out;

  for (const t of thresholds) {
    if (!t.enabled) continue;

    const anchorAtMs = t.anchor === 'start' ? startMs : endMs;
    // 结束锚点但结束时间未知 => 跳过（不猜）
    if (anchorAtMs === null) continue;

    const fireAtMs = anchorAtMs - t.offsetMinutes * 60_000;
    if (fireAtMs > ctx.nowMs) continue;

    // 已过锚点太久不补发，避免通知轰炸
    if (ctx.nowMs - anchorAtMs > graceMs) continue;

    const key = examReminderKey(x, t.anchor, t.offsetMinutes, anchorAtMs);
    if (ctx.firedKeys.has(key)) continue;

    out.push({
      key,
      assignmentId: x.id,
      kind: 'exam',
      source: x.source,
      title: x.title,
      courseName: x.courseName,
      dueAt: t.anchor === 'start' ? x.startsAt : x.endsAt,
      thresholdHours: 0,
      thresholdMinutes: t.offsetMinutes,
      anchor: t.anchor,
      fireAtMs,
      certainty: 'definite',
      urgent: t.urgent === true,
    });
  }
  return out;
}

/**
 * 考试阶段交给 packages/shared 的单一实现（渲染层也用同一个）。
 * 这里 re-export，保持既有 import 路径不变。
 */
export { examPhase, type ExamPhase } from '@dgut-deadline/shared';

/** 判断某个时刻是否落在静默时段（支持跨零点）。 */
export function isInQuietHours(nowMs: number, q: { enabled: boolean; start: string; end: string }): boolean {
  if (!q.enabled) return false;
  const toMin = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  };
  const s = toMin(q.start);
  const e = toMin(q.end);
  if (s === null || e === null) return false;

  // 用固定的 Asia/Shanghai 偏移计算当地分钟数
  const local = new Date(nowMs + 8 * 60 * 60 * 1000);
  const cur = local.getUTCHours() * 60 + local.getUTCMinutes();

  if (s === e) return false;
  if (s < e) return cur >= s && cur < e;
  // 跨零点，例如 23:00 - 07:00
  return cur >= s || cur < e;
}

/** 提醒文案（中文）。作业与考试必须走不同分支——共用会写出"作业即将截止"的错误文案。 */
export function reminderText(r: PlannedReminder): { title: string; body: string } {
  const due = r.dueAt
    ? new Date(r.dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '时间未知';

  if (r.kind === 'exam') {
    return examReminderText(r, due);
  }

  if (r.certainty === 'needs_check') {
    return {
      title: '请核对作业状态',
      body: `《${r.title}》${r.courseName ? `（${r.courseName}）` : ''} 提交状态无法确认，截止：${due}。请打开平台核对。`,
    };
  }

  const hours = r.thresholdHours;
  // 强制提醒用更紧迫的措辞
  if (r.urgent) {
    const title = hours <= 1 ? `⚠️ 1 小时内截止！` : `⚠️ 还有 ${hours} 小时截止`;
    return {
      title,
      body: `《${r.title}》${r.courseName ? `（${r.courseName}）` : ''} 将于 ${due} 截止，请尽快提交。`,
    };
  }

  return {
    title: `作业即将截止（${hours} 小时）`,
    body: `《${r.title}》${r.courseName ? `（${r.courseName}）` : ''} 截止：${due}。`,
  };
}

/** 考试文案：时间点 + 紧迫度，不涉及「交没交」。 */
function examReminderText(r: PlannedReminder, at: string): { title: string; body: string } {
  const name = `《${r.title}》${r.courseName ? `（${r.courseName}）` : ''}`;
  const isEnd = r.anchor === 'end';

  if (r.thresholdMinutes === 0) {
    return isEnd
      ? { title: '考试已结束', body: `${name} 已于 ${at} 结束。` }
      : { title: '考试已开始', body: `${name} 已于 ${at} 开考，请尽快进入考场。` };
  }

  const isAfter = r.thresholdMinutes < 0;
  const abs = Math.abs(r.thresholdMinutes);
  const span = abs % 60 === 0 ? `${abs / 60} 小时` : `${abs} 分钟`;

  if (isAfter) {
    return isEnd
      ? { title: `考试已结束 ${span}`, body: `${name} 已于 ${at} 结束。` }
      : { title: `考试已开始 ${span}`, body: `${name} 已于 ${at} 开考。` };
  }

  if (r.urgent) {
    const title = isEnd ? `⚠️ ${span} 后考试结束` : `⚠️ ${span} 后开考`;
    return {
      title,
      body: isEnd
        ? `${name} 将于 ${at} 结束，请及时交卷。`
        : `${name} 将于 ${at} 开考，请确认考场与设备。`,
    };
  }

  return {
    title: isEnd ? `考试即将结束（${span}）` : `考试即将开始（${span}）`,
    body: `${name} ${isEnd ? '结束' : '开考'}：${at}。`,
  };
}
