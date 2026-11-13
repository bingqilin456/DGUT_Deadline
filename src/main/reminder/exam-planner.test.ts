/**
 * 考试提醒测试（2026-11-11 新增）。
 *
 * ⚠️ 夹具为**合成数据**，不是真实平台响应（考试列表接口的真实响应尚未拿到，
 * 见 investigation/lms/exam-evidence.md §C.1）。这里只验证提醒**逻辑**，
 * 不声称任何字段形状已被平台验证。
 */

import { describe, expect, it } from 'vitest';
import type { Assignment, ExamItem, ListItem } from '@dgut-deadline/shared';
import { examSourceId } from '@dgut-deadline/shared';
import type { ExamThresholdSetting } from '@shared/thresholds';
import {
  examPhase,
  examReminderKey,
  planReminders,
  reminderKey,
  reminderText,
  type PlanContext,
} from './planner.js';

const TZ = '+08:00';

/** 2026-11-12 12:00 +08:00 —— 所有用例的「现在」。 */
const NOW = Date.parse(`2026-11-12T12:00:00${TZ}`);

function at(iso: string): number {
  return Date.parse(iso);
}

function mkExam(over: Partial<ExamItem> = {}): ExamItem {
  const startsAt = over.startsAt !== undefined ? over.startsAt : `2026-11-13T12:00:00${TZ}`;
  const startsMs = startsAt ? at(startsAt) : null;
  const examId = over.examId ?? '9001';
  const srcId = examSourceId(examId, startsMs);
  return {
    kind: 'exam',
    source: 'ulearning',
    sourceAssignmentId: srcId,
    id: `ulearning:${srcId}`,
    courseId: '162440',
    courseName: '面向对象程序设计(Java)',
    title: '期末考试',
    detailUrl: 'https://lms.dgut.edu.cn/utest/#/exam/9001',
    examId,
    startsAt,
    endsAt: `2026-11-13T14:00:00${TZ}`,
    timePrecision: 'datetime',
    venue: { roomName: '机房 301', seatNo: 'A-12' },
    attendance: 'unknown',
    attendanceEvidence: '平台列表接口无可靠参加状态字段，一期不做推断',
    firstSeenAt: `2026-11-01T00:00:00${TZ}`,
    lastSeenAt: `2026-11-01T00:00:00${TZ}`,
    lastSyncAt: `2026-11-01T00:00:00${TZ}`,
    sourceUpdatedAt: null,
    ...over,
  };
}

function mkHomework(over: Partial<Assignment> = {}): Assignment {
  return {
    kind: 'homework',
    source: 'hw',
    sourceAssignmentId: '1',
    id: 'hw:1',
    courseId: null,
    courseName: '数据库系统原理',
    title: '作业三',
    detailUrl: 'https://hw.dgut.edu.cn/student/homeworkPlan',
    dueAt: `2026-11-13T12:00:00${TZ}`,
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

const START_ONLY: ExamThresholdSetting[] = [
  { anchor: 'start', offsetMinutes: 1440, enabled: true, urgent: false },
  { anchor: 'start', offsetMinutes: 120, enabled: true, urgent: true },
  { anchor: 'start', offsetMinutes: 30, enabled: true, urgent: true },
  { anchor: 'start', offsetMinutes: 0, enabled: true, urgent: true },
];

function mkCtx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    nowMs: NOW,
    thresholdsHours: [],
    examThresholds: START_ONLY,
    notifyUnknownStatus: true,
    firedKeys: new Set<string>(),
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    ...over,
  };
}

