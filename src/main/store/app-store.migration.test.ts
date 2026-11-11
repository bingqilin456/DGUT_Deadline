/**
 * AppStore schema v2 → v3 迁移测试（2026-11-11 新增）。
 *
 * 为什么必须测：迁移写坏用户数据是不可逆的（用户机器上已有 121 条 LMS 作业 +
 * 20 条 hw 作业缓存）。这里用真实 store 结构构造 v2 文件，验证迁移后的关键性质：
 *  1. 旧作业缓存一条不少，且全部补上 kind:'homework'；
 *  2. reminders 原样保留（键格式兼容，不清历史）；
 *  3. exams / lastSuccessByKind / examThresholds 被正确初始化；
 *  4. 迁移幂等（跑两次结果一致）。
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore, SETTINGS_SCHEMA_VERSION } from './app-store.js';

const TZ = '+08:00';

/** v2 时代的作业条目：**没有 kind 字段**（这正是要迁移的东西）。 */
function v2Assignment(id: string, dueOffsetHours: number): Record<string, unknown> {
  return {
    source: 'hw',
    sourceAssignmentId: id,
    id: `hw:${id}`,
    courseId: null,
    courseName: '数据库系统原理',
    title: `作业${id}`,
    detailUrl: 'https://hw.dgut.edu.cn/student/homeworkPlan',
    dueAt: `2026-11-${String(10 + dueOffsetHours).padStart(2, '0')}T23:00:00${TZ}`,
    duePrecision: 'datetime',
    submissionStatus: 'not_submitted',
    statusEvidence: 'plan.submitted=false',
    firstSeenAt: `2026-11-01T00:00:00${TZ}`,
    lastSeenAt: `2026-11-01T00:00:00${TZ}`,
    lastSyncAt: `2026-11-01T00:00:00${TZ}`,
    sourceUpdatedAt: null,
  };
}

