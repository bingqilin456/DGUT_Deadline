/**
 * 提醒规划器测试。使用注入时钟，覆盖跨日、过期、改期、去重等场景。
 */

import { describe, expect, it } from 'vitest';
import type { Assignment } from '@dgut-deadline/shared';
import { isInQuietHours, planReminders, reminderKey, shouldSuppress, type PlanContext } from './planner.js';

const TZ = '+08:00';

function mkA(over: Partial<Assignment> = {}): Assignment {
  return {
    source: 'hw',
    sourceAssignmentId: '1',
    id: 'hw:1',
    courseId: null,
    courseName: '数据库系统原理',
    title: '作业三',
    detailUrl: 'https://hw.dgut.edu.cn/student/homeworkPlan',
    dueAt: `2026-11-12T12:00:00${TZ}`,
    duePrecision: 'datetime',
    submissionStatus: 'not_submitted',
    statusEvidence: 'plan.submitted=false',
    firstSeenAt: `2026-11-01T00:00:00${TZ}`,
    lastSeenAt: `2026-11-01T00:00:00${TZ}`,
    lastSyncAt: `2026-11-01T00:00:00${TZ}`,
    sourceUpdatedAt: null,
    ...over,
  };
}

function mkCtx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    nowMs: Date.parse(`2026-11-09T13:00:00${TZ}`), // 距截止 71 小时
    thresholdsHours: [72, 24, 3],
    notifyUnknownStatus: true,
    firedKeys: new Set<string>(),
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    ...over,
  };
}

describe('planReminders —— 阈值触发', () => {
  it('距截止 71 小时：72h 阈值已过，应产生一条提醒', () => {
    const out = planReminders([mkA()], mkCtx());
    expect(out).toHaveLength(1);
    expect(out[0]!.thresholdHours).toBe(72);
  });

  it('远离截止（剩 200 小时）：不产生提醒', () => {
    const out = planReminders(
      [mkA({ dueAt: `2026-11-18T12:00:00${TZ}` })],
      mkCtx(),
    );
    expect(out).toHaveLength(0);
  });

  it('24h 与 3h 阈值在跨过时都触发', () => {
    // 截止前 2 小时：72h 与 24h 均已过，3h 也已过（now > due-3h）
    const out = planReminders(
      [mkA()],
      mkCtx({ nowMs: Date.parse(`2026-11-12T10:00:00${TZ}`) }),
    );
    const hours = out.map((r) => r.thresholdHours).sort((a, b) => a - b);
    expect(hours).toEqual([3, 24, 72]);
  });
});

describe('planReminders —— 已提交与未知状态', () => {
  it('已提交的作业完全不提醒', () => {
    const out = planReminders([mkA({ submissionStatus: 'submitted' })], mkCtx());
    expect(out).toHaveLength(0);
  });

  it('shouldSuppress 只对 submitted 返回 true', () => {
    expect(shouldSuppress('submitted')).toBe(true);
    expect(shouldSuppress('not_submitted')).toBe(false);
    expect(shouldSuppress('unknown')).toBe(false);
    expect(shouldSuppress('overdue')).toBe(false);
  });

  it('unknown 状态标记为 needs_check（低确定性）', () => {
    const out = planReminders([mkA({ submissionStatus: 'unknown' })], mkCtx());
    expect(out).toHaveLength(1);
    expect(out[0]!.certainty).toBe('needs_check');
  });

  it('用户关闭未知状态提醒时，unknown 作业不提醒', () => {
    const out = planReminders(
      [mkA({ submissionStatus: 'unknown' })],
      mkCtx({ notifyUnknownStatus: false }),
    );
    expect(out).toHaveLength(0);
  });

  it('not_submitted 是确定状态', () => {
    const out = planReminders([mkA({ submissionStatus: 'not_submitted' })], mkCtx());
    expect(out[0]!.certainty).toBe('definite');
  });
});

