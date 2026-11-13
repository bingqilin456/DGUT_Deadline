/**
 * 筛选/排序纯逻辑测试。
 *
 * 夹具说明：`mk()`（作业）与 `mkExam()`（考试）都是**合成数据**，
 * 不来自任何真实平台响应，仅用于验证纯逻辑分支。
 * 分类依据是夹具里显式写的 `kind`，与标题文字无关 —— 这正是产品的分类口径
 * （来源模块决定类型，不看标题里有没有「考试」二字）。
 */
import { describe, expect, it } from 'vitest';
import type { UiAssignment, UiExam, UiHomework } from '../../../shared/ipc';
import {
  DEFAULT_FILTER,
  applyFilter,
  collectCourses,
  countBy,
  isExpired,
  sortList,
  type FilterState,
} from './filter.js';

const TZ = '+08:00';
const NOW = Date.parse(`2026-11-08T10:00:00${TZ}`);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function mk(over: Partial<UiHomework> & { id: string }): UiHomework {
  return {
    kind: 'homework',
    source: 'hw',
    sourceAssignmentId: over.id,
    courseId: null,
    courseName: '数据库系统原理',
    title: `作业 ${over.id}`,
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
  } satisfies UiHomework;
}

/** 考试夹具。注意：`attendance` 只能是 'unknown'（一期硬约束）。 */
function mkExam(over: Partial<UiExam> & { id: string }): UiExam {
  return {
    kind: 'exam',
    source: 'ulearning',
    sourceAssignmentId: over.id,
    courseId: null,
    courseName: '数据库系统原理',
    title: `考试 ${over.id}`,
    detailUrl: null,
    firstSeenAt: '',
    lastSeenAt: '',
    lastSyncAt: '',
    sourceUpdatedAt: null,
    examId: `e-${over.id}`,
    startsAt: new Date(NOW + 2 * DAY).toISOString(),
    endsAt: new Date(NOW + 2 * DAY + 2 * HOUR).toISOString(),
    timePrecision: 'datetime',
    venue: null,
    attendance: 'unknown',
    attendanceEvidence: '列表接口未提供可信的参加状态字段（未验证）',
    sourceLabel: '优学院 LMS',
    overridden: false,
    ...over,
  } satisfies UiExam;
}

function f(over: Partial<FilterState> = {}): FilterState {
  return { ...DEFAULT_FILTER, ...over };
}

function ids(list: readonly UiAssignment[]): string[] {
  return list.map((a) => a.id);
}

describe('isExpired', () => {
  it('过去时间算已截止', () => {
    expect(isExpired(mk({ id: '1', dueAt: new Date(NOW - HOUR).toISOString() }), NOW)).toBe(true);
  });
  it('未来时间不算已截止', () => {
    expect(isExpired(mk({ id: '2', dueAt: new Date(NOW + HOUR).toISOString() }), NOW)).toBe(false);
  });
  it('无截止时间不算已截止', () => {
    expect(isExpired(mk({ id: '3', dueAt: null }), NOW)).toBe(false);
  });
  it('考试按 endsAt 判定：已开考未结束不算过期', () => {
    const x = mkExam({
      id: 'x1',
      startsAt: new Date(NOW - HOUR).toISOString(),
      endsAt: new Date(NOW + HOUR).toISOString(),
    });
    expect(isExpired(x, NOW)).toBe(false);
  });
  it('考试按 endsAt 判定：结束时间已过算过期', () => {
    const x = mkExam({
      id: 'x2',
      startsAt: new Date(NOW - 3 * HOUR).toISOString(),
      endsAt: new Date(NOW - HOUR).toISOString(),
    });
    expect(isExpired(x, NOW)).toBe(true);
  });
  it('考试 endsAt 缺失时退化用 startsAt', () => {
    const x = mkExam({ id: 'x3', startsAt: new Date(NOW - HOUR).toISOString(), endsAt: null });
    expect(isExpired(x, NOW)).toBe(true);
  });
  it('考试时间完全未知不算过期（不假装已结束）', () => {
    const x = mkExam({ id: 'x4', startsAt: null, endsAt: null, timePrecision: 'none' });
    expect(isExpired(x, NOW)).toBe(false);
  });
});

