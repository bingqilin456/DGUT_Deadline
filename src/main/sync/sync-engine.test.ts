/**
 * 同步引擎测试。
 *
 * 重点验证**硬性不变式**：
 *  1. 一个平台失败不影响另一个平台
 *  2. 失败绝不清空既有缓存
 *  3. "确认没有"（empty）与"没读到"（failed）严格区分
 *  4. **per-kind 隔离**：考试 kind 失败绝不影响作业缓存，反之亦然（docs/LMS-EXAM-PLAN.md §6.5）
 *  5. `warnings` / `complete` 从适配器透传到结果（修改造前 sync-engine.ts:150 的 `warnings: []` 写死）
 *  6. 不具备的 kind 不产生结果，也不伪造空列表
 *
 * 本文件的考试条目是**合成夹具**，不是真实平台响应（真实考试响应从未拿到）。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Assignment,
  AssignmentSource,
  ExamItem,
  ListItemKind,
  ListItemsResult,
  SessionStatus,
  SourceId,
} from '@dgut-deadline/shared';
import { AppStore } from '../store/app-store.js';
import { SyncEngine } from './sync-engine.js';

function mkA(source: SourceId, n: number): Assignment {
  return {
    kind: 'homework',
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

/** 合成考试场次夹具（非真实平台响应）。 */
function mkExam(n: number, startsAt = '2026-12-30T09:00:00+08:00'): ExamItem {
  const ms = startsAt ? Date.parse(startsAt) : null;
  const sourceAssignmentId = `exam:${n}@${ms ?? 'nostart'}`;
  return {
    kind: 'exam',
    source: 'ulearning',
    sourceAssignmentId,
    id: `ulearning:${sourceAssignmentId}`,
    courseId: '162440',
    courseName: '课程',
    title: `考试${n}`,
    detailUrl: 'https://lms.dgut.edu.cn/utest/#/exam/' + n,
    examId: String(n),
    startsAt,
    endsAt: null,
    timePrecision: startsAt ? 'datetime' : 'none',
    venue: null,
    attendance: 'unknown',
    attendanceEvidence: '合成夹具',
    firstSeenAt: '2026-11-01T00:00:00+08:00',
    lastSeenAt: '2026-11-01T00:00:00+08:00',
    lastSyncAt: '2026-11-01T00:00:00+08:00',
    sourceUpdatedAt: null,
  };
}

function hwResult(items: Assignment[], complete = true, warnings: string[] = []): ListItemsResult<Assignment> {
  return { items, complete, warnings };
}

