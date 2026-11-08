/**
 * 同步引擎测试。
 *
 * 重点验证**硬性不变式**：
 *  1. 一个平台失败不影响另一个平台
 *  2. 失败绝不清空既有缓存
 *  3. "确认没有作业"（empty）与"没读到"（failed）严格区分
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Assignment, AssignmentSource, SessionStatus, SourceId } from '@dgut-deadline/shared';
import { AppStore } from '../store/app-store.js';
import { SyncEngine } from './sync-engine.js';

function mkA(source: SourceId, n: number): Assignment {
  return {
    source,
    sourceAssignmentId: String(n),
    id: `${source}:${n}`,
    courseId: null,
    courseName: '课程',
    title: `作业${n}`,
    detailUrl: 'https://hw.dgut.edu.cn/student/homeworkPlan',
    dueAt: '2026-11-20T23:00:00+08:00',
    duePrecision: 'datetime',
    submissionStatus: 'not_submitted',
    statusEvidence: 'submitted=false',
    firstSeenAt: '2026-11-01T00:00:00+08:00',
    lastSeenAt: '2026-11-01T00:00:00+08:00',
    lastSyncAt: '2026-11-01T00:00:00+08:00',
    sourceUpdatedAt: null,
  };
}

function mkSession(source: SourceId, state: SessionStatus['state']): SessionStatus {
  return {
    source,
    state,
    message: state === 'connected' ? '已连接' : '需要登录',
    lastSuccessAt: null,
    lastAttemptAt: new Date().toISOString(),
    requiresUserAction: state !== 'connected',
  };
}

/** 可编程的假数据源。 */
class FakeSource implements AssignmentSource {
  readonly displayName: string;
  constructor(
    readonly source: SourceId,
    private behavior: {
      session?: SessionStatus['state'];
      list?: () => Promise<Assignment[]>;
    },
  ) {
    this.displayName = source;
  }

  setBehavior(b: { session?: SessionStatus['state']; list?: () => Promise<Assignment[]> }): void {
    this.behavior = b;
  }

  async connect(): Promise<SessionStatus> {
    return mkSession(this.source, this.behavior.session ?? 'connected');
  }
  async checkSession(): Promise<SessionStatus> {
    return mkSession(this.source, this.behavior.session ?? 'connected');
  }
  async listAssignments(): Promise<Assignment[]> {
    if (!this.behavior.list) return [];
    return this.behavior.list();
  }
  async close(): Promise<void> {}
}

function mkStore(): AppStore {
  return new AppStore(mkdtempSync(join(tmpdir(), 'dgut-store-')));
}

describe('SyncEngine —— 平台间故障隔离', () => {
  let store: AppStore;
  let hw: FakeSource;
  let lms: FakeSource;
  let engine: SyncEngine;

  beforeEach(() => {
    store = mkStore();
    hw = new FakeSource('hw', { session: 'connected', list: async () => [mkA('hw', 1), mkA('hw', 2)] });
    lms = new FakeSource('ulearning', { session: 'connected', list: async () => [mkA('ulearning', 9)] });
    engine = new SyncEngine(
      store,
      new Map<SourceId, AssignmentSource>([
        ['hw', hw],
        ['ulearning', lms],
      ]),
    );
  });

  it('两个平台都成功时 allOk=true', async () => {
    const r = await engine.syncAll();
    expect(r.allOk).toBe(true);
    expect(r.anyOk).toBe(true);
    expect(store.getAssignments('hw')).toHaveLength(2);
    expect(store.getAssignments('ulearning')).toHaveLength(1);
  });

  it('LMS 失败时 hw 的结果仍然写入（故障隔离）', async () => {
    lms.setBehavior({
      session: 'connected',
      list: async () => {
        throw new Error('parse_error: 作业接口未验证');
      },
    });

    const r = await engine.syncAll();
    expect(r.allOk).toBe(false);
    expect(r.anyOk).toBe(true);

    const hwResult = r.results.find((x) => x.source === 'hw')!;
    const lmsResult = r.results.find((x) => x.source === 'ulearning')!;
    expect(hwResult.outcome.kind).toBe('ok');
    expect(lmsResult.outcome.kind).toBe('failed');
    expect(store.getAssignments('hw')).toHaveLength(2);
  });

  it('【关键】同步失败绝不清空既有缓存', async () => {
    // 先成功同步一次
    await engine.syncAll();
    expect(store.getAssignments('hw')).toHaveLength(2);

    // 再让 hw 失败（模拟断网 / 改版）
    hw.setBehavior({
      session: 'connected',
      list: async () => {
        throw new Error('selector not found: structure changed');
      },
    });

    const r = await engine.syncAll();
    const hwResult = r.results.find((x) => x.source === 'hw')!;
    expect(hwResult.outcome.kind).toBe('failed');
    // 缓存必须保留
    expect(store.getAssignments('hw')).toHaveLength(2);
    expect(store.getAssignments('hw')[0]!.title).toBe('作业1');
    // 且被标记为可能过期
    expect(hwResult.stale).toBe(true);
  });

  it('返回的 assignments 在失败时是缓存内容，不是空数组', async () => {
    await engine.syncAll();
    hw.setBehavior({ session: 'connected', list: async () => { throw new Error('timeout'); } });
    const r = await engine.syncAll();
    const hwResult = r.results.find((x) => x.source === 'hw')!;
    expect(hwResult.assignments).toHaveLength(2);
  });
});