describe('planReminders —— 幂等去重', () => {
  it('已触发过的键不再重复提醒', () => {
    const a = mkA();
    const key = reminderKey(a, 72);
    const out = planReminders([a], mkCtx({ firedKeys: new Set([key]) }));
    expect(out).toHaveLength(0);
  });

  it('幂等键包含 dueAt —— 改期后旧键失效，会重新提醒', () => {
    const a1 = mkA();
    // 改期到更近的时间（距 now 48 小时，72h 阈值已过），确保会触发
    const a2 = mkA({ dueAt: `2026-11-11T12:00:00${TZ}` });
    const k1 = reminderKey(a1, 72);
    const k2 = reminderKey(a2, 72);
    expect(k1).not.toBe(k2);

    // 旧键已触发，但作业改期后应能再次提醒
    const out = planReminders([a2], mkCtx({ firedKeys: new Set([k1]) }));
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe(k2);
  });

  it('改期到更远的时间后，尚未跨过阈值则不提醒', () => {
    // now = 11-09 13:00，改期到 11-13 12:00 后距截止 95h，72h 阈值还没到
    const a2 = mkA({ dueAt: `2026-11-13T12:00:00${TZ}` });
    const out = planReminders([a2], mkCtx());
    expect(out).toHaveLength(0);
  });

  it('幂等键包含阈值 —— 不同阈值互不影响', () => {
    const a = mkA();
    expect(reminderKey(a, 72)).not.toBe(reminderKey(a, 24));
  });
});

describe('planReminders —— 无截止时间与日期精度', () => {
  it('无截止时间的作业不参与阈值提醒（不猜测时间）', () => {
    const out = planReminders(
      [mkA({ dueAt: null, duePrecision: 'none' })],
      mkCtx(),
    );
    expect(out).toHaveLength(0);
  });

  it('只有日期精度时跳过 3h 阈值，但保留 24h/72h', () => {
    const out = planReminders(
      [mkA({ duePrecision: 'date', dueAt: `2026-11-12T00:00:00${TZ}` })],
      mkCtx({ nowMs: Date.parse(`2026-11-11T22:00:00${TZ}`) }),
    );
    const hours = out.map((r) => r.thresholdHours);
    expect(hours).not.toContain(3);
    expect(hours).toContain(24);
  });
});

describe('planReminders —— 过期补偿', () => {
  it('刚过期 1 小时的作业仍补发提醒（休眠恢复场景）', () => {
    const out = planReminders(
      [mkA()],
      mkCtx({ nowMs: Date.parse(`2026-11-12T13:00:00${TZ}`) }),
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it('过期超过 24 小时不再补发，避免通知轰炸', () => {
    const out = planReminders(
      [mkA()],
      mkCtx({ nowMs: Date.parse(`2026-11-14T00:00:00${TZ}`) }),
    );
    expect(out).toHaveLength(0);
  });
});

describe('isInQuietHours —— 静默时段', () => {
  const at = (hhmm: string): number => Date.parse(`2026-11-10T${hhmm}:00${TZ}`);
  const q = { enabled: true, start: '23:00', end: '07:00' };

  it('关闭时永远不在静默中', () => {
    expect(isInQuietHours(at('23:30'), { ...q, enabled: false })).toBe(false);
  });

  it('跨零点时段：23:30 在静默中', () => {
    expect(isInQuietHours(at('23:30'), q)).toBe(true);
  });

  it('跨零点时段：02:00 在静默中', () => {
    expect(isInQuietHours(at('02:00'), q)).toBe(true);
  });

  it('跨零点时段：12:00 不在静默中', () => {
    expect(isInQuietHours(at('12:00'), q)).toBe(false);
  });

  it('边界：23:00 在静默中，07:00 不在', () => {
    expect(isInQuietHours(at('23:00'), q)).toBe(true);
    expect(isInQuietHours(at('07:00'), q)).toBe(false);
  });

  it('非跨零点时段：09:00-17:00，12:00 在内、20:00 在外', () => {
    const day = { enabled: true, start: '09:00', end: '17:00' };
    expect(isInQuietHours(at('12:00'), day)).toBe(true);
    expect(isInQuietHours(at('20:00'), day)).toBe(false);
  });

  it('非法时间格式不会导致误判', () => {
    expect(isInQuietHours(at('12:00'), { enabled: true, start: 'xx', end: 'yy' })).toBe(false);
  });
});