describe('默认筛选：只看未过期 + 时间最近在前', () => {
  const list: UiHomework[] = [
    mk({ id: 'past', dueAt: new Date(NOW - DAY).toISOString() }),
    mk({ id: 'far', dueAt: new Date(NOW + 10 * DAY).toISOString() }),
    mk({ id: 'near', dueAt: new Date(NOW + 2 * HOUR).toISOString() }),
    mk({ id: 'mid', dueAt: new Date(NOW + 2 * DAY).toISOString() }),
  ];

  it('默认隐藏已截止作业', () => {
    const r = applyFilter(list, DEFAULT_FILTER, NOW);
    expect(ids(r)).not.toContain('past');
  });

  it('默认按截止时间升序（最近的在前）', () => {
    const r = applyFilter(list, DEFAULT_FILTER, NOW);
    expect(ids(r)).toEqual(['near', 'mid', 'far']);
  });

  it('默认不隐藏时可以看到全部', () => {
    const r = applyFilter(list, f({ hideExpired: false }), NOW);
    expect(ids(r)).toContain('past');
  });
});

describe('平台筛选', () => {
  const list: UiHomework[] = [
    mk({ id: 'h1', source: 'hw' }),
    mk({ id: 'u1', source: 'ulearning' }),
    mk({ id: 'u2', source: 'ulearning' }),
  ];

  it('筛选 hw', () => {
    expect(ids(applyFilter(list, f({ source: 'hw' }), NOW))).toEqual(['h1']);
  });

  it('筛选 ulearning', () => {
    expect(ids(applyFilter(list, f({ source: 'ulearning' }), NOW))).toEqual(['u1', 'u2']);
  });

  it('all 不筛选', () => {
    expect(applyFilter(list, f({ source: 'all' }), NOW)).toHaveLength(3);
  });
});

describe('课程筛选', () => {
  const list: UiHomework[] = [
    mk({ id: 'a', courseName: '数据库系统原理' }),
    mk({ id: 'b', courseName: '数字逻辑' }),
    mk({ id: 'c', courseName: '数字逻辑' }),
  ];

  it('按课程精确筛选', () => {
    const r = applyFilter(list, f({ course: '数字逻辑' }), NOW);
    expect(ids(r)).toEqual(['b', 'c']);
  });

  it('collectCourses 去重，并按中文拼音排序', () => {
    // localeCompare('zh-CN') 按拼音：数据库(shujuku) < 数字逻辑(shuziluoji)
    const c = collectCourses(list);
    expect(c).toHaveLength(2);
    expect(c).toEqual(expect.arrayContaining(['数字逻辑', '数据库系统原理']));
  });

  it('collectCourses 忽略空课程名', () => {
    const l = [mk({ id: 'x', courseName: null }), mk({ id: 'y', courseName: '  ' }), mk({ id: 'z', courseName: '政治' })];
    expect(collectCourses(l)).toEqual(['政治']);
  });
});

describe('截止时间范围筛选', () => {
  const list: UiHomework[] = [
    mk({ id: 'over', dueAt: new Date(NOW - HOUR).toISOString() }),
    mk({ id: 'h5', dueAt: new Date(NOW + 5 * HOUR).toISOString() }),
    mk({ id: 'd2', dueAt: new Date(NOW + 2 * DAY).toISOString() }),
    mk({ id: 'd5', dueAt: new Date(NOW + 5 * DAY).toISOString() }),
    mk({ id: 'd20', dueAt: new Date(NOW + 20 * DAY).toISOString() }),
    mk({ id: 'none', dueAt: null }),
  ];
  const base = { hideExpired: false };

  it('today = 24 小时内', () => {
    const r = applyFilter(list, f({ ...base, dueRange: 'today' }), NOW);
    expect(ids(r)).toEqual(['h5']);
  });

  it('3d = 3 天内', () => {
    const r = applyFilter(list, f({ ...base, dueRange: '3d' }), NOW);
    expect(ids(r).sort()).toEqual(['d2', 'h5']);
  });

  it('7d = 7 天内', () => {
    const r = applyFilter(list, f({ ...base, dueRange: '7d' }), NOW);
    expect(ids(r).sort()).toEqual(['d2', 'd5', 'h5']);
  });

  it('overdue 只看已截止', () => {
    const r = applyFilter(list, f({ ...base, dueRange: 'overdue' }), NOW);
    expect(ids(r)).toEqual(['over']);
  });

  it('unknown 只看无截止时间', () => {
    const r = applyFilter(list, f({ ...base, dueRange: 'unknown' }), NOW);
    expect(ids(r)).toEqual(['none']);
  });

  it('默认隐藏已截止时，overdue 选项仍能看到已截止（互斥由 UI 处理）', () => {
    // hideExpired 优先，因此这里显式关闭
    const r = applyFilter(list, f({ hideExpired: true, dueRange: 'overdue' }), NOW);
    expect(r).toHaveLength(0);
  });
});