describe('考试提醒 —— 锚点与触发', () => {
  it('距开考 25 小时：只有「提前 1 天」阈值已触发', () => {
    const out = planReminders([mkExam()], mkCtx());
    expect(out).toHaveLength(1);
    expect(out[0]!.thresholdMinutes).toBe(1440);
    expect(out[0]!.kind).toBe('exam');
  });

  it('距开考 1 小时：1天/2小时阈值已跨过；30分钟阈值尚在 30 分钟后，不触发', () => {
    const out = planReminders(
      [mkExam()],
      mkCtx({ nowMs: at(`2026-11-13T11:00:00${TZ}`) }),
    );
    const mins = out.map((r) => r.thresholdMinutes).sort((a, b) => b - a);
    // 11:00 时，「提前 30 分钟」的触发点是 11:30，尚未到达
    expect(mins).toEqual([1440, 120]);
  });

  it('距开考 20 分钟：30 分钟阈值也已跨过', () => {
    const out = planReminders(
      [mkExam()],
      mkCtx({ nowMs: at(`2026-11-13T11:40:00${TZ}`) }),
    );
    const mins = out.map((r) => r.thresholdMinutes).sort((a, b) => b - a);
    expect(mins).toEqual([1440, 120, 30]);
  });

  it('开考瞬间产生 offset=0 的提醒', () => {
    const out = planReminders(
      [mkExam()],
      mkCtx({ nowMs: at(`2026-11-13T12:00:00${TZ}`) }),
    );
    const zero = out.find((r) => r.thresholdMinutes === 0);
    expect(zero).toBeDefined();
  });

  it('尚未跨过任何阈值（距开考 100 小时）：不提醒', () => {
    const out = planReminders([mkExam()], mkCtx());
    // 距开考 24h（本用例起手就是 24h 后），1440 分钟阈值刚好跨过
    // 换一个更远的场次验证「完全未到」
    const far = planReminders(
      [mkExam({ startsAt: `2026-11-20T12:00:00${TZ}` })],
      mkCtx(),
    );
    expect(far).toHaveLength(0);
    void out;
  });

  it('urgent 标记来自阈值配置（提前 2 小时 / 30 分钟 / 开考瞬间）', () => {
    const out = planReminders(
      [mkExam()],
      mkCtx({ nowMs: at(`2026-11-13T12:00:00${TZ}`) }),
    );
    const urgentMins = out.filter((r) => r.urgent).map((r) => r.thresholdMinutes).sort((a, b) => b - a);
    expect(urgentMins).toEqual([120, 30, 0]);
  });
});

describe('考试提醒 —— 无时不猜', () => {
  it('startsAt 为 null（@nostart 兜底项）=> 完全不提醒', () => {
    const x = mkExam({ startsAt: null, timePrecision: 'none' });
    const out = planReminders([x], mkCtx());
    expect(out).toHaveLength(0);
  });

  it('结束时间未知时，end 锚点阈值跳过（不猜）', () => {
    const thresholds: ExamThresholdSetting[] = [
      { anchor: 'end', offsetMinutes: 30, enabled: true, urgent: true },
    ];
    const x = mkExam({ endsAt: null });
    const out = planReminders([x], mkCtx({ examThresholds: thresholds, nowMs: at(`2026-11-13T12:00:00${TZ}`) }));
    expect(out).toHaveLength(0);
  });

  it('已过锚点超过 24 小时不再补发（防通知轰炸）', () => {
    const out = planReminders(
      [mkExam()],
      mkCtx({ nowMs: at(`2026-11-15T12:00:00${TZ}`) }),
    );
    expect(out).toHaveLength(0);
  });

  it('未配置考试阈值 => 不产生任何考试提醒', () => {
    const out = planReminders([mkExam()], mkCtx({ examThresholds: [] }));
    expect(out).toHaveLength(0);
  });

  it('参加状态 unknown 或 not_submitted 绝不抑制提醒（漏考比多提醒严重）', () => {
    const outUnknown = planReminders([mkExam({ attendance: 'unknown' })], mkCtx());
    const outNotSubmitted = planReminders([mkExam({ attendance: 'not_submitted', answerTimes: 0 })], mkCtx());
    expect(outUnknown.length).toBeGreaterThan(0);
    expect(outNotSubmitted.length).toBeGreaterThan(0);
  });

  it('已交过卷（attendance=submitted，哪怕允许多次只交了 1 次）抑制考试提醒', () => {
    const out = planReminders(
      [mkExam({ attendance: 'submitted', answerTimes: 1, limitTimes: 2, score: 60 })],
      mkCtx({ nowMs: at(`2026-11-13T12:00:00${TZ}`) }),
    );
    expect(out).toHaveLength(0);
  });
});