function examResult(items: ExamItem[], complete = true, warnings: string[] = []): ListItemsResult<ExamItem> {
  return { items, complete, warnings };
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

interface Behavior {
  session?: SessionStatus['state'];
  homework?: () => Promise<ListItemsResult<Assignment>>;
  exams?: () => Promise<ListItemsResult<ExamItem>>;
}

/** 可编程的假数据源。 */
class FakeSource implements AssignmentSource {
  readonly displayName: string;
  readonly supportedKinds: readonly ListItemKind[];
  private behavior: Behavior;

  constructor(
    readonly source: SourceId,
    behavior: Behavior,
    kinds: readonly ListItemKind[] = ['homework'],
  ) {
    this.displayName = source;
    this.behavior = behavior;
    this.supportedKinds = kinds;
  }

  setBehavior(b: Behavior): void {
    this.behavior = b;
  }

  async connect(): Promise<SessionStatus> {
    return mkSession(this.source, this.behavior.session ?? 'connected');
  }
  async checkSession(): Promise<SessionStatus> {
    return mkSession(this.source, this.behavior.session ?? 'connected');
  }
  async listAssignments(): Promise<ListItemsResult<Assignment>> {
    if (!this.behavior.homework) return hwResult([]);
    return this.behavior.homework();
  }
  async listExams(): Promise<ListItemsResult<ExamItem>> {
    if (!this.behavior.exams) return examResult([]);
    return this.behavior.exams();
  }
  async close(): Promise<void> {}
}

function mkStore(): AppStore {
  return new AppStore(mkdtempSync(join(tmpdir(), 'dgut-store-')));
}

/**
 * 单测用临时 store：显式**打开**考试同步开关。
 *
 * `examSyncEnabled` 生产默认已是 true（用户 2026-11-11 决策），
 * 这里显式设置是为了让用例不依赖默认值——默认值本身由专门的 describe 验证。
 */
function mkTestStore(): AppStore {
  const store = mkStore();
  store.setSettings({ examSyncEnabled: true });
  return store;
}

/** 便捷：取某平台某 kind 的结果。 */
function kindOf(r: { kinds: import('./sync-engine.js').KindSyncResult[] }, k: ListItemKind) {
  return r.kinds.find((x) => x.kind === k)!;
}

describe('SyncEngine —— 平台间故障隔离', () => {
  let store: AppStore;
  let hw: FakeSource;
  let lms: FakeSource;
  let engine: SyncEngine;

  beforeEach(() => {
    store = mkTestStore();
    hw = new FakeSource('hw', { session: 'connected', homework: async () => hwResult([mkA('hw', 1), mkA('hw', 2)]) });
    lms = new FakeSource(
      'ulearning',
      {
        session: 'connected',
        homework: async () => hwResult([mkA('ulearning', 9)]),
        exams: async () => examResult([mkExam(500750)]),
      },
      ['homework', 'exam'],
    );
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
      homework: async () => {
        throw new Error('parse_error: 作业接口结构改变');
      },
      exams: async () => {
        throw new Error('parse_error: 考试接口结构改变');
      },
    });

    const r = await engine.syncAll();
    expect(r.allOk).toBe(false);
    expect(r.anyOk).toBe(true);

    const hwResult = r.results.find((x) => x.source === 'hw')!;
    const lmsResult = r.results.find((x) => x.source === 'ulearning')!;
    expect(kindOf(hwResult, 'homework').outcome.kind).toBe('ok');
    expect(kindOf(lmsResult, 'homework').outcome.kind).toBe('failed');
    expect(kindOf(lmsResult, 'exam').outcome.kind).toBe('failed');
    expect(store.getAssignments('hw')).toHaveLength(2);
  });

  it('【关键】同步失败绝不清空既有缓存', async () => {
    await engine.syncAll();
    expect(store.getAssignments('hw')).toHaveLength(2);

    // 再让 hw 失败（模拟断网 / 改版）
    hw.setBehavior({
      session: 'connected',
      homework: async () => {
        throw new Error('selector not found: structure changed');
      },
    });

    const r = await engine.syncAll();
    const hwResult = r.results.find((x) => x.source === 'hw')!;
    const homework = kindOf(hwResult, 'homework');
    expect(homework.outcome.kind).toBe('failed');
    // 缓存必须保留
    expect(store.getAssignments('hw')).toHaveLength(2);
    expect(store.getAssignments('hw')[0]!.title).toBe('作业1');
    // 且被标记为可能过期
    expect(homework.stale).toBe(true);
  });

  it('返回的作业结果在失败时是缓存内容，不是空数组', async () => {
    await engine.syncAll();
    hw.setBehavior({ session: 'connected', homework: async () => { throw new Error('timeout'); } });
    const r = await engine.syncAll();
    const hwResult = r.results.find((x) => x.source === 'hw')!;
    expect(kindOf(hwResult, 'homework').count).toBe(2);
    expect(hwResult.assignments).toHaveLength(2);
  });
});

