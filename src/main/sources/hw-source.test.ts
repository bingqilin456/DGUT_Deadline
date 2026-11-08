/**
 * hw 适配器归一化测试。
 *
 * 这些用例的期望值**直接来自 2026-11-08 真机采集的真实数据**
 * （investigation/evidence/real-plan.json、real-homework.json），
 * 不是凭想象编造的形状。
 * 公开仓库版本已脱敏教师姓名，上传记录 ID 替换为测试 ID，并省略个人成绩。
 */

import { describe, expect, it } from 'vitest';
import { HwAssignmentSource, type HwPlanRow, type HwUploadRow } from './hw-source.js';
import { parseDueAt } from '@dgut-deadline/shared';

function makeSource(): HwAssignmentSource {
  // userDataDir 仅用于构造，测试不启动浏览器
  return new HwAssignmentSource({ userDataDir: 'C:/tmp/test-profile', headless: true });
}

const SYNcedAt = '2026-11-08T00:30:00+08:00';

/** 真实行：数据库系统原理 / 作业三 SQL语言 / 未提交 / 有截止时间 */
const REAL_PLAN_UNSUBMITTED: HwPlanRow = {
  id: 5879,
  homeworkName: '作业三 SQL语言',
  description: '作业三 SQL语言',
  deadline: true,
  deadlineDate: '2026-11-22 23:00',
  scoreType: 'hundredMark',
  createTime: '2026-11-07 11:57',
  entityStatus: 'Enabled',
  teacherName: '[教师姓名已脱敏]',
  courseName: '数据库系统原理',
  homeworkType: '平时考核-平时作业',
  xn: 2026,
  xq: 0,
  submitted: false,
  homeworkId: null,
  markedStatus: null,
  completeWay: 'single',
  isResubmit: false,
  checkStatus: 'Disable',
} as HwPlanRow;

/** 脱敏真实行：面向对象程序设计(Java) / 实验4 / 已提交 / 已批阅 */
const REAL_PLAN_SUBMITTED: HwPlanRow = {
  id: 5841,
  homeworkName: '实验4',
  description: '实验4',
  deadline: true,
  deadlineDate: '2026-10-30 00:00',
  createTime: '2026-10-23 08:36',
  teacherName: '[教师姓名已脱敏]',
  courseName: '面向对象程序设计(Java)',
  xn: 2026,
  xq: 0,
  submitted: true,
  homeworkId: 900001,
  markedStatus: 'marked',
  completeWay: 'single',
  checkStatus: 'Disable',
} as HwPlanRow;

/** 真实行：上传记录（与 plan 5841 对应） */
const REAL_UPLOAD: HwUploadRow = {
  id: 900001,
  homeworkPlanId: 5841,
  homeworkName: '实验4',
  courseName: '面向对象程序设计(Java)',
  deadline: true,
  deadlineDate: '2026-10-30 00:00',
  uploadDate: '2026-10-26 20:47',
  fileName: '实验四实验报告.pdf',
  markedStatus: 'marked',
  completeWay: 'single',
  xn: 2026,
  xq: 0,
} as HwUploadRow;

describe('hw 归一化 —— 基于真实采集数据', () => {
  const src = makeSource();

  it('【关键】deadline 是布尔，deadlineDate 才是真实截止时间', () => {
    const a = src.normalize(5879, REAL_PLAN_UNSUBMITTED, undefined, SYNcedAt);
    expect(a).not.toBeNull();
    // 如果误把 deadline 当时间，dueAt 会是 null
    expect(a!.dueAt).toBe('2026-11-22T23:00:00+08:00');
    expect(a!.duePrecision).toBe('datetime');
  });

  it('未提交作业归一化为 not_submitted', () => {
    const a = src.normalize(5879, REAL_PLAN_UNSUBMITTED, undefined, SYNcedAt)!;
    expect(a.submissionStatus).toBe('not_submitted');
    expect(a.statusEvidence).toContain('plan.submitted=false');
  });

  it('已提交作业归一化为 submitted', () => {
    const a = src.normalize(5841, REAL_PLAN_SUBMITTED, REAL_UPLOAD, SYNcedAt)!;
    expect(a.submissionStatus).toBe('submitted');
    expect(a.statusEvidence).toContain('plan.submitted=true');
  });

  it('稳定键使用 plan 侧 id（两接口可合流）', () => {
    const a = src.normalize(5841, REAL_PLAN_SUBMITTED, REAL_UPLOAD, SYNcedAt)!;
    expect(a.sourceAssignmentId).toBe('5841');
    expect(a.id).toBe('hw:5841');
    // upload 的 homeworkPlanId=5841 与 plan 的 id 一致，所以能配对
    expect(REAL_UPLOAD.homeworkPlanId).toBe(REAL_PLAN_SUBMITTED.id);
  });

  it('标题、课程名原样保留（中文不乱码）', () => {
    const a = src.normalize(5879, REAL_PLAN_UNSUBMITTED, undefined, SYNcedAt)!;
    expect(a.title).toBe('作业三 SQL语言');
    expect(a.courseName).toBe('数据库系统原理');
  });

  it('详情链接通过 allowlist 校验', () => {
    const a = src.normalize(5879, REAL_PLAN_UNSUBMITTED, undefined, SYNcedAt)!;
    expect(a.detailUrl).toBe('https://hw.dgut.edu.cn/student/homeworkPlan');
  });
});