describe('剩余时间范围筛选', () => {
  const list: UiHomework[] = [
    mk({ id: 'h1', dueAt: new Date(NOW + 1 * HOUR).toISOString() }),
    mk({ id: 'h10', dueAt: new Date(NOW + 10 * HOUR).toISOString() }),
    mk({ id: 'd2', dueAt: new Date(NOW + 2 * DAY).toISOString() }),
    mk({ id: 'd5', dueAt: new Date(NOW + 5 * DAY).toISOString() }),
    mk({ id: 'none', dueAt: null }),
  ];

  it('3h 内', () => {
    expect(ids(applyFilter(list, f({ remainRange: '3h' }), NOW))).toEqual(['h1']);
  });
  it('24h 内', () => {
    expect(ids(applyFilter(list, f({ remainRange: '24h' }), NOW)).sort()).toEqual(['h1', 'h10']);
  });
  it('72h 内', () => {
    expect(ids(applyFilter(list, f({ remainRange: '72h' }), NOW)).sort()).toEqual(['d2', 'h1', 'h10']);
  });
  it('none 只选无截止时间', () => {
    expect(ids(applyFilter(list, f({ remainRange: 'none' }), NOW))).toEqual(['none']);
  });
});

describe('状态筛选', () => {
  const list: UiHomework[] = [
    mk({ id: 'sub', submissionStatus: 'submitted' }),
    mk({ id: 'not', submissionStatus: 'not_submitted' }),
    mk({ id: 'unk', submissionStatus: 'unknown' }),
    mk({ id: 'over', submissionStatus: 'not_submitted', dueAt: new Date(NOW - DAY).toISOString() }),
  ];

  it('只看未提交', () => {
    const r = applyFilter(list, f({ status: 'not_submitted', hideExpired: false }), NOW);
    expect(ids(r).sort()).toEqual(['not', 'over']);
  });

  it('只看已提交', () => {
    expect(ids(applyFilter(list, f({ status: 'submitted' }), NOW))).toEqual(['sub']);
  });

  it('只看状态未知', () => {
    expect(ids(applyFilter(list, f({ status: 'unknown' }), NOW))).toEqual(['unk']);
  });

  it('只看已截止', () => {
    const r = applyFilter(list, f({ status: 'overdue', hideExpired: false }), NOW);
    expect(ids(r)).toEqual(['over']);
  });
});

describe('关键字搜索', () => {
  const list: UiHomework[] = [
    mk({ id: 'a', title: '第五章、第六章作业', courseName: '概率论与数理统计' }),
    mk({ id: 'b', title: '实验5', courseName: '面向对象程序设计(Java)' }),
  ];

  it('匹配标题', () => {
    expect(ids(applyFilter(list, f({ keyword: '第五章' }), NOW))).toEqual(['a']);
  });

  it('匹配课程名', () => {
    expect(ids(applyFilter(list, f({ keyword: 'Java' }), NOW))).toEqual(['b']);
  });

  it('大小写不敏感', () => {
    expect(ids(applyFilter(list, f({ keyword: 'java' }), NOW))).toEqual(['b']);
  });

  it('空关键字不筛选', () => {
    expect(applyFilter(list, f({ keyword: '   ' }), NOW)).toHaveLength(2);
  });
});

describe('排序', () => {
  const list: UiHomework[] = [
    mk({ id: 'd3', dueAt: new Date(NOW + 3 * DAY).toISOString(), courseName: 'B' }),
    mk({ id: 'd1', dueAt: new Date(NOW + 1 * DAY).toISOString(), courseName: 'A' }),
    mk({ id: 'dn', dueAt: null, courseName: 'C' }),
  ];

  it('dueAsc：最近的在前，无截止时间置底', () => {
    expect(ids(sortList(list, 'dueAsc', NOW))).toEqual(['d1', 'd3', 'dn']);
  });

  it('dueDesc：最远的在前', () => {
    expect(ids(sortList(list, 'dueDesc', NOW))).toEqual(['dn', 'd3', 'd1']);
  });

  it('course：按课程名排序，同课程按截止时间', () => {
    expect(ids(sortList(list, 'course', NOW))).toEqual(['d1', 'd3', 'dn']);
  });
});

