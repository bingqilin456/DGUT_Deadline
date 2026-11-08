/**
 * LMS 适配器归一化测试。
 *
 * 期望值来自 2026-11-08 真机采集的真实响应
 * （investigation/lms-homework-real.json，25 门课程中 16 门有作业）。
 * 公开仓库版本已脱敏教师与发布者姓名，保留验证所需字段及类型。
 */

import { describe, expect, it } from 'vitest';
import { UlearningAssignmentSource, type LmsCourseRow, type LmsHomeworkRow } from './ulearning-source.js';

function mkSource(): UlearningAssignmentSource {
  return new UlearningAssignmentSource({ userDataDir: 'C:/tmp/lms-test', headless: true });
}

const SYNC_AT = '2026-11-08T03:40:00+08:00';

const COURSE: LmsCourseRow = {
  id: 162440,
  name: '2025面向对象程序设计（java）',
  teacherName: '[教师姓名已脱敏]',
};

/** 真实行：未完成，endTime = 1798646400000（2026-12-31 00:00 +08:00） */
const REAL_UNSUBMITTED: LmsHomeworkRow = {
  id: 500750,
  type: 9,
  homeworkTitle: '《大学生职业生涯规划》(26-27-1)期末考试',
  startTime: 1793705220000,
  endTime: 1798646400000,
  state: 0,
  timeStatus: '2',
  status: 2,
  publisher: '[发布者姓名已脱敏]',
  showLevel: 0,
  personStatus: 1,
};

/** 真实行：已完成（status=3, personStatus=2） */
const REAL_SUBMITTED: LmsHomeworkRow = {
  id: 500800,
  type: 3,
  homeworkTitle: '作业3：深度学习初步模块练习',
  startTime: 1793000000000,
  endTime: 1793807940000,
  state: 4,
  timeStatus: '3',
  status: 3,
  publisher: '[发布者姓名已脱敏]',
  showLevel: 0,
  personStatus: 2,
};

describe('LMS 归一化 —— 基于真实采集数据', () => {
  const src = mkSource();

  it('endTime 毫秒时间戳正确转为带时区 ISO', () => {
    const a = src.normalizeHomework(COURSE, REAL_UNSUBMITTED, SYNC_AT)!;
    expect(a).not.toBeNull();
    // 1798646400000 = 2026-12-30T16:00:00Z = 2026-12-31T00:00:00+08:00
    expect(a.dueAt).toBe('2026-12-31T00:00:00+08:00');
    expect(a.duePrecision).toBe('datetime');
  });

  it('status=2 判为未提交', () => {
    const a = src.normalizeHomework(COURSE, REAL_UNSUBMITTED, SYNC_AT)!;
    expect(a.submissionStatus).toBe('not_submitted');
    expect(a.statusEvidence).toContain('status=2');
  });

  it('status=3 判为已提交', () => {
    const a = src.normalizeHomework(COURSE, REAL_SUBMITTED, SYNC_AT)!;
    expect(a.submissionStatus).toBe('submitted');
    expect(a.statusEvidence).toContain('status=3');
  });

  it('课程名与标题原样保留（中文不乱码）', () => {
    const a = src.normalizeHomework(COURSE, REAL_UNSUBMITTED, SYNC_AT)!;
    expect(a.courseName).toBe('2025面向对象程序设计（java）');
    expect(a.title).toBe('《大学生职业生涯规划》(26-27-1)期末考试');
    expect(a.courseId).toBe('162440');
  });

  it('稳定键使用作业 id', () => {
    const a = src.normalizeHomework(COURSE, REAL_UNSUBMITTED, SYNC_AT)!;
    expect(a.sourceAssignmentId).toBe('500750');
    expect(a.id).toBe('ulearning:500750');
  });

  it('详情链接通过 allowlist 校验且带 courseId', () => {
    const a = src.normalizeHomework(COURSE, REAL_UNSUBMITTED, SYNC_AT)!;
    expect(a.detailUrl).toContain('lms.dgut.edu.cn');
    expect(a.detailUrl).toContain('courseId=162440');
  });
});

describe('LMS 归一化 —— 边界与保守处理', () => {
  const src = mkSource();

  it('标题为空的行被丢弃', () => {
    const row: LmsHomeworkRow = { ...REAL_UNSUBMITTED, id: 1, homeworkTitle: '   ' };
    expect(src.normalizeHomework(COURSE, row, SYNC_AT)).toBeNull();
  });

  it('缺少 endTime => 截止时间未知，不猜测', () => {
    const row: LmsHomeworkRow = { ...REAL_UNSUBMITTED, id: 2, endTime: null };
    const a = src.normalizeHomework(COURSE, row, SYNC_AT)!;
    expect(a.dueAt).toBeNull();
    expect(a.duePrecision).toBe('none');
  });

  it('endTime=0 视为无截止时间', () => {
    const row: LmsHomeworkRow = { ...REAL_UNSUBMITTED, id: 3, endTime: 0 };
    const a = src.normalizeHomework(COURSE, row, SYNC_AT)!;
    expect(a.dueAt).toBeNull();
  });

  it('缺少 status 与 personStatus => unknown（不默认未提交）', () => {
    const row: LmsHomeworkRow = { ...REAL_UNSUBMITTED, id: 4, status: null, personStatus: null };
    const a = src.normalizeHomework(COURSE, row, SYNC_AT)!;
    expect(a.submissionStatus).toBe('unknown');
    expect(a.statusEvidence).toContain('未在实测中出现');
  });

  it('未观测到的 status 取值 => unknown，不武断判定', () => {
    const row: LmsHomeworkRow = { ...REAL_UNSUBMITTED, id: 5, status: 99 };
    const a = src.normalizeHomework(COURSE, row, SYNC_AT)!;
    expect(a.submissionStatus).toBe('unknown');
  });

  it('personStatus=2 单独也能判为已提交', () => {
    const row: LmsHomeworkRow = { ...REAL_UNSUBMITTED, id: 6, status: null, personStatus: 2 };
    const a = src.normalizeHomework(COURSE, row, SYNC_AT)!;
    expect(a.submissionStatus).toBe('submitted');
  });
});

describe('LMS 时间戳解析', () => {
  it('1798646400000 => 2026-12-30T16:00:00Z', () => {
    expect(new Date(1798646400000).toISOString()).toBe('2026-12-30T16:00:00.000Z');
  });
  it('1793807940000 => 2026-11-04T15:59:00Z', () => {
    expect(new Date(1793807940000).toISOString()).toBe('2026-11-04T15:59:00.000Z');
  });
});
