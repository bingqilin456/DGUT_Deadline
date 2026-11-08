/**
 * 提醒规则（纯逻辑，可注入时钟做测试）。
 *
 * 幂等键设计：`${source}:${assignmentId}:${dueAt}:${thresholdHours}`
 * —— 包含 dueAt，所以截止时间一改，旧键天然失效，会在新时间点重新计划。
 */

import type { Assignment, SubmissionStatus } from '@dgut-deadline/shared';
import { dueToMs } from '@dgut-deadline/shared';
import type { ThresholdSetting } from '@shared/thresholds';

export interface ReminderThreshold {
  hours: number;
}

export interface PlannedReminder {
  key: string;
  assignmentId: string;
  source: string;
  title: string;
  courseName: string | null;
  dueAt: string | null;
  thresholdHours: number;
  /** 应触发的绝对时间（毫秒）。 */
  fireAtMs: number;
  /** 提醒文案的确定性等级。 */
  certainty: 'definite' | 'needs_check';
  /**
   * 是否强制弹出：不自动消失 + 有提示音 + **不受静默时段抑制**。
   * 用于 12h / 6h / 3h / 1h 等临近截止的关键提醒。
   */
  urgent: boolean;
}

export interface PlanContext {
  /** 当前毫秒时间。 */
  nowMs: number;
  /**
   * 用户设置的阈值。支持两种形式：
   *  - number[]（旧式，全部视为启用、非强制）—— 保持向后兼容
   *  - ThresholdSetting[]（新式，带 enabled / urgent）
   */
  thresholdsHours: number[] | ThresholdSetting[];
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

/** 幂等键。 */
export function reminderKey(a: Assignment, thresholdHours: number): string {
  return `${a.source}:${a.sourceAssignmentId}:${a.dueAt ?? 'no-due'}:${thresholdHours}`;
}

/**
 * 提交状态是否应抑制提醒。
 * 只有 **明确已提交** 才抑制；unknown 不抑制（但降低文案确定性）。
 */
export function shouldSuppress(status: SubmissionStatus): boolean {
  return status === 'submitted';
}

/**
 * 生成到期的提醒列表。
 *
 * 规则：
 *  - 已提交 => 不提醒。
 *  - 无截止时间（dueAt=null）=> 不参与阈值提醒（不能在未知时间瞎推算）。
 *  - duePrecision='date' => 只对 >=24h 的阈值提醒，3h 阈值跳过（因为不知道具体时刻）。
 *  - 键已触发过 => 跳过（幂等）。
 *  - fireAt 已过 & 未触发且未截止超过 graceMs => 进行补偿提醒（休眠/离线恢复）。
 */
export function planReminders(
  assignments: readonly Assignment[],
  ctx: PlanContext,
  opts: { graceMs?: number } = {},
): PlannedReminder[] {
  const graceMs = opts.graceMs ?? 24 * 60 * 60 * 1000; // 过期超过 24h 不再补提醒
  const out: PlannedReminder[] = [];

  for (const a of assignments) {
    if (shouldSuppress(a.submissionStatus)) continue;
    const dueMs = dueToMs(a.dueAt);
    if (dueMs === null) continue;

    // 提交状态未知时：用户若关闭了低确定性提醒，则整条作业都不提醒。
    // 绝不能降级成"确定语气"的提醒——那会变成误报"你还没交"。
    const isUnknown = a.submissionStatus === 'unknown';
    if (isUnknown && !ctx.notifyUnknownStatus) continue;

    const certainty: PlannedReminder['certainty'] = isUnknown ? 'needs_check' : 'definite';

    for (const t of toThresholds(ctx.thresholdsHours)) {
      const hours = t.hours;
      if (!t.enabled) continue; // 用户关闭了该阈值

      // 只有日期精度时，无法确定 <24h 内的时刻
      if (a.duePrecision === 'date' && hours < 24) continue;

      const fireAtMs = dueMs - hours * 60 * 60 * 1000;
      if (fireAtMs > ctx.nowMs) continue; // 尚未到点，由调度器后续处理

      // 已过期太久则不再补发，避免通知轰炸
      if (ctx.nowMs - dueMs > graceMs) continue;

      const key = reminderKey(a, hours);
      if (ctx.firedKeys.has(key)) continue;

      out.push({
        key,
        assignmentId: a.id,
        source: a.source,
        title: a.title,
        courseName: a.courseName,
        dueAt: a.dueAt,
        thresholdHours: hours,
        fireAtMs,
        certainty,
        urgent: t.urgent === true,
      });
    }
  }

  return out.sort((x, y) => y.fireAtMs - x.fireAtMs);
}

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

/** 提醒文案（中文）。 */
export function reminderText(r: PlannedReminder): { title: string; body: string } {
  const due = r.dueAt
    ? new Date(r.dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '截止时间未知';

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