describe('SyncEngine —— per-kind 隔离（关键不变式）', () => {
  let store: AppStore;
  let lms: FakeSource;
  let engine: SyncEngine;

  beforeEach(() => {
    store = mkTestStore();
    lms = new FakeSource(
      'ulearning',
      {
        session: 'connected',
        homework: async () => hwResult([mkA('ulearning', 9)]),
        exams: async () => examResult([mkExam(500750)]),
      },
      ['homework', 'exam'],
    );
    engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['ulearning', lms]]));
  });

  it('考试 kind 失败时，作业缓存一条不动', async () => {
    // 先成功一次，两侧都有缓存
    await engine.syncAll();
    expect(store.getAssignments('ulearning')).toHaveLength(1);
    expect(store.getExamItems('ulearning')).toHaveLength(1);
    const before = JSON.stringify(store.getAssignments('ulearning'));

    // 只让考试失败
    lms.setBehavior({
      session: 'connected',
      homework: async () => hwResult([mkA('ulearning', 10)]),
      exams: async () => {
        throw new Error('parse_error: 考试容器不可识别');
      },
    });

    const r = await engine.syncAll();
    const res = r.results[0]!;
    const exam = kindOf(res, 'exam');
    expect(exam.outcome.kind).toBe('failed');
    if (exam.outcome.kind === 'failed') {
      // parse_error 必须与 empty 区分开
      expect(exam.outcome.kind).not.toBe('empty');
    }

    // 作业侧照常更新到新数据（一条不"不动"指的是不被考试失败影响）
    expect(store.getAssignments('ulearning')).toHaveLength(1);
    expect(store.getAssignments('ulearning')[0]!.title).toBe('作业10');
    expect(JSON.stringify(store.getAssignments('ulearning'))).not.toBe(before);
    // 考试缓存保留旧场次
    expect(store.getExamItems('ulearning')).toHaveLength(1);
    expect(exam.stale).toBe(true);
  });

  it('作业 kind 失败时，考试缓存一条不动', async () => {
    await engine.syncAll();
    expect(store.getExamItems('ulearning')).toHaveLength(1);

    lms.setBehavior({
      session: 'connected',
      homework: async () => {
        throw new Error('parse_error: 作业容器改变');
      },
      exams: async () => examResult([mkExam(500751)]),
    });

    const r = await engine.syncAll();
    const res = r.results[0]!;
    expect(kindOf(res, 'homework').outcome.kind).toBe('failed');
    expect(kindOf(res, 'exam').outcome.kind).toBe('ok');
    // 考试更新成新场次
    expect(store.getExamItems('ulearning')).toHaveLength(1);
    expect(store.getExamItems('ulearning')[0]!.examId).toBe('500751');
    // 作业缓存原样保留
    expect(store.getAssignments('ulearning')).toHaveLength(1);
    expect(store.getAssignments('ulearning')[0]!.title).toBe('作业9');
  });

  it('考试容器不识别 => 考试 failed/parse_error，而不是 empty', async () => {
    lms.setBehavior({
      session: 'connected',
      homework: async () => hwResult([mkA('ulearning', 9)]),
      exams: async () => {
        throw new Error('parse_error: 响应中不存在 examList 容器');
      },
    });
    const r = await engine.syncAll();
    const exam = kindOf(r.results[0]!, 'exam');
    expect(exam.outcome.kind).toBe('failed');
    if (exam.outcome.kind === 'failed') {
      // parse_error 与 empty / unknown 都必须区分开
      expect(exam.outcome.reason).toBe('parse_error');
      expect(exam.outcome.message.length).toBeGreaterThan(0);
    }
    expect(r.allOk).toBe(false);
  });

  it('考试明确 0 条 => empty（与 failed 严格区分）', async () => {
    lms.setBehavior({
      session: 'connected',
      homework: async () => hwResult([mkA('ulearning', 9)]),
      exams: async () => examResult([], true),
    });
    const r = await engine.syncAll();
    expect(kindOf(r.results[0]!, 'exam').outcome.kind).toBe('empty');
    expect(kindOf(r.results[0]!, 'homework').outcome.kind).toBe('ok');
    expect(r.allOk).toBe(true); // empty 不是失败
    expect(store.getExamItems('ulearning')).toHaveLength(0);
    // 作业缓存不受影响
    expect(store.getAssignments('ulearning')).toHaveLength(1);
  });

  it('【关键】0 条 + complete=false => failed（不得渲染成"没有考试"）', async () => {
    lms.setBehavior({
      session: 'connected',
      // 作业侧：确实读全了，但就是 0 条 ⇒ empty（对照）
      homework: async () => hwResult([], true),
      // 考试侧：0 条但没读全 ⇒ failed
      exams: async () => examResult([], false, ['课程 A 读取失败', '课程 B 读取失败']),
    });
    const r = await engine.syncAll();
    const res = r.results[0]!;
    const exam = kindOf(res, 'exam');
    expect(exam.outcome.kind).toBe('failed');
    expect(exam.warnings.join('\n')).toContain('课程 A 读取失败');
    // 对照：真正读全的 0 条才是 empty
    expect(kindOf(res, 'homework').outcome.kind).toBe('empty');
    expect(r.allOk).toBe(false);
  });
});