describe('SyncEngine —— 空与失败严格区分', () => {
  it('平台明确返回 0 条 => outcome.kind = empty', async () => {
    const store = mkStore();
    const src = new FakeSource('hw', { session: 'connected', list: async () => [] });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));

    const r = await engine.syncAll();
    expect(r.results[0]!.outcome.kind).toBe('empty');
    expect(r.allOk).toBe(true); // empty 不是失败
  });

  it('未登录 => needs_login，且不是 empty', async () => {
    const store = mkStore();
    const src = new FakeSource('hw', { session: 'needs_login' });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));

    const r = await engine.syncAll();
    const o = r.results[0]!.outcome;
    expect(o.kind).toBe('failed');
    if (o.kind === 'failed') {
      expect(o.reason).toBe('needs_login');
      expect(o.requiresUserAction).toBe(true);
    }
    expect(r.allOk).toBe(false);
  });

  it('网络不可达 => network_blocked', async () => {
    const store = mkStore();
    const src = new FakeSource('hw', { session: 'network_blocked' });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));
    const r = await engine.syncAll();
    const o = r.results[0]!.outcome;
    expect(o.kind).toBe('failed');
    if (o.kind === 'failed') expect(o.reason).toBe('network_blocked');
  });

  it('平台维护中 => platform_maintenance（不是零作业）', async () => {
    const store = mkStore();
    const src = new FakeSource('hw', { session: 'platform_maintenance' });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));
    const r = await engine.syncAll();
    const o = r.results[0]!.outcome;
    expect(o.kind).toBe('failed');
    if (o.kind === 'failed') expect(o.reason).toBe('platform_maintenance');
  });
});

describe('SyncEngine —— 并发与状态', () => {
  it('并发调用 syncAll 复用同一次执行，不重复请求平台', async () => {
    const store = mkStore();
    let calls = 0;
    const src = new FakeSource('hw', {
      session: 'connected',
      list: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return [mkA('hw', 1)];
      },
    });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));

    await Promise.all([engine.syncAll(), engine.syncAll(), engine.syncAll()]);
    expect(calls).toBe(1);
  });

  it('同步进行中 isRunning 为 true，结束后为 false', async () => {
    const store = mkStore();
    const src = new FakeSource('hw', {
      session: 'connected',
      list: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return [mkA('hw', 1)];
      },
    });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));
    expect(engine.isRunning).toBe(false);
    const p = engine.syncAll();
    expect(engine.isRunning).toBe(true);
    await p;
    expect(engine.isRunning).toBe(false);
  });
});

describe('AppStore —— 持久化', () => {
  it('设置可写入并读回', () => {
    const store = mkStore();
    store.setSettings({
      thresholds: [
        { hours: 48, enabled: true, urgent: false },
        { hours: 12, enabled: true, urgent: true },
      ],
      syncIntervalMinutes: 60,
    });
    const s = store.getSettings();
    expect(s.thresholds.map((x) => x.hours)).toEqual([48, 12]);
    expect(s.syncIntervalMinutes).toBe(60);
  });

  it('默认阈值包含 72/24/12/6/3/1，其中 12/6/3/1 为强制提醒', () => {
    const store = mkStore();
    const th = store.getSettings().thresholds;
    expect(th.map((x) => x.hours)).toEqual([72, 24, 12, 6, 3, 1]);
    expect(th.filter((x) => x.urgent).map((x) => x.hours)).toEqual([12, 6, 3, 1]);
  });

  it('默认不开机自启', () => {
    const store = mkStore();
    expect(store.getSettings().launchAtLogin).toBe(false);
  });

  it('提醒记录可去重写入', () => {
    const store = mkStore();
    const rec = {
      key: 'hw:1:d:72',
      firedAt: '2026-11-08T00:00:00+08:00',
      dueAtAtFire: '2026-11-10T00:00:00+08:00',
      thresholdHours: 72,
    };
    store.addReminder(rec);
    store.addReminder(rec);
    expect(store.getReminders()).toHaveLength(1);
    expect(store.hasReminder('hw:1:d:72')).toBe(true);
  });
});
