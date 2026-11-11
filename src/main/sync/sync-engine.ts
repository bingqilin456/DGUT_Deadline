/**
 * 同步编排。
 *
 * 核心不变式（来自需求硬约束）：
 *  1. 一个平台失败**绝不影响**另一个平台的成功结果。
 *  2. **按 kind 隔离**：考试同步失败绝不影响作业缓存，反之亦然
 *     （docs/LMS-EXAM-PLAN.md §6.5；拆键存储是 §7 的方案，本层通过 per-kind outcome 保证语义）。
 *  3. 失败**绝不**清空既有缓存；UI 依据 lastSuccessAt 显示"数据可能过期"。
 *  4. "确认没有"（empty）与"没读到"（failed）严格区分：
 *     0 条 + `complete=true` 才是 empty；0 条 + `complete=false` 必须是 failed。
 *  5. 同步过程中不产生写操作，只读。
 *  6. 平台通过 `supportedKinds` 声明能力：不具备的 kind **不产生结果**，也不伪造空列表
 *     （hw 没有考试功能，若返回"考试 0 条"就是把"不具备能力"伪装成"没有数据"）。
 */

import type {
  Assignment,
  AssignmentSource,
  ExamItem,
  ListItem,
  ListItemKind,
  SessionState,
  SessionStatus,
  SourceId,
  SyncOutcome,
} from '@dgut-deadline/shared';
import { classifyFailure } from '@dgut-deadline/shared';
import type { AppStore } from '../store/app-store.js';

type FailureReason = Extract<SyncOutcome, { kind: 'failed' }>['reason'];

/**
 * 单个 (平台, kind) 的同步结果。
 *
 * 为什么不用现成的 `SyncOutcome`：它的 `ok` 分支固定携带 `assignments: Assignment[]`，
 * 而考试 kind 的产物是 `ExamItem[]` —— 硬塞进 Assignment 会立刻破坏判别联合的意义
 * （ExamItem 上物理不存在 submissionStatus）。因此这里定义与 `SyncOutcome` 同构、
 * 但把列表泛化为 `ListItem[]` 的 kind 级结果。
 */
export type KindSyncOutcome =
  | {
      kind: 'ok';
      source: SourceId;
      listKind: 'homework' | 'exam';
      /** 本次读到的条目（作业或考试场次，取决于 listKind）。 */
      items: ListItem[];
      /** 是否覆盖了全部课程/分页。false 表示"有课程没读到"，必须配合 warnings 展示。 */
      complete: boolean;
      warnings: string[];
    }
  | {
      kind: 'empty';
      /** 明确确认"确实没有"，而不是"没读到"。 */
      source: SourceId;
      listKind: 'homework' | 'exam';
      confirmedAt: string;
      warnings: string[];
    }
  | {
      kind: 'failed';
      source: SourceId;
      listKind: 'homework' | 'exam';
      reason: FailureReason;
      message: string;
      requiresUserAction: boolean;
      warnings: string[];
    };

/** 单个 (平台, kind) 的同步结果。 */
export interface KindSyncResult {
  kind: ListItemKind;
  outcome: KindSyncOutcome;
  /** 本次有效条数（失败时为缓存条数）。 */
  count: number;
  /** 本 kind 的数据是否可能过期。 */
  stale: boolean;
  warnings: string[];
  durationMs: number;
}

export interface SourceSyncResult {
  source: SourceId;
  /** 按 `supportedKinds` 顺序，一个 kind 一条结果。 */
  kinds: KindSyncResult[];
  session: SessionStatus;
  /** 兼容旧字段：作业条数（= kinds 中 homework 的 count）。 */
  assignmentCount: number;
  /** 本平台本次同步耗时（毫秒，含所有 kind）。 */
  durationMs: number;
  /**
   * 失败时回传的旧缓存（作业）。保留该字段是为了让调用方在失败分支仍能拿到可展示数据，
   * 语义与改造前的 `assignments` 相同。
   */
  assignments: Assignment[];
}

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  results: SourceSyncResult[];
  /** 全部平台的全部 kind 都非 failed？ */
  allOk: boolean;
  /** 至少一个 (平台, kind) 非 failed？ */
  anyOk: boolean;
  /** 部分 kind 失败（便于 UI 顶栏显示"部分数据可能不全"）。 */
  partialKinds: { source: SourceId; kind: ListItemKind }[];
}