describe('组合筛选', () => {
  it('平台 + 课程 + 未截止', () => {
    const list: UiHomework[] = [
      mk({ id: '1', source: 'ulearning', courseName: 'Python', dueAt: new Date(NOW + DAY).toISOString() }),
      mk({ id: '2', source: 'ulearning', courseName: 'Python', dueAt: new Date(NOW - DAY).toISOString() }),
      mk({ id: '3', source: 'hw', courseName: 'Python', dueAt: new Date(NOW + DAY).toISOString() }),
      mk({ id: '4', source: 'ulearning', courseName: '数学', dueAt: new Date(NOW + DAY).toISOString() }),
    ];
    const r = applyFilter(list, f({ source: 'ulearning', course: 'Python' }), NOW);
    expect(ids(r)).toEqual(['1']);
  });
});

describe('countBy 统计', () => {
  it('正确统计各分类数量', () => {
    const list: UiHomework[] = [
      mk({ id: '1', dueAt: new Date(NOW + DAY).toISOString() }), // 未截止 + 默认未提交
      mk({ id: '2', dueAt: new Date(NOW - DAY).toISOString() }), // 已截止 + 未提交
      mk({ id: '3', submissionStatus: 'submitted' }), // 未截止 + 已提交
      mk({ id: '4', submissionStatus: 'not_submitted' }), // 未截止 + 未提交
    ];
    const c = countBy(list, NOW);
    expect(c.all).toBe(4);
    expect(c.upcoming).toBe(3);
    expect(c.overdue).toBe(1);
    expect(c.submitted).toBe(1);
    // 1、2、4 都是 not_submitted
    expect(c.notSubmitted).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 新增：类型（kind）维度 + 考试行语义
// ══════════════════════════════════════════════════════════════════════

describe('类型筛选', () => {
  const list: UiAssignment[] = [
    mk({ id: 'h1' }),
    mk({ id: 'h2' }),
    mkExam({ id: 'x1' }),
    mkExam({ id: 'x2' }),
  ];

  it('kind=all 混排返回全部', () => {
    expect(applyFilter(list, f({ kind: 'all' }), NOW)).toHaveLength(4);
  });

  it('kind=homework 只返回作业', () => {
    const r = applyFilter(list, f({ kind: 'homework' }), NOW);
    expect(ids(r)).toEqual(['h1', 'h2']);
    expect(r.every((i) => i.kind === 'homework')).toBe(true);
  });

  it('kind=exam 只返回考试', () => {
    const r = applyFilter(list, f({ kind: 'exam' }), NOW);
    expect(ids(r)).toEqual(['x1', 'x2']);
    expect(r.every((i) => i.kind === 'exam')).toBe(true);
  });

  it('分类只看 kind，不看标题文字：标题含「考试」的作业仍属于作业', () => {
    // 用户口径：来自作业模块的条目，叫「期末考试」也是作业。夹具用标题模拟这种情形。
    const weird: UiAssignment[] = [
      mk({ id: 'w1', title: '期末考试（其实是作业模块里的条目）' }),
      mkExam({ id: 'w2', title: '第 3 次平时作业（其实是考试模块）' }),
    ];
    expect(ids(applyFilter(weird, f({ kind: 'homework' }), NOW))).toEqual(['w1']);
    expect(ids(applyFilter(weird, f({ kind: 'exam' }), NOW))).toEqual(['w2']);
  });
});

describe('考试与「隐藏已过期」', () => {
  it('进行中的考试不被默认 hideExpired 隐藏', () => {
    const x = mkExam({
      id: 'ongoing',
      startsAt: new Date(NOW - HOUR).toISOString(),
      endsAt: new Date(NOW + HOUR).toISOString(),
    });
    const r = applyFilter([x], DEFAULT_FILTER, NOW);
    expect(ids(r)).toEqual(['ongoing']);
  });

  it('已结束的考试被默认隐藏', () => {
    const x = mkExam({
      id: 'ended',
      startsAt: new Date(NOW - 3 * HOUR).toISOString(),
      endsAt: new Date(NOW - HOUR).toISOString(),
    });
    expect(applyFilter([x], DEFAULT_FILTER, NOW)).toHaveLength(0);
  });

  it('时间未知的考试不被隐藏（不能假装它已结束）', () => {
    const x = mkExam({ id: 'nostart', startsAt: null, endsAt: null, timePrecision: 'none' });
    expect(ids(applyFilter([x], DEFAULT_FILTER, NOW))).toEqual(['nostart']);
  });
});

describe('状态筛选对考试行', () => {
  const list: UiAssignment[] = [
    mk({ id: 'h-sub', submissionStatus: 'submitted' }),
    mk({ id: 'h-not', submissionStatus: 'not_submitted' }),
    mkExam({ id: 'x-unk', attendance: 'unknown' }),
    mkExam({ id: 'x-sub', attendance: 'submitted', answerTimes: 1, limitTimes: 2 }),
    mkExam({ id: 'x-not', attendance: 'not_submitted', answerTimes: 0, limitTimes: 1 }),
    mkExam({ id: 'x-ended', startsAt: new Date(NOW - 3 * HOUR).toISOString(), endsAt: new Date(NOW - HOUR).toISOString() }),
  ];

  it('status=submitted 命中已提交的作业与已交卷（attendance=submitted）的考试', () => {
    const r = applyFilter(list, f({ status: 'submitted', hideExpired: false }), NOW);
    expect(ids(r).sort()).toEqual(['h-sub', 'x-sub']);
  });

  it('status=not_submitted 命中未提交的作业与未交卷（attendance=not_submitted）的考试', () => {
    const r = applyFilter(list, f({ status: 'not_submitted', hideExpired: false }), NOW);
    expect(ids(r).sort()).toEqual(['h-not', 'x-not']);
  });

  it('status=unknown 命中参加状态未知的考试与状态未知的作业', () => {
    const withUnknown: UiAssignment[] = [
      mk({ id: 'h-unk', submissionStatus: 'unknown' }),
      mkExam({ id: 'x-2', attendance: 'unknown' }),
      mkExam({ id: 'x-sub', attendance: 'submitted' }),
    ];
    expect(ids(applyFilter(withUnknown, f({ status: 'unknown' }), NOW)).sort()).toEqual(['h-unk', 'x-2']);
  });

  it('status=overdue 命中已结束的考试（按 endsAt）', () => {
    const r = applyFilter(list, f({ status: 'overdue', hideExpired: false }), NOW);
    expect(ids(r)).toEqual(['x-ended']);
  });

  it('考试行的类型上没有 submissionStatus 字段（编译期防伪造）', () => {
    const x = mkExam({ id: 'x-3' });
    // @ts-expect-error 考试实体物理上不存在提交状态，访问即类型错误（红线 3 的编译期保护）
    void x.submissionStatus;
    expect(x.attendance).toBe('unknown');
  });
});

describe('混合排序（统一按结束时刻）', () => {
  it('作业按 dueAt、考试按 endsAt 混排', () => {
    const list: UiAssignment[] = [
      mk({ id: 'hw-3d', dueAt: new Date(NOW + 3 * DAY).toISOString() }),
      mkExam({ id: 'ex-1d', startsAt: new Date(NOW + DAY).toISOString(), endsAt: new Date(NOW + DAY + HOUR).toISOString() }),
      mk({ id: 'hw-5h', dueAt: new Date(NOW + 5 * HOUR).toISOString() }),
      mkExam({ id: 'ex-2d', startsAt: new Date(NOW + 2 * DAY).toISOString(), endsAt: new Date(NOW + 2 * DAY + HOUR).toISOString() }),
    ];
    expect(ids(sortList(list, 'dueAsc', NOW))).toEqual(['hw-5h', 'ex-1d', 'ex-2d', 'hw-3d']);
  });

  /**
   * 2026-11-12 用户反馈的 bug：
   * 考试按**开考时间**排序，导致「开考早、结束晚」的考试排在「结束早」的前面。
   * 截图里就是：开考 11/2 结束 12/13 的排在最前，而结束 11/14 的排在后面。
   */
  it('考试按结束时间排，不按开考时间（用户报告的 bug）', () => {
    const list: UiAssignment[] = [
      // 开考早但结束晚 —— 旧实现会把它排第一（错）
      mkExam({
        id: 'ex-long',
        startsAt: new Date(NOW - 20 * DAY).toISOString(),
        endsAt: new Date(NOW + 31 * DAY).toISOString(),
      }),
      // 开考晚但马上就要结束 —— 必须排第一
      mkExam({
        id: 'ex-soon',
        startsAt: new Date(NOW - 1 * DAY).toISOString(),
        endsAt: new Date(NOW + 1 * DAY).toISOString(),
      }),
      mkExam({
        id: 'ex-mid',
        startsAt: new Date(NOW - 5 * DAY).toISOString(),
        endsAt: new Date(NOW + 3 * DAY).toISOString(),
      }),
    ];
    expect(ids(sortList(list, 'dueAsc', NOW))).toEqual(['ex-soon', 'ex-mid', 'ex-long']);
  });

  it('dueDesc 也按结束时间倒序', () => {
    const list: UiAssignment[] = [
      mkExam({ id: 'a', startsAt: new Date(NOW + DAY).toISOString(), endsAt: new Date(NOW + 2 * DAY).toISOString() }),
      mkExam({ id: 'b', startsAt: new Date(NOW + 5 * DAY).toISOString(), endsAt: new Date(NOW + 6 * DAY).toISOString() }),
    ];
    expect(ids(sortList(list, 'dueDesc', NOW))).toEqual(['b', 'a']);
  });

  it('考试缺 endsAt 时退化用 startsAt 排序（不扔到最后）', () => {
    const list: UiAssignment[] = [
      mkExam({ id: 'no-end', startsAt: new Date(NOW + HOUR).toISOString(), endsAt: null }),
      mkExam({ id: 'has-end', startsAt: new Date(NOW + 5 * DAY).toISOString(), endsAt: new Date(NOW + 5 * DAY).toISOString() }),
    ];
    // no-end 的结束时刻视为 startsAt（NOW+1h），应排在 has-end（+5d）之前
    expect(ids(sortList(list, 'dueAsc', NOW))).toEqual(['no-end', 'has-end']);
  });

  it('无任何时间的考试置底', () => {
    const list: UiAssignment[] = [
      mkExam({ id: 'ex-nostart', startsAt: null, endsAt: null, timePrecision: 'none' }),
      mk({ id: 'hw-1d', dueAt: new Date(NOW + DAY).toISOString() }),
    ];
    expect(ids(sortList(list, 'dueAsc', NOW))).toEqual(['hw-1d', 'ex-nostart']);
    expect(ids(sortList(list, 'remaining', NOW))).toEqual(['hw-1d', 'ex-nostart']);
  });

  it('考试剩余范围按「距开考」计算', () => {
    const list: UiAssignment[] = [
      mkExam({ id: 'ex-2h', startsAt: new Date(NOW + 2 * HOUR).toISOString(), endsAt: new Date(NOW + 4 * HOUR).toISOString() }),
      mkExam({ id: 'ex-3d', startsAt: new Date(NOW + 3 * DAY).toISOString(), endsAt: new Date(NOW + 3 * DAY + HOUR).toISOString() }),
    ];
    expect(ids(applyFilter(list, f({ remainRange: '3h', kind: 'exam' }), NOW))).toEqual(['ex-2h']);
  });

  it('考试「今天内」按开考时间算', () => {
    const list: UiAssignment[] = [
      mkExam({ id: 'ex-today', startsAt: new Date(NOW + 2 * HOUR).toISOString(), endsAt: new Date(NOW + 4 * HOUR).toISOString() }),
      mkExam({ id: 'ex-far', startsAt: new Date(NOW + 5 * DAY).toISOString(), endsAt: new Date(NOW + 5 * DAY + HOUR).toISOString() }),
    ];
    expect(ids(applyFilter(list, f({ dueRange: 'today', kind: 'exam' }), NOW))).toEqual(['ex-today']);
  });
});

describe('countBy 按类型计数', () => {
  it('分别统计作业与考试，且考试不参与提交状态统计', () => {
    const list: UiAssignment[] = [
      mk({ id: 'h1', submissionStatus: 'submitted' }),
      mk({ id: 'h2', submissionStatus: 'not_submitted' }),
      mk({ id: 'h3', submissionStatus: 'not_submitted', dueAt: new Date(NOW - DAY).toISOString() }),
      mkExam({ id: 'x1' }),
      mkExam({ id: 'x2', startsAt: new Date(NOW - 3 * HOUR).toISOString(), endsAt: new Date(NOW - HOUR).toISOString() }),
    ];
    const c = countBy(list, NOW);
    expect(c.all).toBe(5);
    expect(c.homework).toBe(3);
    expect(c.exam).toBe(2);
    expect(c.overdue).toBe(2); // h3 + x2
    expect(c.upcoming).toBe(3);
    // 考试既不算已提交也不算未提交
    expect(c.submitted).toBe(1);
    expect(c.notSubmitted).toBe(2);
  });

  it('只有考试时提交状态计数为 0', () => {
    const c = countBy([mkExam({ id: 'x1' })], NOW);
    expect(c).toMatchObject({ all: 1, homework: 0, exam: 1, submitted: 0, notSubmitted: 0 });
  });
});