describe('SyncEngine —— warnings / complete 透传', () => {
  it('适配器 warnings 不再被丢弃（修 sync-engine.ts:150 的 warnings: [] 写死）', async () => {
    const store = mkTestStore();
    const src = new FakeSource('hw', {
      session: 'connected',
      homework: async () => hwResult([mkA('hw', 1)], true, ['已上传作业列表读取失败：timeout']),
    });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));

    const r = await engine.syncAll();
    const h = kindOf(r.results[0]!, 'homework');
    expect(h.outcome.kind).toBe('ok');
    expect(h.warnings).toContain('已上传作业列表读取失败：timeout');
    if (h.outcome.kind === 'ok') {
      expect(h.outcome.warnings).toContain('已上传作业列表读取失败：timeout');
    }
  });

  it('complete=false 透传到 outcome，并追加"可能不全"告警', async () => {
    const store = mkTestStore();
    const src = new FakeSource('hw', {
      session: 'connected',
      homework: async () => hwResult([mkA('hw', 1)], false, ['第 3 页读取失败']),
    });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));

    const r = await engine.syncAll();
    const h = kindOf(r.results[0]!, 'homework');
    expect(h.outcome.kind).toBe('ok');
    if (h.outcome.kind === 'ok') {
      expect(h.outcome.complete).toBe(false);
    }
    expect(h.warnings.join('\n')).toContain('可能有遗漏');
    // 没读全 ⇒ 缓存不能算"新鲜且完整"
    expect(h.stale).toBe(true);
  });

  it('【关键】部分成功不得清掉"本次没读到"的旧条目（按条目保全缓存）', async () => {
    const store = mkTestStore();
    // 第一次：3 条全部读到
    const src = new FakeSource('hw', {
      session: 'connected',
      homework: async () => hwResult([mkA('hw', 1), mkA('hw', 2), mkA('hw', 3)]),
    });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));
    await engine.syncAll();
    expect(store.getAssignments('hw')).toHaveLength(3);

    // 第二次：只读到 1 条，但 complete=false（部分课程/分页失败）
    src.setBehavior({
      session: 'connected',
      homework: async () => hwResult([mkA('hw', 1)], false, ['课程 B 读取失败']),
    });
    const r = await engine.syncAll();
    const h = kindOf(r.results[0]!, 'homework');
    expect(h.stale).toBe(true);

    // 1 条被刷新；2、3 条虽然本次没读到，但**必须保留**（否则等于按条目清缓存）
    const ids = store.getAssignments('hw').map((a) => a.id).sort();
    expect(ids).toEqual(['hw:1', 'hw:2', 'hw:3']);
    expect(h.count).toBe(3);
  });

  it('complete=true 时整体替换（平台确实删掉的条目应消失）', async () => {
    const store = mkTestStore();
    const src = new FakeSource('hw', {
      session: 'connected',
      homework: async () => hwResult([mkA('hw', 1), mkA('hw', 2)]),
    });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));
    await engine.syncAll();

    src.setBehavior({ session: 'connected', homework: async () => hwResult([mkA('hw', 1)]) });
    await engine.syncAll();
    expect(store.getAssignments('hw').map((a) => a.id)).toEqual(['hw:1']);
  });
});

describe('SyncEngine —— supportedKinds 能力声明', () => {
  it('只声明 homework 的平台不产生 exam 结果（不伪造空考试列表）', async () => {
    const store = mkTestStore();
    const src = new FakeSource('hw', { session: 'connected', homework: async () => hwResult([mkA('hw', 1)]) });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));

    const r = await engine.syncAll();
    expect(r.results[0]!.kinds.map((k) => k.kind)).toEqual(['homework']);
    expect(r.results[0]!.kinds.some((k) => k.kind === 'exam')).toBe(false);
    expect(store.getExamItems('hw')).toHaveLength(0);
  });

  it('声明 exam 但未实现 listExams => 显式 failed，绝不返回空', async () => {
    const store = mkTestStore();
    const src = new FakeSource('ulearning', { session: 'connected', homework: async () => hwResult([]) });
    // 手工制造"声明了却没实现"的坏适配器
    Object.defineProperty(src, 'supportedKinds', { value: ['homework', 'exam'] });
    Object.defineProperty(src, 'listExams', { value: undefined });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['ulearning', src]]));

    const r = await engine.syncAll();
    const exam = kindOf(r.results[0]!, 'exam');
    expect(exam.outcome.kind).toBe('failed');
  });

  it('allOk 按 kind 聚合：一个 kind 失败即 false；partialKinds 列出失败项', async () => {
    const store = mkTestStore();
    const src = new FakeSource(
      'ulearning',
      {
        session: 'connected',
        homework: async () => hwResult([mkA('ulearning', 1)]),
        exams: async () => {
          throw new Error('timeout');
        },
      },
      ['homework', 'exam'],
    );
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['ulearning', src]]));

    const r = await engine.syncAll();
    expect(r.allOk).toBe(false);
    expect(r.anyOk).toBe(true);
    expect(r.partialKinds).toEqual([{ source: 'ulearning', kind: 'exam' }]);
  });
});