/** 陈旧判定阈值：上次成功超过该时长即标记"数据可能过期"。 */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * 同步引擎对存储层的最小依赖。
 *
 * 作业走 `assignments.*`、考试走 `exams.*`（拆键存储，docs/LMS-EXAM-PLAN.md §7.2）；
 * 拆键是「按 kind 部分替换」的物理保障 —— 考试失败不可能碰到作业缓存。
 * 这里用 `Pick` 而非整个 `AppStore`，便于单测注入替身。
 */
export type SyncEngineStore = Pick<
  AppStore,
  | 'getAssignments'
  | 'replaceAssignments'
  | 'getLastSuccess'
  | 'markSession'
  | 'getExamItems'
  | 'replaceExamItems'
  | 'getSettings'
>;

/** 考试 kind 的默认超时（逐课程 × 最多 2 条候选接口，比作业更慢）。 */
export const EXAM_TIMEOUT_MS = 120_000;

export class SyncEngine {
  private running: Promise<SyncReport> | null = null;

  constructor(
    private readonly store: SyncEngineStore,
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
    this.running = this.do(options).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async do(options: { timeoutMs?: number } = {}): Promise<SyncReport> {
    const startedAt = new Date(this.now()).toISOString();
    const entries = [...this.sources.entries()];

    const results = await Promise.all(
      entries.map(([sourceId, source]) => this.syncOne(sourceId, source, options.timeoutMs)),
    );

    const finishedAt = new Date(this.now()).toISOString();
    const flat = results.flatMap((r) =>
      r.kinds.map((k) => ({ source: r.source, kind: k.kind, outcome: k.outcome })),
    );
    return {
      startedAt,
      finishedAt,
      results,
      allOk: flat.every((x) => x.outcome.kind !== 'failed'),
      anyOk: flat.some((x) => x.outcome.kind !== 'failed'),
      partialKinds: flat
        .filter((x) => x.outcome.kind === 'failed')
        .map((x) => ({ source: x.source, kind: x.kind })),
    };
  }

  /**
   * 同步单个平台：任何异常都被收敛为 failed，不向调用方抛出。
   *
   * 对 `source.supportedKinds` 里每个 kind 各跑一次，结果彼此独立：
   *  - 会话失效（needs_login 等）会同时作用于所有 kind（平台级事实）；
   *  - 单个 kind 的解析/超时失败只影响该 kind 的缓存与结果。
   */
  async syncOne(
    sourceId: SourceId,
    source: AssignmentSource,
    timeoutMs = 90_000,
  ): Promise<SourceSyncResult> {
    const t0 = this.now();
    let session = await this.readSession(sourceId, source);

    // 未连接：所有声明的 kind 直接失败，保留旧缓存（现状行为）。
    if (session.state !== 'connected') {
      this.store.markSession(sourceId, session);
      const reason = sessionStateToReason(session.state);
      const kinds = source.supportedKinds.map((kind) =>
        this.failedKindResult(sourceId, kind, reason, session.message, session.requiresUserAction, t0),
      );
      return {
        source: sourceId,
        kinds,
        session,
        assignmentCount: this.store.getAssignments(sourceId).length,
        durationMs: this.now() - t0,
        assignments: this.store.getAssignments(sourceId),
      };
    }

    const kinds: KindSyncResult[] = [];
    const examEnabled = this.isExamSyncEnabled();
    for (const kind of source.supportedKinds) {
      // 灰度开关（docs/LMS-EXAM-PLAN.md §11.2）：examSyncEnabled 默认 false。
      // 关闭时**不发任何考试请求**，也不产生 exam 结果 —— 因为考试接口从未拿到真实响应，
      // 默认开启会让每次同步白跑 ≤50 次 GET 并可能产出不可信数据。
      // 注意：这里不生成"考试 0 条"，那只会在 UI 上伪装成"你没有考试"（红线 3）。
      if (kind === 'exam' && !examEnabled) continue;
      kinds.push(await this.syncKind(sourceId, source, kind, session, timeoutMs));
    }

    // 会话状态取"最需要用户介入"的那个：任一 kind 判定失效 ⇒ 平台会话失效。
    const failed = kinds.filter((k) => k.outcome.kind === 'failed');
    const loginFailed = failed.find((k) => reasonOf(k) === 'needs_login');
    const maintenanceFailed = failed.find((k) => reasonOf(k) === 'platform_maintenance');
    if (loginFailed || maintenanceFailed) {
      const pick = loginFailed ?? maintenanceFailed!;
      session = {
        ...session,
        state: loginFailed ? 'needs_login' : 'platform_maintenance',
        message: pick.outcome.kind === 'failed' ? pick.outcome.message : session.message,
        requiresUserAction: true,
      };
    }
    this.store.markSession(sourceId, session);

    const cachedHomework = this.store.getAssignments(sourceId);
    return {
      source: sourceId,
      kinds,
      session,
      assignmentCount:
        kinds.find((k) => k.kind === 'homework')?.count ?? cachedHomework.length,
      durationMs: this.now() - t0,
      assignments: cachedHomework,
    };
  }

  /** 同步单个 (平台, kind)：异常收敛为 failed，失败时保留该 kind 的旧缓存。 */
  private async syncKind(
    sourceId: SourceId,
    source: AssignmentSource,
    kind: ListItemKind,
    session: SessionStatus,
    timeoutMs: number,
  ): Promise<KindSyncResult> {
    const t0 = this.now();
    const kindTimeout = kind === 'exam' ? Math.max(timeoutMs, EXAM_TIMEOUT_MS) : timeoutMs;
    const at = new Date(this.now()).toISOString();

    try {
      const result = await this.readKind(source, kind, kindTimeout);

      // 0 条 + complete=false ⇒ "没说清"，必须是 failed（绝不能渲染成"没有"）。
      if (result.items.length === 0 && !result.complete) {
        const message = '平台未返回可确认的空结果（部分课程/分页读取失败），无法确认是否真的没有数据。';
        return this.recordFailure(
          sourceId,
          kind,
          {
            reason: 'unknown',
            message,
            requiresUserAction: false,
          },
          result.warnings,
          t0,
        );
      }

      // 明确读到 0 条：这是"确认没有"，不是失败。
      if (result.items.length === 0) {
        this.persist(sourceId, kind, [], at);
        const warnings = [...result.warnings];
        return {
          kind,
          outcome: {
            kind: 'empty',
            source: sourceId,
            listKind: kind,
            confirmedAt: at,
            warnings,
          },
          count: 0,
          stale: false,
          warnings,
          durationMs: this.now() - t0,
        };
      }

      // 没读全时不能整体替换缓存：否则"本轮读失败的课程/分页"里的条目会被静默清掉，
      // 等于用一次部分失败清空了那些条目的缓存（违反「失败不得清空缓存」）。
      // 因此 incomplete 时按 id 与旧缓存合并：已知条目以本次为准，本次没读到的保留旧值。
      const merged = result.complete
        ? result.items
        : mergeKeepingUnreadItems(result.items, this.readCache(sourceId, kind));

      this.persist(sourceId, kind, merged, at);
      const warnings = [...result.warnings];
      if (!result.complete) {
        // 已经把能读到的写入缓存，但必须让 UI 知道"可能不全"。
        warnings.push(
          `本次只读到${kind === 'exam' ? '部分考试' : '部分作业'}（${result.items.length} 条），可能有遗漏`,
        );
      }
      return {
        kind,
        outcome: {
          kind: 'ok',
          source: sourceId,
          listKind: kind,
          items: merged,
          complete: result.complete,
          warnings,
        },
        count: merged.length,
        // 没读全时，缓存里缺的正是失败课程/分页的数据 —— 不能当作"新鲜且完整"。
        // 标 stale 让 UI 提示"数据可能不全"，而不是让用户误以为清单是完整的。
        stale: !result.complete,
        warnings,
        durationMs: this.now() - t0,
      };
    } catch (err) {
      const c = classifyFailure(err);
      void session;
      return this.recordFailure(sourceId, kind, withParseErrorReason(err, c), [], t0);
    }
  }

  /** 调用适配器读某一 kind（能力缺失即抛错，绝不伪造空结果）。 */
  private async readKind(
    source: AssignmentSource,
    kind: ListItemKind,
    timeoutMs: number,
  ): Promise<{ items: Assignment[] | ExamItem[]; complete: boolean; warnings: string[] }> {
    if (kind === 'homework') {
      return source.listAssignments({ timeoutMs });
    }
    if (!source.supportedKinds.includes('exam')) {
      throw new Error(
        `source ${source.source} 未声明支持 exam，不得伪造空的考试结果（supportedKinds=${source.supportedKinds.join(',')}）`,
      );
    }
    if (!source.listExams) {
      // 声明了能力却没实现：这是实现错误，必须显式失败而不是返回空。
      throw new Error(`source ${source.source} 声明支持 exam 但未实现 listExams()`);
    }
    return source.listExams({ timeoutMs });
  }

  /** 读某 kind 的现有缓存（失败/部分成功时用于保全旧数据）。 */
  private readCache(sourceId: SourceId, kind: ListItemKind): ListItem[] {
    return kind === 'homework'
      ? this.store.getAssignments(sourceId)
      : this.store.getExamItems(sourceId);
  }

  /** 写入某 kind 的缓存。
   *
   * 拆键是硬约束（§7.2）：作业只碰 `assignments.*`，考试只碰 `exams.*`，
   * 两者物理隔离 —— 一侧失败不可能清掉另一侧的缓存。
   */
  private persist(sourceId: SourceId, kind: ListItemKind, items: ListItem[], at: string): void {
    if (kind === 'homework') {
      this.store.replaceAssignments(sourceId, items as Assignment[], at);
      return;
    }
    this.store.replaceExamItems(sourceId, items as ExamItem[], at);
  }

  /** 失败结果：保留该 kind 的旧缓存，标记 stale。 */
  private recordFailure(
    sourceId: SourceId,
    kind: ListItemKind,
    c: { reason: FailureReason; message: string; requiresUserAction: boolean },
    warnings: string[],
    t0: number,
  ): KindSyncResult {
    // 关键：保留该 kind 的旧缓存，不清空。
    // 作业走 assignments.*、考试走 exams.*，物理拆键 ⇒ 一侧失败不可能碰到另一侧。
    const cached = this.readCache(sourceId, kind);
    const merged = [...warnings];
    merged.push(`本次${kind === 'exam' ? '考试' : '作业'}同步失败，已保留上次数据`);
    return {
      kind,
      outcome: {
        kind: 'failed',
        source: sourceId,
        listKind: kind,
        reason: c.reason,
        message: c.message,
        requiresUserAction: c.requiresUserAction,
        warnings: merged,
      },
      count: cached.length,
      // 本次同步失败 => 数据已无法确认为最新，必须标记为可能过期。
      // 仅按"上次成功距今是否超过 6 小时"判断是不够的：刚同步成功后立刻失败时，
      // 缓存字面上很"新"，但我们已失去与平台的一致性，UI 必须提示可能过期。
      stale: true,
      warnings: merged,
      durationMs: this.now() - t0,
    };
  }

  /**
   * 考试同步总开关（`settings.examSyncEnabled`）。
   *
   * 默认 **开启**（用户 2026-11-11 决策）。开启的前提是适配器对
   * 「容器识别不了 / 会话失效」必须抛错，由本层归类为 failed，
   * 不能返回空数组把"读不懂"伪装成"没有考试"。
   *
   * 显式 `=== false` 才关闭：单测注入的替身 store 可能没有 `getSettings`，
   * 此时按默认开启处理，与生产默认一致，避免"测试里关了、生产里开着"的偏差。
   */
  private isExamSyncEnabled(): boolean {
    const getSettings = (this.store as Partial<Pick<AppStore, 'getSettings'>>).getSettings;
    if (typeof getSettings !== 'function') return true;
    try {
      return this.store.getSettings().examSyncEnabled !== false;
    } catch {
      return true;
    }
  }

  /** `checkSession()` 抛错也被收敛为会话状态，不向调用方抛出。 */  private async readSession(sourceId: SourceId, source: AssignmentSource): Promise<SessionStatus> {
    try {
      return await source.checkSession();
    } catch (err) {
      const c = classifyFailure(err);
      return {
        source: sourceId,
        state: c.reason === 'needs_login' ? 'needs_login' : 'error',
        message: c.message,
        lastSuccessAt: this.store.getLastSuccess(sourceId),
        lastAttemptAt: new Date(this.now()).toISOString(),
        requiresUserAction: c.requiresUserAction,
      };
    }
  }

  /** 未连接时：为每个 kind 生成 failed 结果（保留缓存条数）。 */
  private failedKindResult(
    sourceId: SourceId,
    kind: ListItemKind,
    reason: FailureReason,
    message: string,
    requiresUserAction: boolean,
    t0: number,
  ): KindSyncResult {
    return this.recordFailure(
      sourceId,
      kind,
      { reason, message, requiresUserAction },
      [],
      t0,
    );
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sources.values()].map((s) => s.close().catch(() => {})));
  }
}

