/**
 * 表现层文案/徽标测试（纯逻辑）。
 *
 * 重点是**红线断言**：考试行的状态列不得出现「未参加」「未提交」「已提交」。
 * 夹具是合成数据，不代表任何真实平台响应。
 */
import { describe, expect, it } from 'vitest';
import { examPhase as sharedExamPhase } from '@dgut-deadline/shared';
import type { UiExam, UiHomework } from '../../../shared/ipc';
import {
  attendanceBadge,
  examPhase,
  formatWhen,
  kindBadge,
  remainingCell,
  rowClass,
  statusCell,
  timeCell,
} from './item-view.js';

const TZ = '+08:00';
const NOW = Date.parse(`2026-11-08T10:00:00${TZ}`);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function hw(over: Partial<UiHomework> = {}): UiHomework {
  return {
    kind: 'homework',
    source: 'hw',
    sourceAssignmentId: 'h1',
    id: 'h1',
    courseId: null,
    courseName: '数据库系统原理',
    title: '第五章作业',
    detailUrl: null,
    dueAt: new Date(NOW + 2 * DAY).toISOString(),
    duePrecision: 'datetime',
    submissionStatus: 'not_submitted',
    statusEvidence: 'test',
    firstSeenAt: '',
    lastSeenAt: '',
    lastSyncAt: '',
    sourceUpdatedAt: null,
    sourceLabel: '作业平台',
    overridden: false,
    ...over,
  };
}

function exam(over: Partial<UiExam> = {}): UiExam {
  return {
    kind: 'exam',
    source: 'ulearning',
    sourceAssignmentId: 'exam:500750@1',
    id: 'ulearning:exam:500750@1',
    courseId: null,
    courseName: '数据库系统原理',
    title: '期末考试',
    detailUrl: null,
    firstSeenAt: '',
    lastSeenAt: '',
    lastSyncAt: '',
    sourceUpdatedAt: null,
    examId: '500750',
    startsAt: new Date(NOW + 2 * DAY).toISOString(),
    endsAt: new Date(NOW + 2 * DAY + 2 * HOUR).toISOString(),
    timePrecision: 'datetime',
    venue: null,
    attendance: 'unknown',
    attendanceEvidence: '未验证',
    sourceLabel: '优学院 LMS',
    overridden: false,
    ...over,
  };
}

describe('examPhase', () => {
  it('开考之前 = upcoming', () => {
    expect(examPhase(exam({ startsAt: new Date(NOW + HOUR).toISOString() }), NOW)).toBe('upcoming');
  });
  it('已开考未结束 = ongoing', () => {
    expect(
      examPhase(
        exam({ startsAt: new Date(NOW - HOUR).toISOString(), endsAt: new Date(NOW + HOUR).toISOString() }),
        NOW,
      ),
    ).toBe('ongoing');
  });
  it('已结束 = ended', () => {
    expect(
      examPhase(
        exam({ startsAt: new Date(NOW - 3 * HOUR).toISOString(), endsAt: new Date(NOW - HOUR).toISOString() }),
        NOW,
      ),
    ).toBe('ended');
  });
  it('无开始时间 = unknown', () => {
    expect(examPhase(exam({ startsAt: null, endsAt: null, timePrecision: 'none' }), NOW)).toBe('unknown');
  });
  it('无结束时间但已过开考 = ongoing（保守，不谎称已结束）', () => {
    expect(examPhase(exam({ startsAt: new Date(NOW - HOUR).toISOString(), endsAt: null }), NOW)).toBe('ongoing');
  });
  it('只在开考瞬间（恰好等于 now）= ongoing', () => {
    expect(examPhase(exam({ startsAt: new Date(NOW).toISOString(), endsAt: new Date(NOW + HOUR).toISOString() }), NOW)).toBe('ongoing');
  });
});

describe('kindBadge', () => {
  it('作业徽标为灰', () => {
    expect(kindBadge(hw())).toMatchObject({ text: '作业', cls: 'muted' });
  });
  it('考试徽标为强调色', () => {
    expect(kindBadge(exam())).toMatchObject({ text: '考试', cls: 'exam' });
  });
});

describe('timeCell', () => {
  it('作业只显示截止时间', () => {
    const c = timeCell(hw());
    expect(c.secondary).toBeNull();
    expect(c.ambiguous).toBe(false);
    expect(c.primary).toContain('2026');
  });
  it('作业只有日期时标注时间待确认', () => {
    const c = timeCell(hw({ duePrecision: 'date' }));
    expect(c.primary).toContain('时间待确认');
    expect(c.ambiguous).toBe(true);
  });
  it('作业无截止时间显示待确认', () => {
    expect(timeCell(hw({ dueAt: null }))).toMatchObject({ primary: '待确认', ambiguous: true });
  });
  it('考试显示开考 + 结束两行', () => {
    const c = timeCell(exam());
    expect(c.primary).toMatch(/^开考 /);
    expect(c.secondary).toMatch(/^结束 /);
  });
  it('考试结束时间未知显示「未提供」而不是瞎猜', () => {
    const c = timeCell(exam({ endsAt: null }));
    expect(c.secondary).toBe('结束时间未提供');
  });
  it('考试时间完全未知时两行都写「未提供」', () => {
    const c = timeCell(exam({ startsAt: null, endsAt: null, timePrecision: 'none' }));
    expect(c.primary).toBe('开考时间未提供');
    expect(c.secondary).toBe('结束时间未提供');
    expect(c.ambiguous).toBe(true);
  });
});

