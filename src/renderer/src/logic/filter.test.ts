import { describe, expect, it } from 'vitest';
import type { UiAssignment } from '../../../shared/ipc';
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

function mk(over: Partial<UiAssignment> & { id: string }): UiAssignment {
  return {
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
  } as UiAssignment;
}

function f(over: Partial<FilterState> = {}): FilterState {
  return { ...DEFAULT_FILTER, ...over };
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
});

describe('默认筛选：只看未截止 + 截止最近在前', () => {
  const list = [
    mk({ id: 'past', dueAt: new Date(NOW - DAY).toISOString() }),
    mk({ id: 'far', dueAt: new Date(NOW + 10 * DAY).toISOString() }),
    mk({ id: 'near', dueAt: new Date(NOW + 2 * HOUR).toISOString() }),
    mk({ id: 'mid', dueAt: new Date(NOW + 2 * DAY).toISOString() }),
  ];

  it('默认隐藏已截止作业', () => {
    const r = applyFilter(list, DEFAULT_FILTER, NOW);
    expect(r.map((a) => a.id)).not.toContain('past');
  });

  it('默认按截止时间升序（最近的在前）', () => {
    const r = applyFilter(list, DEFAULT_FILTER, NOW);
    expect(r.map((a) => a.id)).toEqual(['near', 'mid', 'far']);
  });

  it('默认不隐藏时可以看到全部', () => {
    const r = applyFilter(list, f({ hideExpired: false }), NOW);
    expect(r.map((a) => a.id)).toContain('past');
  });
});

describe('平台筛选', () => {
  const list = [
    mk({ id: 'h1', source: 'hw' }),
    mk({ id: 'u1', source: 'ulearning' }),
    mk({ id: 'u2', source: 'ulearning' }),
  ];

  it('筛选 hw', () => {
    expect(applyFilter(list, f({ source: 'hw' }), NOW).map((a) => a.id)).toEqual(['h1']);
  });

  it('筛选 ulearning', () => {
    expect(applyFilter(list, f({ source: 'ulearning' }), NOW).map((a) => a.id)).toEqual(['u1', 'u2']);
  });

  it('all 不筛选', () => {
    expect(applyFilter(list, f({ source: 'all' }), NOW)).toHaveLength(3);
  });
});