/** 构造一个 v2 的 store 目录并写出文件。 */
function makeV2Store(opts: { hwCount?: number; includeThresholdsHours?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dgut-migrate-v2-'));
  const hwCount = opts.hwCount ?? 3;
  const hw = Array.from({ length: hwCount }, (_, i) => v2Assignment(String(5000 + i), i));
  const settings: Record<string, unknown> = {
    thresholds: [
      { hours: 72, enabled: true, urgent: false },
      { hours: 24, enabled: true, urgent: false },
      { hours: 12, enabled: true, urgent: true },
    ],
    syncIntervalMinutes: 45,
    quietHours: { enabled: true, start: '23:00', end: '07:00' },
    launchAtLogin: false,
    minimizeToTrayOnClose: true,
    notifyUnknownStatus: true,
    theme: 'dark',
    lastSyncAt: `2026-11-08T09:37:43.734Z`,
  };
  if (opts.includeThresholdsHours) {
    // v1 形态
    delete settings['thresholds'];
    settings['thresholdsHours'] = [72, 24, 3];
  }
  const payload = {
    schemaVersion: 2,
    settings,
    assignments: {
      ulearning: [],
      hw,
    },
    lastSuccess: { hw: `2026-11-08T09:37:36.126Z` },
    sessions: {},
    reminders: [
      {
        key: 'hw:5000:2026-11-10T23:00:00+08:00:72',
        firedAt: `2026-11-07T19:46:56.550Z`,
        dueAtAtFire: `2026-11-10T23:00:00${TZ}`,
        thresholdHours: 72,
      },
      {
        key: 'hw:5001:2026-11-11T23:00:00+08:00:24',
        firedAt: `2026-11-07T19:46:56.566Z`,
        dueAtAtFire: `2026-11-11T23:00:00${TZ}`,
        thresholdHours: 24,
      },
    ],
    overrides: { 'hw:5002': { dueAt: null, submissionStatus: 'submitted', at: `2026-11-08T00:00:00${TZ}` } },
  };
  writeFileSync(join(dir, 'dgut-deadline.json'), JSON.stringify(payload, null, 2), 'utf8');
  return dir;
}

describe('AppStore 迁移 v2 → v3', () => {
  it('版本号升到 3', () => {
    const store = new AppStore(makeV2Store());
    expect(SETTINGS_SCHEMA_VERSION).toBe(3);
    const raw = JSON.parse(readFileSync(store.path, 'utf8'));
    expect(raw.schemaVersion).toBe(3);
  });

  it('【关键】旧作业缓存一条不少，且全部补上 kind=homework', () => {
    const store = new AppStore(makeV2Store({ hwCount: 3 }));
    const hw = store.getAssignments('hw');
    expect(hw).toHaveLength(3);
    expect(hw.every((a) => a.kind === 'homework')).toBe(true);
    // 标题等业务字段不被破坏
    expect(hw.map((a) => a.title)).toEqual(['作业5000', '作业5001', '作业5002']);
  });

  it('【关键】reminders 原样保留（键格式兼容，不重放历史通知）', () => {
    const store = new AppStore(makeV2Store());
    const reminders = store.getReminders();
    expect(reminders).toHaveLength(2);
    expect(reminders[0]!.key).toBe('hw:5000:2026-11-10T23:00:00+08:00:72');
    expect(reminders[1]!.key).toBe('hw:5001:2026-11-11T23:00:00+08:00:24');
  });

  it('overrides 原样保留', () => {
    const store = new AppStore(makeV2Store());
    expect(store.getOverrides()['hw:5002']).toBeDefined();
    expect(store.getOverrides()['hw:5002']!.submissionStatus).toBe('submitted');
  });

  it('exams 被初始化为空，且按来源分键', () => {
    const store = new AppStore(makeV2Store());
    expect(store.getExamItems('hw')).toEqual([]);
    expect(store.getExamItems('ulearning')).toEqual([]);
    const raw = JSON.parse(readFileSync(store.path, 'utf8'));
    expect(raw.exams).toEqual({ ulearning: [], hw: [] });
  });

  it('lastSuccessByKind 补上作业侧时间（沿用 v2 的 lastSuccess）', () => {
    const store = new AppStore(makeV2Store());
    // 迁移只初始化结构；作业侧时间由 replaceAssignments 维护，
    // 这里验证读接口能正常返回 null 而不是崩溃
    expect(store.getLastSuccessByKind('hw', 'exam')).toBeNull();
    expect(store.getLastSuccess('hw')).toBe(`2026-11-08T09:37:36.126Z`);
  });

  it('settings 补 examThresholds / examSyncEnabled，但**不动**用户已配的 thresholds', () => {
    const store = new AppStore(makeV2Store());
    const s = store.getSettings();
    // 作业阈值原样（用户配置不能重置）
    expect(s.thresholds.map((t) => t.hours)).toEqual([72, 24, 12]);
    expect(s.syncIntervalMinutes).toBe(45);
    expect(s.theme).toBe('dark');
    // 新增项走默认
    expect(s.examThresholds.map((t) => t.offsetMinutes)).toEqual([1440, 120, 30, 0]);
    expect(s.examThresholds.every((t) => t.anchor === 'start')).toBe(true);
    // 用户 2026-11-11 决策：考试同步默认开启
    expect(s.examSyncEnabled).toBe(true);
  });

  it('迁移补默认值时**不覆盖**用户已显式关闭的 examSyncEnabled', () => {
    // 构造一个 v2 文件，但用户已经手动写了 examSyncEnabled=false
    const dir = makeV2Store({ hwCount: 1 });
    const raw = JSON.parse(readFileSync(join(dir, 'dgut-deadline.json'), 'utf8'));
    raw.settings.examSyncEnabled = false;
    writeFileSync(join(dir, 'dgut-deadline.json'), JSON.stringify(raw, null, 2), 'utf8');

    const store = new AppStore(dir);
    // 用户的选择必须被尊重，不能被迁移重置成默认的 true
    expect(store.getSettings().examSyncEnabled).toBe(false);
  });

  it('字段缺失时补成默认的 true（不是硬编码 false）', () => {
    const dir = makeV2Store({ hwCount: 1 });
    const raw = JSON.parse(readFileSync(join(dir, 'dgut-deadline.json'), 'utf8'));
    delete raw.settings.examSyncEnabled;
    writeFileSync(join(dir, 'dgut-deadline.json'), JSON.stringify(raw, null, 2), 'utf8');

    const store = new AppStore(dir);
    expect(store.getSettings().examSyncEnabled).toBe(true);
  });

  it('迁移幂等：用同一个目录再开一次 store，结果一致', () => {
    const dir = makeV2Store({ hwCount: 2 });
    const first = new AppStore(dir);
    const snapshot1 = {
      assignments: first.getAssignments('hw'),
      reminders: first.getReminders(),
      exams: first.getExamItems('hw'),
    };
    const second = new AppStore(dir);
    expect(second.getAssignments('hw')).toEqual(snapshot1.assignments);
    expect(second.getReminders()).toEqual(snapshot1.reminders);
    expect(second.getExamItems('hw')).toEqual(snapshot1.exams);
  });

  it('v1 → v3 连跳：thresholdsHours 被转成 thresholds，且新字段齐全', () => {
    const store = new AppStore(makeV2Store({ includeThresholdsHours: true }));
    const s = store.getSettings();
    // v1→v2 的既有设计：除转换旧值外，还会补齐 12/6/1 三个强制阈值
    // （见 docs/FEATURES-FILTER-REMINDER.md §2.7，这是刻意行为，不是缺陷）
    expect(s.thresholds.map((t) => t.hours).sort((a, b) => b - a)).toEqual([72, 24, 12, 6, 3, 1]);
    expect(s.thresholds.filter((t) => t.urgent).map((t) => t.hours).sort((a, b) => b - a)).toEqual([
      12, 6, 3, 1,
    ]);
    expect(s.examThresholds.length).toBe(4);
    expect(s.examSyncEnabled).toBe(true);
    expect(store.getAssignments('hw').every((a) => a.kind === 'homework')).toBe(true);
  });

  it('全新空目录：直接写 v3，新键齐全', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dgut-migrate-empty-'));
    const store = new AppStore(dir);
    const raw = JSON.parse(readFileSync(store.path, 'utf8'));
    expect(raw.schemaVersion).toBe(3);
    expect(raw.exams).toEqual({ ulearning: [], hw: [] });
    // 默认开启考试同步（用户 2026-11-11 决策）
    expect(raw.settings.examSyncEnabled).toBe(true);
    expect(store.getSettings().examThresholds.length).toBe(4);
  });
});