describe('SyncEngine —— 空与失败严格区分', () => {
  it('平台明确返回 0 条 => outcome.kind = empty', async () => {
    const store = mkTestStore();
    const src = new FakeSource('hw', { session: 'connected', homework: async () => hwResult([]) });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));

    const r = await engine.syncAll();
    expect(kindOf(r.results[0]!, 'homework').outcome.kind).toBe('empty');
    expect(r.allOk).toBe(true); // empty 不是失败
  });

  it('未登录 => 所有 kind 都 needs_login，且不是 empty', async () => {
    const store = mkTestStore();
    const src = new FakeSource('hw', { session: 'needs_login' });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));

    const r = await engine.syncAll();
    const o = kindOf(r.results[0]!, 'homework').outcome;
    expect(o.kind).toBe('failed');
    if (o.kind === 'failed') {
      expect(o.reason).toBe('needs_login');
      expect(o.requiresUserAction).toBe(true);
    }
    expect(r.allOk).toBe(false);
  });

  it('未登录时考试的 kind 也一起失败（平台级事实），但都不清缓存', async () => {
    const store = mkTestStore();
    const src = new FakeSource(
      'ulearning',
      {
        session: 'connected',
        homework: async () => hwResult([mkA('ulearning', 1)]),
        exams: async () => examResult([mkExam(1)]),
      },
      ['homework', 'exam'],
    );
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['ulearning', src]]));
    await engine.syncAll();

    src.setBehavior({ session: 'needs_login' });
    const r = await engine.syncAll();
    const res = r.results[0]!;
    expect(res.session.state).toBe('needs_login');
    expect(res.kinds.map((k) => k.outcome.kind)).toEqual(['failed', 'failed']);
    // 缓存全部保留
    expect(store.getAssignments('ulearning')).toHaveLength(1);
    expect(store.getExamItems('ulearning')).toHaveLength(1);
  });

  it('网络不可达 => network_blocked', async () => {
    const store = mkTestStore();
    const src = new FakeSource('hw', { session: 'network_blocked' });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));
    const r = await engine.syncAll();
    const o = kindOf(r.results[0]!, 'homework').outcome;
    expect(o.kind).toBe('failed');
    if (o.kind === 'failed') expect(o.reason).toBe('network_blocked');
  });

  it('平台维护中 => platform_maintenance（不是零作业）', async () => {
    const store = mkTestStore();
    const src = new FakeSource('hw', { session: 'platform_maintenance' });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));
    const r = await engine.syncAll();
    const o = kindOf(r.results[0]!, 'homework').outcome;
    expect(o.kind).toBe('failed');
    if (o.kind === 'failed') expect(o.reason).toBe('platform_maintenance');
  });
});

describe('SyncEngine —— 拆键存储（考试写入 exams.*，作业写入 assignments.*）', () => {
  it('两个 kind 分别落到各自的缓存键，互不覆盖', async () => {
    const store = mkTestStore();
    const src = new FakeSource(
      'ulearning',
      {
        session: 'connected',
        homework: async () => hwResult([mkA('ulearning', 1)]),
        exams: async () => examResult([mkExam(7)]),
      },
      ['homework', 'exam'],
    );
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['ulearning', src]]));

    const r = await engine.syncAll();
    const res = r.results[0]!;
    expect(kindOf(res, 'homework').outcome.kind).toBe('ok');
    expect(kindOf(res, 'exam').outcome.kind).toBe('ok');
    // 物理拆键：作业进 assignments.*，考试进 exams.*
    expect(store.getAssignments('ulearning')).toHaveLength(1);
    expect(store.getAssignments('ulearning')[0]!.id).toBe('ulearning:1');
    expect(store.getExamItems('ulearning')).toHaveLength(1);
    expect(store.getExamItems('ulearning')[0]!.examId).toBe('7');
  });
});