describe('考试提醒 —— 幂等键', () => {
  it('同一场次不同 offset 的键互不相同', () => {
    const x = mkExam();
    const ms = at(`2026-11-13T12:00:00${TZ}`);
    const k1440 = examReminderKey(x, 'start', 1440, ms);
    const k120 = examReminderKey(x, 'start', 120, ms);
    expect(k1440).not.toBe(k120);
  });

  it('场次改期（startsAt 变）后 id 与键都变 => 旧键失效', () => {
    const a = mkExam();
    const b = mkExam({ startsAt: `2026-11-14T12:00:00${TZ}` });
    expect(a.id).not.toBe(b.id);
    expect(
      examReminderKey(a, 'start', 120, at(`2026-11-13T12:00:00${TZ}`)),
    ).not.toBe(examReminderKey(b, 'start', 120, at(`2026-11-14T12:00:00${TZ}`)));
  });

  it('已触发过的考试键不再重复提醒', () => {
    const x = mkExam();
    const key = examReminderKey(x, 'start', 1440, at(`2026-11-13T12:00:00${TZ}`));
    const out = planReminders([x], mkCtx({ firedKeys: new Set([key]) }));
    expect(out).toHaveLength(0);
  });

  /** 这是本次改造要堵的最大漏洞：作业与考试同数值 id 不得共用键。 */
  it('【关键】作业与考试即使数值 id 相同，提醒键也不得相同', () => {
    const hw = mkHomework({ sourceAssignmentId: '500750', id: 'ulearning:500750' });
    const exam = mkExam({ examId: '500750' });
    const hwKey = reminderKey(hw, 72);
    const examKey = examReminderKey(exam, 'start', 1440, at(`2026-11-13T12:00:00${TZ}`));
    expect(hwKey).not.toBe(examKey);
    // 前缀也不得互相包含（clearRemindersForItem 依赖这一点）
    expect(hwKey.startsWith(`${exam.id}:`)).toBe(false);
    expect(examKey.startsWith(`${hw.id}:`)).toBe(false);
  });
});

describe('examPhase —— 阶段推导（不依赖平台 examState）', () => {
  const x = mkExam();

  it('未到开考 => upcoming', () => {
    expect(examPhase(x, at(`2026-11-13T10:00:00${TZ}`))).toBe('upcoming');
  });

  it('已开考未结束 => ongoing（这段绝不能被「隐藏已截止」误伤）', () => {
    expect(examPhase(x, at(`2026-11-13T13:00:00${TZ}`))).toBe('ongoing');
  });

  it('已过结束 => ended', () => {
    expect(examPhase(x, at(`2026-11-13T15:00:00${TZ}`))).toBe('ended');
  });

  it('开考时间未知 => unknown', () => {
    expect(examPhase(mkExam({ startsAt: null, timePrecision: 'none' }), NOW)).toBe('unknown');
  });

  it('结束时间未知但已开考 => ongoing（保守，不谎称已结束）', () => {
    expect(examPhase(mkExam({ endsAt: null }), at(`2026-11-13T13:00:00${TZ}`))).toBe('ongoing');
  });
});

describe('考试文案 —— 绝不能写成「作业即将截止」', () => {
  it('提前 1 天：标题含「考试」，不含「作业」', () => {
    const out = planReminders([mkExam()], mkCtx());
    const t = reminderText(out[0]!);
    expect(t.title).toContain('考试');
    expect(t.title).not.toContain('作业');
    expect(t.body).not.toContain('截止');
  });

  it('开考瞬间：标题为「考试已开始」', () => {
    const out = planReminders(
      [mkExam()],
      mkCtx({ nowMs: at(`2026-11-13T12:00:00${TZ}`) }),
    );
    const zero = out.find((r) => r.thresholdMinutes === 0)!;
    const t = reminderText(zero);
    expect(t.title).toBe('考试已开始');
  });

  it('考试文案不出现「未参加」「未提交」「已提交」', () => {
    const out = planReminders(
      [mkExam()],
      mkCtx({ nowMs: at(`2026-11-13T12:00:00${TZ}`) }),
    );
    for (const r of out) {
      const t = reminderText(r);
      const all = `${t.title} ${t.body}`;
      expect(all).not.toContain('未参加');
      expect(all).not.toContain('未提交');
      expect(all).not.toContain('已提交');
    }
  });
});

describe('作业与考试混合规划', () => {
  it('两类实体同时到期时都能各自产出提醒，互不干扰', () => {
    const hw = mkHomework(); // 距截止 24h，72h/24h 阈值已过
    const exam = mkExam(); // 距开考 24h，1440 分钟阈值已过
    const items: ListItem[] = [hw, exam];
    const out = planReminders(items, mkCtx({ thresholdsHours: [72, 24] }));
    expect(out.some((r) => r.kind === 'homework')).toBe(true);
    expect(out.some((r) => r.kind === 'exam')).toBe(true);
  });

  it('已提交作业被抑制，但考试照常提醒', () => {
    const hw = mkHomework({ submissionStatus: 'submitted' });
    const exam = mkExam();
    const out = planReminders([hw, exam], mkCtx({ thresholdsHours: [72, 24] }));
    expect(out.every((r) => r.kind === 'exam')).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });
});