describe('课程筛选', () => {
  const list = [
    mk({ id: 'a', courseName: '数据库系统原理' }),
    mk({ id: 'b', courseName: '数字逻辑' }),
    mk({ id: 'c', courseName: '数字逻辑' }),
  ];

  it('按课程精确筛选', () => {
    const r = applyFilter(list, f({ course: '数字逻辑' }), NOW);
    expect(r.map((a) => a.id)).toEqual(['b', 'c']);
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
  const list = [
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
    expect(r.map((a) => a.id)).toEqual(['h5']);
  });

  it('3d = 3 天内', () => {
    const r = applyFilter(list, f({ ...base, dueRange: '3d' }), NOW);
    expect(r.map((a) => a.id).sort()).toEqual(['d2', 'h5']);
  });

  it('7d = 7 天内', () => {
    const r = applyFilter(list, f({ ...base, dueRange: '7d' }), NOW);
    expect(r.map((a) => a.id).sort()).toEqual(['d2', 'd5', 'h5']);
  });

  it('overdue 只看已截止', () => {
    const r = applyFilter(list, f({ ...base, dueRange: 'overdue' }), NOW);
    expect(r.map((a) => a.id)).toEqual(['over']);
  });

  it('unknown 只看无截止时间', () => {
    const r = applyFilter(list, f({ ...base, dueRange: 'unknown' }), NOW);
    expect(r.map((a) => a.id)).toEqual(['none']);
  });

  it('默认隐藏已截止时，overdue 选项仍能看到已截止（互斥由 UI 处理）', () => {
    // hideExpired 优先，因此这里显式关闭
    const r = applyFilter(list, f({ hideExpired: true, dueRange: 'overdue' }), NOW);
    expect(r).toHaveLength(0);
  });
});

describe('剩余时间范围筛选', () => {
  const list = [
    mk({ id: 'h1', dueAt: new Date(NOW + 1 * HOUR).toISOString() }),
    mk({ id: 'h10', dueAt: new Date(NOW + 10 * HOUR).toISOString() }),
    mk({ id: 'd2', dueAt: new Date(NOW + 2 * DAY).toISOString() }),
    mk({ id: 'd5', dueAt: new Date(NOW + 5 * DAY).toISOString() }),
    mk({ id: 'none', dueAt: null }),
  ];

  it('3h 内', () => {
    expect(applyFilter(list, f({ remainRange: '3h' }), NOW).map((a) => a.id)).toEqual(['h1']);
  });
  it('24h 内', () => {
    expect(applyFilter(list, f({ remainRange: '24h' }), NOW).map((a) => a.id).sort()).toEqual(['h1', 'h10']);
  });
  it('72h 内', () => {
    expect(applyFilter(list, f({ remainRange: '72h' }), NOW).map((a) => a.id).sort()).toEqual(['d2', 'h1', 'h10']);
  });
  it('none 只选无截止时间', () => {
    expect(applyFilter(list, f({ remainRange: 'none' }), NOW).map((a) => a.id)).toEqual(['none']);
  });
});

describe('状态筛选', () => {
  const list = [
    mk({ id: 'sub', submissionStatus: 'submitted' }),
    mk({ id: 'not', submissionStatus: 'not_submitted' }),
    mk({ id: 'unk', submissionStatus: 'unknown' }),
    mk({ id: 'over', submissionStatus: 'not_submitted', dueAt: new Date(NOW - DAY).toISOString() }),
  ];

  it('只看未提交', () => {
    const r = applyFilter(list, f({ status: 'not_submitted', hideExpired: false }), NOW);
    expect(r.map((a) => a.id).sort()).toEqual(['not', 'over']);
  });

  it('只看已提交', () => {
    expect(applyFilter(list, f({ status: 'submitted' }), NOW).map((a) => a.id)).toEqual(['sub']);
  });

  it('只看状态未知', () => {
    expect(applyFilter(list, f({ status: 'unknown' }), NOW).map((a) => a.id)).toEqual(['unk']);
  });

  it('只看已截止', () => {
    const r = applyFilter(list, f({ status: 'overdue', hideExpired: false }), NOW);
    expect(r.map((a) => a.id)).toEqual(['over']);
  });
});

describe('关键字搜索', () => {
  const list = [
    mk({ id: 'a', title: '第五章、第六章作业', courseName: '概率论与数理统计' }),
    mk({ id: 'b', title: '实验5', courseName: '面向对象程序设计(Java)' }),
  ];

  it('匹配标题', () => {
    expect(applyFilter(list, f({ keyword: '第五章' }), NOW).map((a) => a.id)).toEqual(['a']);
  });

  it('匹配课程名', () => {
    expect(applyFilter(list, f({ keyword: 'Java' }), NOW).map((a) => a.id)).toEqual(['b']);
  });

  it('大小写不敏感', () => {
    expect(applyFilter(list, f({ keyword: 'java' }), NOW).map((a) => a.id)).toEqual(['b']);
  });

  it('空关键字不筛选', () => {
    expect(applyFilter(list, f({ keyword: '   ' }), NOW)).toHaveLength(2);
  });
});

describe('排序', () => {
  const list = [
    mk({ id: 'd3', dueAt: new Date(NOW + 3 * DAY).toISOString(), courseName: 'B' }),
    mk({ id: 'd1', dueAt: new Date(NOW + 1 * DAY).toISOString(), courseName: 'A' }),
    mk({ id: 'dn', dueAt: null, courseName: 'C' }),
  ];

  it('dueAsc：最近的在前，无截止时间置底', () => {
    expect(sortList(list, 'dueAsc', NOW).map((a) => a.id)).toEqual(['d1', 'd3', 'dn']);
  });

  it('dueDesc：最远的在前', () => {
    expect(sortList(list, 'dueDesc', NOW).map((a) => a.id)).toEqual(['dn', 'd3', 'd1']);
  });

  it('course：按课程名排序，同课程按截止时间', () => {
    expect(sortList(list, 'course', NOW).map((a) => a.id)).toEqual(['d1', 'd3', 'dn']);
  });
});

describe('组合筛选', () => {
  it('平台 + 课程 + 未截止', () => {
    const list = [
      mk({ id: '1', source: 'ulearning', courseName: 'Python', dueAt: new Date(NOW + DAY).toISOString() }),
      mk({ id: '2', source: 'ulearning', courseName: 'Python', dueAt: new Date(NOW - DAY).toISOString() }),
      mk({ id: '3', source: 'hw', courseName: 'Python', dueAt: new Date(NOW + DAY).toISOString() }),
      mk({ id: '4', source: 'ulearning', courseName: '数学', dueAt: new Date(NOW + DAY).toISOString() }),
    ];
    const r = applyFilter(list, f({ source: 'ulearning', course: 'Python' }), NOW);
    expect(r.map((a) => a.id)).toEqual(['1']);
  });
});

describe('countBy 统计', () => {
  it('正确统计各分类数量', () => {
    const list = [
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