describe('SyncEngine —— examSyncEnabled 开关（用户 2026-11-11 决策：默认开启）', () => {
  function mkSrc(): FakeSource {
    return new FakeSource(
      'ulearning',
      {
        session: 'connected',
        homework: async () => hwResult([mkA('ulearning', 1)]),
        exams: async () => examResult([mkExam(7)]),
      },
      ['homework', 'exam'],
    );
  }

  it('默认（开启）会请求考试接口并写入 exams.*', async () => {
    const store = mkStore();
    let examCalls = 0;
    const src = mkSrc();
    const orig = src.listExams.bind(src);
    src.listExams = async () => {
      examCalls++;
      return orig();
    };
    // 默认设置里 examSyncEnabled=true
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['ulearning', src]]));

    const r = await engine.syncAll();
    expect(examCalls).toBe(1);
    expect(r.results[0]!.kinds.map((k) => k.kind)).toEqual(['homework', 'exam']);
    expect(store.getExamItems('ulearning')).toHaveLength(1);
    // 作业同时正常
    expect(store.getAssignments('ulearning')).toHaveLength(1);
  });

  it('显式关闭后不请求考试接口，只同步作业', async () => {
    const store = mkTestStore();
    store.setSettings({ examSyncEnabled: false });
    let examCalls = 0;
    const src = mkSrc();
    const orig = src.listExams.bind(src);
    src.listExams = async () => {
      examCalls++;
      return orig();
    };
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['ulearning', src]]));

    const r = await engine.syncAll();
    expect(examCalls).toBe(0);
    expect(r.results[0]!.kinds.map((k) => k.kind)).toEqual(['homework']);
  });

  it('关闭时也不影响已缓存的考试数据（不主动清空）', async () => {
    const store = mkTestStore();
    store.setSettings({ examSyncEnabled: true });
    const src = mkSrc();
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['ulearning', src]]));
    await engine.syncAll();
    expect(store.getExamItems('ulearning')).toHaveLength(1);

    // 关闭开关后再同步：不请求、不清缓存
    store.setSettings({ examSyncEnabled: false });
    const r = await engine.syncAll();
    expect(r.results[0]!.kinds.map((k) => k.kind)).toEqual(['homework']);
    expect(store.getExamItems('ulearning')).toHaveLength(1);
  });

  /**
   * 默认开启后最关键的红线：考试接口读不懂时必须显示"失败"，不能显示"0 场考试"。
   * 否则用户会以为优学院真的没有考试（AGENTS.md 红线 3）。
   */
  it('【关键】默认开启 + 考试容器识别不了 => 显示失败，绝不显示 0 场考试', async () => {
    const store = mkStore();
    const src = new FakeSource(
      'ulearning',
      {
        session: 'connected',
        homework: async () => hwResult([mkA('ulearning', 1)]),
        exams: async () => {
          throw new Error('parse_error: 考试列表响应缺少 examList 容器');
        },
      },
      ['homework', 'exam'],
    );
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['ulearning', src]]));

    const r = await engine.syncAll();
    const exam = kindOf(r.results[0]!, 'exam');
    // 必须是 failed / parse_error，而不是 empty
    expect(exam.outcome.kind).toBe('failed');
    if (exam.outcome.kind === 'failed') {
      expect(exam.outcome.reason).toBe('parse_error');
    }
    // 作业仍然成功（故障隔离）
    expect(kindOf(r.results[0]!, 'homework').outcome.kind).toBe('ok');
    expect(store.getAssignments('ulearning')).toHaveLength(1);
  });
});

describe('SyncEngine —— 并发与状态', () => {
  it('并发调用 syncAll 复用同一次执行，不重复请求平台', async () => {
    const store = mkTestStore();
    let calls = 0;
    const src = new FakeSource('hw', {
      session: 'connected',
      homework: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return hwResult([mkA('hw', 1)]);
      },
    });
    const engine = new SyncEngine(store, new Map<SourceId, AssignmentSource>([['hw', src]]));

    await Promise.all([engine.syncAll(), engine.syncAll(), engine.syncAll()]);
    expect(calls).toBe(1);
  });

  it('同步进行中 isRunning 为 true，结束后为 false', async () => {
    const store = mkTestStore();
    const src = new FakeSource('hw', {
      session: 'connected',
      homework: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return hwResult([mkA('hw', 1)]);
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