describe('remainingCell', () => {
  it('作业沿用 formatRemaining 文案', () => {
    expect(remainingCell(hw(), NOW).text).toMatch(/^剩 /);
  });
  it('考试未开始显示距开考', () => {
    expect(remainingCell(exam({ startsAt: new Date(NOW + 2 * HOUR).toISOString() }), NOW).text).toBe('距开考 2 小时 0 分');
  });
  it('考试进行中显示剩余', () => {
    const x = exam({
      startsAt: new Date(NOW - HOUR).toISOString(),
      endsAt: new Date(NOW + HOUR).toISOString(),
    });
    expect(remainingCell(x, NOW).text).toBe('进行中（剩 1 小时 0 分）');
  });
  it('考试进行中但结束未知：说明未知', () => {
    const x = exam({ startsAt: new Date(NOW - HOUR).toISOString(), endsAt: null });
    expect(remainingCell(x, NOW).text).toBe('进行中（结束时间未知）');
  });
  it('考试已结束显示已结束', () => {
    const x = exam({
      startsAt: new Date(NOW - 3 * HOUR).toISOString(),
      endsAt: new Date(NOW - HOUR).toISOString(),
    });
    expect(remainingCell(x, NOW).text).toBe('已结束');
  });
  it('考试无时间显示时间未知', () => {
    expect(remainingCell(exam({ startsAt: null, endsAt: null, timePrecision: 'none' }), NOW).text).toBe('时间未知');
  });
});

describe('statusCell —— 状态文案红线', () => {
  const forbidden = ['未参加', '未提交', '已提交'];

  function assertNoForbidden(text: string): void {
    for (const w of forbidden) expect(text).not.toContain(w);
  }

  it('考试各阶段的状态文案只在白名单内', () => {
    const allowed = new Set(['未知', '未开始', '进行中', '已结束', '时间未知']);
    const cases = [
      exam({ startsAt: new Date(NOW + DAY).toISOString() }),
      exam({ startsAt: new Date(NOW - HOUR).toISOString(), endsAt: new Date(NOW + HOUR).toISOString() }),
      exam({ startsAt: new Date(NOW - 3 * HOUR).toISOString(), endsAt: new Date(NOW - HOUR).toISOString() }),
      exam({ startsAt: null, endsAt: null, timePrecision: 'none' }),
      exam({ startsAt: new Date(NOW - HOUR).toISOString(), endsAt: null }),
    ];
    for (const x of cases) {
      const s = statusCell(x, NOW);
      expect(allowed.has(s.text)).toBe(true);
      assertNoForbidden(s.text);
      assertNoForbidden(s.title ?? '');
    }
  });

  it('考试未开始 = 未开始', () => {
    expect(statusCell(exam({ startsAt: new Date(NOW + DAY).toISOString() }), NOW).text).toBe('未开始');
  });
  it('考试进行中 = 进行中', () => {
    const x = exam({
      startsAt: new Date(NOW - HOUR).toISOString(),
      endsAt: new Date(NOW + HOUR).toISOString(),
    });
    expect(statusCell(x, NOW).text).toBe('进行中');
  });
  it('考试已结束 = 已结束', () => {
    const x = exam({
      startsAt: new Date(NOW - 3 * HOUR).toISOString(),
      endsAt: new Date(NOW - HOUR).toISOString(),
    });
    expect(statusCell(x, NOW).text).toBe('已结束');
  });
  it('考试无时间 = 时间未知', () => {
    expect(statusCell(exam({ startsAt: null, endsAt: null, timePrecision: 'none' }), NOW).text).toBe('时间未知');
  });

  it('作业状态文案保持改造前行为', () => {
    expect(statusCell(hw({ submissionStatus: 'submitted' }), NOW).text).toBe('已提交');
    expect(statusCell(hw({ submissionStatus: 'not_submitted' }), NOW).text).toBe('未提交');
    expect(statusCell(hw({ submissionStatus: 'unknown' }), NOW).text).toBe('状态待确认');
    expect(statusCell(hw({ submissionStatus: 'overdue' }), NOW).text).toBe('已逾期');
    expect(
      statusCell(hw({ submissionStatus: 'not_submitted', dueAt: new Date(NOW - HOUR).toISOString() }), NOW).text,
    ).toBe('已截止·未提交');
  });
});