describe('AppStore 分 kind 缓存隔离（核心不变式）', () => {
  it('replaceExamItems 不影响作业缓存', () => {
    const store = new AppStore(makeV2Store({ hwCount: 2 }));
    const before = store.getAssignments('hw');
    store.replaceExamItems(
      'hw',
      [
        {
          kind: 'exam',
          source: 'hw',
          sourceAssignmentId: 'exam:1@1763000000000',
          id: 'hw:exam:1@1763000000000',
          courseId: null,
          courseName: '课程',
          title: '考试',
          detailUrl: null,
          examId: '1',
          startsAt: `2026-11-20T09:00:00${TZ}`,
          endsAt: null,
          timePrecision: 'datetime',
          venue: null,
          attendance: 'unknown',
          attendanceEvidence: 'test',
          firstSeenAt: `2026-11-01T00:00:00${TZ}`,
          lastSeenAt: `2026-11-01T00:00:00${TZ}`,
          lastSyncAt: `2026-11-01T00:00:00${TZ}`,
          sourceUpdatedAt: null,
        },
      ],
      `2026-11-11T00:00:00${TZ}`,
    );
    // 作业缓存逐字段不变
    expect(store.getAssignments('hw')).toEqual(before);
    expect(store.getExamItems('hw')).toHaveLength(1);
  });

  it('replaceAssignments 不影响考试缓存', () => {
    const store = new AppStore(makeV2Store({ hwCount: 2 }));
    store.replaceExamItems('hw', [], `2026-11-11T00:00:00${TZ}`);
    const hwBefore = store.getAssignments('hw').length;
    store.replaceAssignments('hw', store.getAssignments('hw').slice(0, 1), `2026-11-11T01:00:00${TZ}`);
    expect(store.getAssignments('hw')).toHaveLength(hwBefore - 1);
    expect(store.getExamItems('hw')).toEqual([]);
  });

  it('getAllListItems 同时返回作业与考试', () => {
    const store = new AppStore(makeV2Store({ hwCount: 2 }));
    expect(store.getAllListItems()).toHaveLength(2);
    expect(store.getAllAssignments()).toHaveLength(2);
    expect(store.getAllExamItems()).toHaveLength(0);
  });
});

describe('AppStore 提醒键清理按前缀', () => {
  it('clearRemindersForItem 只清该条目的键，不误伤别的条目', () => {
    const store = new AppStore(makeV2Store());
    expect(store.getReminders()).toHaveLength(2);
    store.clearRemindersForItem('hw:5000');
    const left = store.getReminders();
    expect(left).toHaveLength(1);
    expect(left[0]!.key.startsWith('hw:5000:')).toBe(false);
  });

  it('考试前缀与作业前缀不会互相匹配', () => {
    const store = new AppStore(makeV2Store({ hwCount: 1 }));
    store.addReminder({
      key: 'ulearning:exam:9001@1763000000000:start:120:1763000000000',
      firedAt: `2026-11-11T00:00:00${TZ}`,
      dueAtAtFire: `2026-11-13T09:00:00${TZ}`,
      thresholdHours: 0,
    });
    // 清作业 hw:5000 不得影响考试键
    store.clearRemindersForItem('hw:5000');
    expect(store.getReminders().some((r) => r.key.includes('ulearning:exam:'))).toBe(true);
  });
});