describe('hw 归一化 —— 边界与异常', () => {
  const src = makeSource();

  it('deadline=false 且无 deadlineDate => 截止时间未知，不猜测', () => {
    const row: HwPlanRow = {
      ...REAL_PLAN_UNSUBMITTED,
      id: 9999,
      deadline: false,
      deadlineDate: null,
    };
    const a = src.normalize(9999, row, undefined, SYNcedAt)!;
    expect(a.dueAt).toBeNull();
    expect(a.duePrecision).toBe('none');
    expect(a.statusEvidence).toContain('deadline=false');
  });

  it('标题为空的行被丢弃（返回 null），不产生空标题作业', () => {
    const row: HwPlanRow = { ...REAL_PLAN_UNSUBMITTED, id: 8888, homeworkName: '   ' };
    expect(src.normalize(8888, row, undefined, SYNcedAt)).toBeNull();
  });

  it('缺少 submitted 字段 => unknown，而不是默认未提交', () => {
    const row = { ...REAL_PLAN_UNSUBMITTED, id: 7777, submitted: undefined } as unknown as HwPlanRow;
    const a = src.normalize(7777, row, undefined, SYNcedAt)!;
    expect(a.submissionStatus).toBe('unknown');
    expect(a.statusEvidence).toContain('未返回 submitted');
  });

  it('submitted=null => unknown', () => {
    const row: HwPlanRow = { ...REAL_PLAN_UNSUBMITTED, id: 6666, submitted: null };
    const a = src.normalize(6666, row, undefined, SYNcedAt)!;
    expect(a.submissionStatus).toBe('unknown');
    expect(a.statusEvidence).toContain('null');
  });

  it('只有上传记录、缺少 plan 时能兜底，且 evidence 标明依据来源', () => {
    const a = src.normalize(5841, undefined, REAL_UPLOAD, SYNcedAt)!;
    expect(a.title).toBe('实验4');
    expect(a.submissionStatus).toBe('submitted');
    // 必须说明"依据上传记录"而不是空口断言已提交
    expect(a.statusEvidence).toContain('依据上传记录');
    expect(a.statusEvidence).toContain('upload.id=900001');
  });

  it('截止时间非法字符串 => 不猜测', () => {
    const row: HwPlanRow = { ...REAL_PLAN_UNSUBMITTED, id: 5555, deadlineDate: '另行通知' };
    const a = src.normalize(5555, row, undefined, SYNcedAt)!;
    expect(a.dueAt).toBeNull();
    expect(a.duePrecision).toBe('none');
  });
});

describe('真实数据的截止时间全部可解析', () => {
  // 直接取自真机采集的 10 条 deadlineDate
  const REAL_DEADLINES = [
    '2026-11-22 23:00',
    '2026-11-13 00:00',
    '2026-11-28 23:59',
    '2026-10-28 16:20',
    '2026-10-28 12:20',
    '2026-10-30 00:00',
    '2026-10-24 00:00',
    '2026-11-07 00:00',
    '2026-11-21 23:00',
    '2026-10-24 00:00',
  ];

  it.each(REAL_DEADLINES)('%s 解析为带时区的 datetime', (raw) => {
    const r = parseDueAt(raw);
    expect(r.duePrecision).toBe('datetime');
    expect(r.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/);
  });
});
