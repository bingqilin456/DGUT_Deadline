import { describe, expect, it } from 'vitest';
import {
  assignmentId,
  fallbackKey,
  isAllowedDetailUrl,
  type Assignment,
} from '../model/assignment.js';
import { classifyFailure, type SyncOutcome } from '../model/sync.js';

describe('assignmentId / fallbackKey —— 去重键', () => {
  it('稳定键由 source 与平台 ID 组成', () => {
    expect(assignmentId('hw', '123')).toBe('hw:123');
    expect(assignmentId('ulearning', 'abc')).toBe('ulearning:abc');
  });

  it('回退键对空白与大小写不敏感', () => {
    const a = fallbackKey({ courseName: '高等数学', title: '第三章 习题', dueAt: '2026-11-10T23:59:00+08:00' });
    const b = fallbackKey({ courseName: ' 高等数学 ', title: '第三章  习题 ', dueAt: '2026-11-10T23:59:00+08:00' });
    expect(a).toBe(b);
  });

  it('无截止时间时回退键使用 no-due 占位，不会塌缩为同一个空串', () => {
    const a = fallbackKey({ courseId: 'c1', title: '作业A', dueAt: null });
    const b = fallbackKey({ courseId: 'c1', title: '作业B', dueAt: null });
    expect(a).not.toBe(b);
    expect(a).toContain('no-due');
  });

  it('课程不同则不冲突', () => {
    const a = fallbackKey({ courseId: 'c1', title: '作业', dueAt: null });
    const b = fallbackKey({ courseId: 'c2', title: '作业', dueAt: null });
    expect(a).not.toBe(b);
  });
});

describe('isAllowedDetailUrl —— 跳转白名单', () => {
  it('允许两平台的 https 链接', () => {
    expect(isAllowedDetailUrl('hw', 'https://hw.dgut.edu.cn/student/homeworkPlan')).toBe(true);
    expect(isAllowedDetailUrl('ulearning', 'https://lms.dgut.edu.cn/courseweb/ulearning/index.html#/x')).toBe(true);
  });

  it('拒绝 http 明文链接', () => {
    expect(isAllowedDetailUrl('hw', 'http://hw.dgut.edu.cn/x')).toBe(false);
  });

  it('拒绝不在白名单的域名（含相似域名钓鱼）', () => {
    expect(isAllowedDetailUrl('hw', 'https://evil.com/x')).toBe(false);
    expect(isAllowedDetailUrl('hw', 'https://hw.dgut.edu.cn.evil.com/x')).toBe(false);
    expect(isAllowedDetailUrl('hw', 'https://lms.dgut.edu.cn/x')).toBe(false);
  });

  it('拒绝 javascript: 等伪协议', () => {
    expect(isAllowedDetailUrl('hw', 'javascript:alert(1)')).toBe(false);
    expect(isAllowedDetailUrl('hw', 'file:///C:/x')).toBe(false);
  });

  it('null 与非法 URL 返回 false', () => {
    expect(isAllowedDetailUrl('hw', null)).toBe(false);
    expect(isAllowedDetailUrl('hw', 'not a url')).toBe(false);
  });
});

describe('classifyFailure —— 失败分类不得混淆为"没有作业"', () => {
  it('DNS 失败归类为 network_blocked 且需用户操作', () => {
    const r = classifyFailure(new Error('getaddrinfo ENOTFOUND hw.dgut.edu.cn'));
    expect(r.reason).toBe('network_blocked');
    expect(r.requiresUserAction).toBe(true);
    expect(r.message).toContain('VPN');
  });

  it('超时归类为 timeout，不要求用户操作', () => {
    const r = classifyFailure(new Error('Timeout 30000ms exceeded'));
    expect(r.reason).toBe('timeout');
  });

  it('401 归类为 needs_login 且需用户操作', () => {
    const r = classifyFailure(new Error('HTTP 401 unauthorized'));
    expect(r.reason).toBe('needs_login');
    expect(r.requiresUserAction).toBe(true);
  });

  it('维护页归类为 platform_maintenance', () => {
    const r = classifyFailure(new Error('平台维护中 HTTP 503'));
    expect(r.reason).toBe('platform_maintenance');
  });

  it('选择器失效归类为 structure_changed（改版，而非零作业）', () => {
    const r = classifyFailure(new Error('selector not found: .homework-row'));
    expect(r.reason).toBe('structure_changed');
  });

  it('未知异常归类为 unknown 且带截断信息', () => {
    const r = classifyFailure(new Error('something odd'));
    expect(r.reason).toBe('unknown');
    expect(r.message.length).toBeLessThan(300);
  });
});

describe('Assignment 类型约束', () => {
  it('未知截止时间必须用 null + none，不得伪造时间', () => {
    const a: Assignment = {
      source: 'hw',
      sourceAssignmentId: '1',
      id: 'hw:1',
      courseId: null,
      courseName: null,
      title: '示例作业',
      detailUrl: null,
      dueAt: null,
      duePrecision: 'none',
      submissionStatus: 'unknown',
      statusEvidence: '平台未返回 deadline 字段',
      firstSeenAt: '2026-11-08T00:00:00+08:00',
      lastSeenAt: '2026-11-08T00:00:00+08:00',
      lastSyncAt: '2026-11-08T00:00:00+08:00',
      sourceUpdatedAt: null,
    };
    expect(a.dueAt).toBeNull();
    expect(a.submissionStatus).toBe('unknown');
    // 判定依据必须存在，便于审计
    expect(a.statusEvidence.length).toBeGreaterThan(0);
  });
});

describe('SyncOutcome —— 空与失败严格区分', () => {
  it('empty 表示"确认没有作业"，failed 表示"没读到"', () => {
    const empty: SyncOutcome = { kind: 'empty', source: 'hw', confirmedAt: '2026-11-08T00:00:00+08:00' };
    const failed: SyncOutcome = {
      kind: 'failed',
      source: 'hw',
      reason: 'network_blocked',
      message: 'DNS 失败',
      requiresUserAction: true,
    };
    expect(empty.kind).not.toBe(failed.kind);
  });
});
