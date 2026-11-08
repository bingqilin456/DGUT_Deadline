/**
 * 同步编排。
 *
 * 核心不变式（来自需求硬约束）：
 *  1. 一个平台失败**绝不影响**另一个平台的成功结果。
 *  2. 失败**绝不**清空既有缓存；UI 依据 lastSuccessAt 显示"数据可能过期"。
 *  3. "确认没有作业"（empty）与"没读到"（failed）严格区分。
 *  4. 同步过程中不产生写操作，只读。
 */

import type { AssignmentSource, SessionStatus, SourceId, SyncOutcome } from '@dgut-deadline/shared';
import { classifyFailure } from '@dgut-deadline/shared';
import type { AppStore } from '../store/app-store.js';

export interface SourceSyncResult {
  source: SourceId;
  outcome: SyncOutcome;
  session: SessionStatus;
  /** 本次同步后 UI 应展示的作业（失败时即旧缓存）。 */
  assignments: AssignmentLike[];
  /** 是否为陈旧数据（上次成功距今过久或本次失败）。 */
  stale: boolean;
  durationMs: number;
}

type AssignmentLike = ReturnType<AppStore['getAllAssignments']>[number];

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  results: SourceSyncResult[];
  /** 全部平台都成功？用于 UI 区分"部分失败"与"全部成功"。 */
  allOk: boolean;
  anyOk: boolean;
}

/** 陈旧判定阈值：上次成功超过该时长即标记"数据可能过期"。 */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export class SyncEngine {
  private running: Promise<SyncReport> | null = null;

  constructor(
    private readonly store: AppStore,
    private readonly sources: Map<SourceId, AssignmentSource>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 是否正在同步（防止并发触发导致重复请求平台）。 */
  get isRunning(): boolean {
    return this.running !== null;
  }

  /** 同步所有平台；并发进行，互不影响。已有同步进行中时复用同一 Promise。 */
  async syncAll(options: { timeoutMs?: number } = {}): Promise<SyncReport> {
    if (this.running) return this.running;
    this.running = this.do((async () => {})()).finally(() => {
      this.running = null;
    }) as unknown as Promise<SyncReport>;
    return this.running;
  }

  private async do(_: unknown): Promise<SyncReport> {
    const startedAt = new Date(this.now()).toISOString();
    const entries = [...this.sources.entries()];

    const results = await Promise.all(
      entries.map(([sourceId, source]) => this.syncOne(sourceId, source)),
    );

    const finishedAt = new Date(this.now()).toISOString();
    return {
      startedAt,
      finishedAt,
      results,
      allOk: results.every((r) => r.outcome.kind !== 'failed'),
      anyOk: results.some((r) => r.outcome.kind !== 'failed'),
    };
  }

  /** 同步单个平台：任何异常都被收敛为 failed，不向调用方抛出。 */
  async syncOne(sourceId: SourceId, source: AssignmentSource, timeoutMs = 90_000): Promise<SourceSyncResult> {
    const t0 = this.now();
    let session: SessionStatus;

    try {
      session = await source.checkSession();
    } catch (err) {
      const c = classifyFailure(err);
      session = {
        source: sourceId,
        state: c.reason === 'needs_login' ? 'needs_login' : 'error',
        message: c.message,
        lastSuccessAt: this.store.getLastSuccess(sourceId),
        lastAttemptAt: new Date(this.now()).toISOString(),
        requiresUserAction: c.requiresUserAction,
      };
    }

    // 未连接：直接失败，保留旧缓存
    if (session.state !== 'connected') {
      this.store.markSession(sourceId, session);
      const outcome: SyncOutcome = {
        kind: 'failed',
        source: sourceId,
        reason:
          session.state === 'needs_login'
            ? 'needs_login'
            : session.state === 'network_blocked'
              ? 'network_blocked'
              : session.state === 'platform_maintenance'
                ? 'platform_maintenance'
                : 'unknown',
        message: session.message,
        requiresUserAction: session.requiresUserAction,
      };
      return {
        source: sourceId,
        outcome,
        session,
        assignments: this.store.getAssignments(sourceId),
        stale: true,
        durationMs: this.now() - t0,
      };
    }

    try {
      const list = await source.listAssignments({ timeoutMs });

      // 明确读到 0 条：这是"确认没有作业"，不是失败
      if (list.length === 0) {
        const at = new Date(this.now()).toISOString();
        this.store.replaceAssignments(sourceId, [], at);
        this.store.markSession(sourceId, session);
        return {
          source: sourceId,
          outcome: { kind: 'empty', source: sourceId, confirmedAt: at },
          session,
          assignments: [],
          stale: false,
          durationMs: this.now() - t0,
        };
      }

      const at = new Date(this.now()).toISOString();
      this.store.replaceAssignments(sourceId, list, at);
      this.store.markSession(sourceId, session);
      return {
        source: sourceId,
        outcome: { kind: 'ok', source: sourceId, assignments: list, complete: true, warnings: [] },
        session,
        assignments: list,
        stale: false,
        durationMs: this.now() - t0,
      };
    } catch (err) {
      const c = classifyFailure(err);
      const failedSession: SessionStatus = {
        ...session,
        state: c.reason === 'needs_login' ? 'needs_login' : 'error',
        message: c.message,
        requiresUserAction: c.requiresUserAction,
      };
      this.store.markSession(sourceId, failedSession);

      // 关键：保留旧缓存，不清空
      const cached = this.store.getAssignments(sourceId);
      const lastSuccess = this.store.getLastSuccess(sourceId);
      // 本次同步失败 => 数据已无法确认为最新，必须标记为可能过期。
      // 仅按"上次成功距今是否超过 6 小时"判断是不够的：刚同步成功后立刻失败时，
      // 缓存字面上很"新"，但我们已失去与平台的一致性，UI 必须提示可能过期。
      const stale = true;
      void STALE_AFTER_MS;
      void lastSuccess;

      return {
        source: sourceId,
        outcome: {
          kind: 'failed',
          source: sourceId,
          reason: c.reason,
          message: c.message,
          requiresUserAction: c.requiresUserAction,
        },
        session: failedSession,
        assignments: cached,
        stale,
        durationMs: this.now() - t0,
      };
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sources.values()].map((s) => s.close().catch(() => {})));
  }
}