describe('attendanceBadge', () => {
  it('已交卷且有限制次数与分数（如《3. 组合逻辑电路》1/2, 60分）=> 显示「已交卷 1/2」且悬停含得分', () => {
    const b = attendanceBadge(
      exam({
        attendance: 'submitted',
        answerTimes: 1,
        limitTimes: 2,
        score: 60,
        attendanceEvidence: 'answerTimes=1 limitTimes=2 score=60',
      }),
    );
    expect(b).toEqual({
      text: '已交卷 1/2',
      cls: 'ok',
      title: '得分：60 分（answerTimes=1 limitTimes=2 score=60）',
    });
  });

  it('已交卷但不限次数（limitTimes=null）=> 显示「已交卷 N次」', () => {
    const b = attendanceBadge(
      exam({
        attendance: 'submitted',
        answerTimes: 1,
        limitTimes: null,
        score: 90,
        attendanceEvidence: 'answerTimes=1 limitTimes=unlimited score=90',
      }),
    );
    expect(b?.text).toBe('已交卷 1次');
    expect(b?.cls).toBe('ok');
    expect(b?.title).toContain('90 分');
  });

  it('未交卷且有限制次数 => 显示「未交卷 0/1」', () => {
    const b = attendanceBadge(
      exam({
        attendance: 'not_submitted',
        answerTimes: 0,
        limitTimes: 1,
        score: null,
        attendanceEvidence: 'answerTimes=0 limitTimes=1',
      }),
    );
    expect(b).toEqual({
      text: '未交卷 0/1',
      cls: 'warn',
      title: '尚未交卷（answerTimes=0 limitTimes=1）',
    });
  });

  it('未交卷且不限次数 => 显示「未交卷」', () => {
    const b = attendanceBadge(
      exam({
        attendance: 'not_submitted',
        answerTimes: 0,
        limitTimes: null,
        score: null,
        attendanceEvidence: 'answerTimes=0 limitTimes=unlimited',
      }),
    );
    expect(b?.text).toBe('未交卷');
    expect(b?.cls).toBe('warn');
  });

  it('未知状态显示「参加状态未知」并解释原因', () => {
    const b = attendanceBadge(exam());
    expect(b?.text).toBe('参加状态未知');
    expect(b?.title).toContain('不做推断');
    expect(b?.text).not.toContain('未参加');
  });

  it('作业没有参加状态徽标', () => {
    expect(attendanceBadge(hw())).toBeNull();
  });
});

describe('rowClass', () => {
  it('考试行不复用作业样式', () => {
    const ongoing = rowClass(
      exam({ startsAt: new Date(NOW - HOUR).toISOString(), endsAt: new Date(NOW + HOUR).toISOString() }),
      NOW,
    );
    expect(ongoing).toBe('row-exam-ongoing');
    expect(ongoing).not.toContain('row-pending');
    expect(ongoing).not.toContain('row-submitted');
  });
  it('未开始/已结束的考试行样式', () => {
    expect(rowClass(exam({ startsAt: new Date(NOW + DAY).toISOString() }), NOW)).toBe('row-exam-upcoming');
    expect(
      rowClass(
        exam({ startsAt: new Date(NOW - 3 * HOUR).toISOString(), endsAt: new Date(NOW - HOUR).toISOString() }),
        NOW,
      ),
    ).toBe('row-exam-ended');
  });
  it('作业行样式保持改造前行为', () => {
    expect(rowClass(hw(), NOW)).toContain('row-pending');
    expect(rowClass(hw({ submissionStatus: 'submitted' }), NOW)).toContain('row-submitted');
    expect(rowClass(hw({ dueAt: new Date(NOW + HOUR).toISOString() }), NOW)).toContain('row-urgent');
    expect(rowClass(hw({ dueAt: new Date(NOW - HOUR).toISOString() }), NOW)).toContain('row-overdue');
  });
});

describe('formatWhen', () => {
  it('按 Asia/Shanghai 格式化（NOW 是 +08:00 的 10:00，与运行环境时区无关）', () => {
    expect(formatWhen(new Date(NOW).toISOString())).toBe('2026/11/8 10:00:00');
  });
  it('null / 非法值返回空串', () => {
    expect(formatWhen(null)).toBe('');
    expect(formatWhen('not-a-date')).toBe('');
  });

  /**
   * 防止 examPhase 又被拆成两份实现。
   *
   * 历史问题：渲染层与主进程各写一份语义等价的函数、靠注释约定同步。
   * 一旦一方改动就漂移，表现为「列表说进行中，提醒说已结束」。
   * 现在两边都从 packages/shared 取；这条断言把「同一个函数引用」固化住。
   */
  it('examPhase 与 packages/shared 的实现是同一个函数（防止再拆成两份）', () => {
    expect(examPhase).toBe(sharedExamPhase);
  });
});