function reasonOf(r: KindSyncResult): FailureReason | null {
  return r.outcome.kind === 'failed' ? r.outcome.reason : null;
}

/**
 * 部分成功时合并缓存：本次读到的条目覆盖旧值，本次没读到的旧条目**保留**。
 *
 * 为什么需要：适配器在 `complete=false` 时只返回"读成功的那部分"（例如 25 门课里 3 门失败）。
 * 若直接整体替换缓存，那 3 门课下的条目会被**静默清掉** —— 这正是
 * 「失败不得清空缓存」要禁止的行为，只是粒度变成了"按条目"。
 *
 * 顺序：以本次读到为准（保持其排序），未读到的旧条目按原顺序追加在末尾。
 * 调用方随后会看到 `stale=true` + warning，明确提示"可能有遗漏"。
 */
function mergeKeepingUnreadItems(fresh: ListItem[], cached: ListItem[]): ListItem[] {
  const seen = new Set(fresh.map((i) => i.id));
  const kept = cached.filter((i) => !seen.has(i.id));
  return kept.length === 0 ? fresh : [...fresh, ...kept];
}

/**
 * 修正 `classifyFailure` 对 `parse_error:` 前缀的处理。
 *
 * `packages/shared/src/model/sync.ts:103` 只把 `selector|structure|未找到` 归为
 * `structure_changed`，适配器抛出的 `parse_error: ...` 会落到 `unknown`。
 * 解析失败与"未知错误"在 UI 上必须是不同语义（解析失败 = 平台改版/形状变化，需回填证据），
 * 因此这里在 engine 层做确定性归类，不改 shared（shared 是 Lead 与另一队友的作用域）。
 */
function withParseErrorReason(
  err: unknown,
  c: { reason: FailureReason; message: string; requiresUserAction: boolean },
): { reason: FailureReason; message: string; requiresUserAction: boolean } {
  if (c.reason !== 'unknown') return c;
  const raw = err instanceof Error ? err.message : String(err);
  if (/^parse_error\b/i.test(raw) || /parse_error:/i.test(raw)) {
    return {
      reason: 'parse_error',
      message: `平台响应结构无法解析：${raw.slice(0, 180)}`,
      requiresUserAction: false,
    };
  }
  return c;
}

/** SessionState → 失败原因（用于"未连接时所有 kind 都失败"的归类）。 */
function sessionStateToReason(state: SessionState): FailureReason {
  switch (state) {
    case 'needs_login':
      return 'needs_login';
    case 'network_blocked':
      return 'network_blocked';
    case 'platform_maintenance':
      return 'platform_maintenance';
    default:
      return 'unknown';
  }
}
