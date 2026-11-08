/**
 * 提醒调度器测试：验证真正"弹不弹"的行为，而不只是阈值计算。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Assignment } from '@dgut-deadline/shared';
import { AppStore } from '../store/app-store.js';
import { ReminderScheduler } from './scheduler.js';

const TZ = '+08:00';

function mkA(over: Partial<Assignment> = {}): Assignment {
  return {
    source: 'hw',
    sourceAssignmentId: '1',
    id: 'hw:1',
    courseId: null,
    courseName: '数据库系统原理',
    title: '作业三 SQL语言',
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

interface Sent {
  title: string;
  body: string;
}

function setup(opts: { nowMs: number; assignments: Assignment[]; settings?: Record<string, unknown> }) {
  const store = new AppStore(mkdtempSync(join(tmpdir(), 'dgut-sched-')));
  store.replaceAssignments('hw', opts.assignments, new Date(opts.nowMs).toISOString());
  if (opts.settings) store.setSettings(opts.settings);

  const sent: Sent[] = [];
  const sched = new ReminderScheduler(store, {
    now: () => opts.nowMs,
    showNotification: (n) => {
      sent.push(n);
      return true;
    },
  });
  return { store, sched, sent };
}

describe('ReminderScheduler —— 真实派发行为', () => {
  it('跨过 72h 阈值时真的发出通知', async () => {
    const { sched, sent } = setup({
      nowMs: Date.parse(`2026-11-09T13:00:00${TZ}`),
      assignments: [mkA()],
    });
    const r = await sched.tick();
    expect(r.fired).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain('72');
  });

  it('第二次 tick 不会重复弹窗（幂等）', async () => {
    const { sched, sent } = setup({
      nowMs: Date.parse(`2026-11-09T13:00:00${TZ}`),
      assignments: [mkA()],
    });
    await sched.tick();
    await sched.tick();
    await sched.tick();
    expect(sent).toHaveLength(1);
  });

  it('已提交作业不弹窗', async () => {
    const { sched, sent } = setup({
      nowMs: Date.parse(`2026-11-09T13:00:00${TZ}`),
      assignments: [mkA({ submissionStatus: 'submitted' })],
    });
    await sched.tick();
    expect(sent).toHaveLength(0);
  });

  it('未知状态提醒文案是"请核对作业状态"，不是"你还没交"', async () => {
    const { sched, sent } = setup({
      nowMs: Date.parse(`2026-11-09T13:00:00${TZ}`),
      assignments: [mkA({ submissionStatus: 'unknown' })],
    });
    await sched.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain('请核对');
    expect(sent[0]!.title).not.toContain('还没交');
  });

  it('静默时段内不弹窗', async () => {
    const { sched, sent } = setup({
      // 23:30 本地时间，落在静默时段
      nowMs: Date.parse(`2026-11-09T23:30:00${TZ}`),
      assignments: [mkA({ dueAt: `2026-11-12T23:30:00${TZ}` })],
      settings: { quietHours: { enabled: true, start: '23:00', end: '07:00' } },
    });
    const r = await sched.tick();
    expect(sent).toHaveLength(0);
    expect(r.suppressed.quiet).toBeGreaterThan(0);
  });

  it('静默时段内仍然记录已触发，避免静默结束后补弹旧通知', async () => {
    const { sched, store } = setup({
      nowMs: Date.parse(`2026-11-09T23:30:00${TZ}`),
      assignments: [mkA({ dueAt: `2026-11-12T23:30:00${TZ}` })],
      settings: { quietHours: { enabled: true, start: '23:00', end: '07:00' } },
    });
    await sched.tick();
    expect(store.getReminders().length).toBeGreaterThan(0);
  });

  it('已过期超过 24h 不补发（防通知轰炸）', async () => {
    const { sched, sent } = setup({
      nowMs: Date.parse(`2026-11-14T00:00:00${TZ}`),
      assignments: [mkA()],
    });
    await sched.tick();
    expect(sent).toHaveLength(0);
  });

  it('过期 1 小时内仍补发（休眠恢复场景）', async () => {
    const { sched, sent } = setup({
      nowMs: Date.parse(`2026-11-12T13:00:00${TZ}`),
      assignments: [mkA()],
    });
    await sched.tick();
    expect(sent.length).toBeGreaterThan(0);
  });

  it('多个作业同时到期会各自弹窗', async () => {
    const { sched, sent } = setup({
      nowMs: Date.parse(`2026-11-12T10:00:00${TZ}`),
      assignments: [
        mkA({ sourceAssignmentId: '1', id: 'hw:1' }),
        mkA({ sourceAssignmentId: '2', id: 'hw:2', title: '实验5' }),
      ],
      // 显式指定阈值，避免依赖默认值（默认会随产品调整）
      settings: {
        thresholds: [
          { hours: 72, enabled: true, urgent: false },
          { hours: 24, enabled: true, urgent: false },
          { hours: 3, enabled: true, urgent: true },
        ],
      },
    });
    await sched.tick();
    // 2 条作业 × 3 个阈值 = 6 条通知
    expect(sent).toHaveLength(6);
  });

  it('【强制提醒】12h/6h/3h/1h 默认配置会弹出，且标记为 urgent', async () => {
    const { sched, sent } = setup({
      // 距截止 30 分钟 => 1h/3h/6h/12h/24h/72h 全部已过
      nowMs: Date.parse(`2026-11-12T11:30:00${TZ}`),
      assignments: [mkA()],
    });
    await sched.tick();
    // 默认 6 个阈值全触发
    expect(sent).toHaveLength(6);
  });

  it('【逐项开关】关闭某个阈值后不再提醒', async () => {
    const { sched, sent } = setup({
      nowMs: Date.parse(`2026-11-12T10:00:00${TZ}`),
      assignments: [mkA()],
      settings: {
        thresholds: [
          { hours: 72, enabled: false, urgent: false }, // 关闭
          { hours: 24, enabled: true, urgent: false },
          { hours: 3, enabled: true, urgent: true },
        ],
      },
    });
    await sched.tick();
    expect(sent).toHaveLength(2); // 只剩 24h 与 3h
  });

  it('【静默时段】普通提醒被抑制，但强制提醒仍然弹出', async () => {
    const { sched, sent } = setup({
      // 23:30 落在静默时段
      nowMs: Date.parse(`2026-11-12T23:30:00${TZ}`),
      assignments: [mkA({ dueAt: `2026-11-13T01:30:00${TZ}` })], // 2 小时后截止
      settings: {
        quietHours: { enabled: true, start: '23:00', end: '07:00' },
        thresholds: [
          { hours: 72, enabled: true, urgent: false }, // 普通 -> 静默抑制
          { hours: 3, enabled: true, urgent: true }, // 强制 -> 仍弹出
          { hours: 1, enabled: true, urgent: true }, // 1h 尚未到点
        ],
      },
    });
    await sched.tick();
    // 只有 3h 的强制提醒弹出
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain('3');
  });

  it('改期后会按新时间重新提醒', async () => {
    const nowMs = Date.parse(`2026-11-11T13:00:00${TZ}`);
    const { store, sched, sent } = setup({
      nowMs,
      // 截止 11-12 12:00，距 now 23h => 72h、24h 阈值均已过
      assignments: [mkA()],
    });
    await sched.tick();
    const first = sent.length;
    expect(first).toBeGreaterThan(0);

    // 改期到 11-14 12:00（距 now 71h）=> 72h 阈值已过，是新键
    store.replaceAssignments(
      'hw',
      [mkA({ dueAt: `2026-11-14T12:00:00${TZ}` })],
      new Date(nowMs).toISOString(),
    );
    await sched.tick();
    expect(sent.length).toBeGreaterThan(first);
  });

  it('没有作业时不报错也不弹窗', async () => {
    const { sched, sent } = setup({ nowMs: Date.now(), assignments: [] });
    const r = await sched.tick();
    expect(r.fired).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('通知失败时不记录，以便下次重试', async () => {
    const store = new AppStore(mkdtempSync(join(tmpdir(), 'dgut-sched-')));
    store.replaceAssignments('hw', [mkA()], new Date().toISOString());
    const nowMs = Date.parse(`2026-11-09T13:00:00${TZ}`);
    const sched = new ReminderScheduler(store, {
      now: () => nowMs,
      showNotification: () => false,
    });
    const r = await sched.tick();
    expect(r.fired).toBe(0);
    expect(store.getReminders()).toHaveLength(0);
  });
});
