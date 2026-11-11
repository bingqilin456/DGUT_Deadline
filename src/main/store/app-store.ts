/**
 * 本地持久化。
 *
 * 使用 electron-store（原子写入 + schema 版本迁移），满足需求中
 * "稳健、支持原子写入和版本迁移的本地存储"。
 *
 * 安全约定：
 *  - 只存课程/作业/考试缓存、设置、提醒记录；绝不存密码。
 *  - 浏览器会话由 Playwright 的 userDataDir 独立管理，不写入本 store。
 *  - 文件位于 app.getPath('userData')，不入 Git。
 *
 * ══════════════════════════════════════════════════════════════════════
 * schema v2 → v3（2026-11-11，接入考试）
 * ══════════════════════════════════════════════════════════════════════
 * 变更**全部是追加**，不搬迁任何既有数据：
 *  + exams:            Record<SourceId, ExamItem[]>    （考试场次缓存，与作业分开存）
 *  + lastSuccessByKind （按 kind 的最近成功时间）
 *  + settings.examThresholds（分钟级考试阈值）
 *  + settings.examSyncEnabled（灰度开关，默认 false）
 *  ~ assignments.* 里每条补 `kind: 'homework'`（v2 数据没有 kind 字段）
 *
 * 为什么拆 `exams` 而不把 assignments 改成 Record<source, Record<kind, item[]>>：
 *  1. 已存在于用户机器上的 121+20 条缓存无需搬迁，降低写坏风险；
 *  2. 「按 kind 部分替换」用拆键天然满足：考试失败绝不碰 assignments；
 *  3. 回滚友好：删掉 exams.* 即退化为纯作业，作业数据零影响。
 */

import Store from 'electron-store';
import type {
  Assignment,
  ExamItem,
  ListItem,
  ListItemKind,
  SessionStatus,
  SourceId,
} from '@dgut-deadline/shared';
import {
  DEFAULT_EXAM_THRESHOLDS,
  DEFAULT_THRESHOLDS,
  type ExamThresholdSetting,
  type ThresholdSetting,
} from '../../shared/thresholds.js';

export const SETTINGS_SCHEMA_VERSION = 3;

export interface AppSettings {
  /**
   * 作业提醒阈值（可逐项开关 + 标记是否强制弹出）。
   * 默认：72h / 24h 普通提醒；12h / 6h / 3h / 1h 强制弹出。
   */
  thresholds: ThresholdSetting[];
  /** 考试提醒阈值（分钟级）。锚点 = 开考 / 结束。 */
  examThresholds: ExamThresholdSetting[];
  /**
   * 是否同步优学院考试。
   * 默认 true（用户 2026-11-11 决策：考试同步默认开启）。
   *
   * ⚠️ 考试列表接口的真实响应仍未验证（docs/LMS-EXAM-PLAN.md §3 C.1）。
   * 因此默认开启的前提是：适配器遇到「容器识别不了 / 会话失效」必须**抛错**，
   * 由同步层归类为 failed，UI 显示「考试同步失败」——绝不能返回空数组，
   * 那会把"读不懂"伪装成"你没有考试"（AGENTS.md 红线 3）。
   * 用户仍可在设置里关闭。
   */
  examSyncEnabled: boolean;
  /** 自动同步间隔（分钟）；0 表示关闭自动同步。 */
  syncIntervalMinutes: number;
  /** 静默时段（本地时间 HH:mm）。 */
  quietHours: { enabled: boolean; start: string; end: string };
  /** 开机自启（默认关闭）。 */
  launchAtLogin: boolean;
  /** 关闭窗口时最小化到托盘（而不是退出）。 */
  minimizeToTrayOnClose: boolean;
  /** 未知提交状态是否给低确定性提醒。 */
  notifyUnknownStatus: boolean;
  /** 主题。 */
  theme: 'light' | 'dark' | 'system';
  /** 上次同步时间。 */
  lastSyncAt: string | null;
  /**
   * 是否显示演示数据。
   * 需求硬约束：演示数据必须明确标注「演示」，绝不能与真实数据混淆。
   */
  showDemoData?: boolean;
  /** 已结束考试在列表中保留的小时数（便于回看考场/座位）。默认 24。 */
  endedExamRetentionHours?: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  thresholds: DEFAULT_THRESHOLDS.map((t) => ({ ...t })),
  examThresholds: DEFAULT_EXAM_THRESHOLDS.map((t) => ({ ...t })),
  examSyncEnabled: true,
  syncIntervalMinutes: 30,
  quietHours: { enabled: false, start: '23:00', end: '07:00' },
  launchAtLogin: false,
  minimizeToTrayOnClose: true,
  notifyUnknownStatus: true,
  theme: 'system',
  lastSyncAt: null,
  showDemoData: false,
  endedExamRetentionHours: 24,
};

export interface ReminderRecord {
  /** 幂等键：作业 `${id}:${dueAt}:${hours}`；考试 `${id}:${anchor}:${offset}:${anchorAtMs}` */
  key: string;
  firedAt: string;
  dueAtAtFire: string | null;
  thresholdHours: number;
}

export interface StoreSchema {
  schemaVersion: number;
  settings: AppSettings;
  /** 作业缓存（按平台）。失败时保留旧数据。 */
  assignments: Record<SourceId, Assignment[]>;
  /** 考试场次缓存（按平台）。与 assignments 分开存，失败互不影响。 */
  exams: Record<SourceId, ExamItem[]>;
  /** 每个平台最近一次成功同步时间（作业）。 */
  lastSuccess: Partial<Record<SourceId, string>>;
  /** 按 kind 的最近成功时间。 */
  lastSuccessByKind: Partial<Record<SourceId, Partial<Record<ListItemKind, string>>>>;
  /** 每个平台最近一次连接状态。 */
  sessions: Partial<Record<SourceId, SessionStatus>>;
  /** 已触发提醒记录，用于幂等去重。 */
  reminders: ReminderRecord[];
  /** 用户手动覆盖（键为 assignment.id）。一期仅作业。 */
  overrides: Record<string, { dueAt?: string | null; submissionStatus?: string; at: string }>;
}

const defaults: StoreSchema = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  settings: DEFAULT_SETTINGS,
  assignments: { ulearning: [], hw: [] },
  exams: { ulearning: [], hw: [] },
  lastSuccess: {},
  lastSuccessByKind: {},
  sessions: {},
  reminders: [],
  overrides: {},
};

/**
 * electron-store 的 `conf` 在非 Electron 环境（例如 Vitest / 纯 Node 脚本）下
 * 不会自动获取 app.getVersion()，会抛 "Please specify the projectVersion option"。
 * 该选项在 electron-store 的 TS 类型里没有声明，因此用函数 + 显式断言注入，
 * 既保证类型检查通过，又保证测试环境可运行。
 */
function projectVersionOption(): Record<string, unknown> {
  return { projectVersion: '0.1.0' };
}

export class AppStore {
  private readonly store: Store<StoreSchema>;

  constructor(cwd?: string) {
    this.store = new Store<StoreSchema>({
      name: 'dgut-deadline',
      defaults,
      ...(cwd ? { cwd } : {}),
      ...projectVersionOption(),
      // 迁移入口：未来 schema 变化在此处逐版本升级
      migrations: {},
    });
    this.migrate();
  }

  private migrate(): void {
    const v = this.store.get('schemaVersion');
    if (v === undefined || v === null) {
      this.store.set('schemaVersion', SETTINGS_SCHEMA_VERSION);
      // 全新/损坏文件：仍要保证新键存在，否则后续读取拿到 undefined
      this.ensureNewKeys();
      return;
    }
    if (v >= SETTINGS_SCHEMA_VERSION) {
      // 幂等：重复启动不重复迁移，但要兜底补齐可能缺失的新键
      this.ensureNewKeys();
      return;
    }

    // ── v1 → v2：thresholdsHours(number[]) 升级为 thresholds(ThresholdSetting[]) ──
    if (v < 2) {
      const raw = this.store.get('settings') as unknown as Record<string, unknown> | undefined;
      if (raw && typeof raw === 'object') {
        const old = raw['thresholdsHours'];
        const alreadyNew = raw['thresholds'];
        if (!alreadyNew && Array.isArray(old)) {
          const migrated: ThresholdSetting[] = (old as unknown[])
            .map((h) => Number(h))
            .filter((h) => Number.isFinite(h) && h > 0 && h <= 24 * 30)
            .map((hours) => ({
              hours: Math.round(hours),
              enabled: true,
              // 迁移时：<=12h 的视为强制提醒（符合新的默认策略）
              urgent: hours <= 12,
            }));
          // 补齐新默认里没有、但旧配置里也没有的强制阈值（12/6/1）
          for (const d of DEFAULT_THRESHOLDS) {
            if (!migrated.some((m) => m.hours === d.hours) && d.urgent && d.hours <= 12) {
              migrated.push({ ...d });
            }
          }
          if (migrated.length > 0) {
            (raw as Record<string, unknown>)['thresholds'] = migrated.sort((a, b) => b.hours - a.hours);
            delete (raw as Record<string, unknown>)['thresholdsHours'];
            this.store.set('settings', raw as unknown as AppSettings);
          }
        }
      }
    }

    // ── v2 → v3：新增 exams / lastSuccessByKind / examThresholds，并给旧缓存补 kind ──
    if (v < 3) {
      // 1) 旧缓存补 kind:'homework'
      //    v2 期间写入的数据没有 kind 字段，缺了会让运行时的 kind 判断落到 undefined 分支
      for (const source of ['ulearning', 'hw'] as SourceId[]) {
        const list = (this.store.get(`assignments.${source}`) ?? []) as Array<
          Assignment & { kind?: string }
        >;
        if (!Array.isArray(list) || list.length === 0) continue;
        let changed = false;
        const fixed = list.map((item) => {
          if (item && item.kind === 'homework') return item as Assignment;
          changed = true;
          return { ...item, kind: 'homework' } as Assignment;
        });
        if (changed) this.store.set(`assignments.${source}`, fixed);
      }
      // 2) 设置补新字段（不动 thresholds —— 那是用户已配置的作业阈值）
      const s = this.store.get('settings') as unknown as Record<string, unknown> | undefined;
      if (s && typeof s === 'object') {
        let dirty = false;
        if (!Array.isArray(s['examThresholds']) || (s['examThresholds'] as unknown[]).length === 0) {
          s['examThresholds'] = DEFAULT_EXAM_THRESHOLDS.map((t) => ({ ...t }));
          dirty = true;
        }
        if (typeof s['examSyncEnabled'] !== 'boolean') {
          // 只在**字段缺失**时补默认值（用户 2026-11-11 决策：默认开启）。
          // 不能无条件写 false —— 那会把用户已有的选择覆盖掉。
          s['examSyncEnabled'] = DEFAULT_SETTINGS.examSyncEnabled;
          dirty = true;
        }
        if (typeof s['endedExamRetentionHours'] !== 'number') {
          s['endedExamRetentionHours'] = 24;
          dirty = true;
        }
        if (dirty) this.store.set('settings', s as unknown as AppSettings);
      }
    }

    this.ensureNewKeys();
    this.store.set('schemaVersion', SETTINGS_SCHEMA_VERSION);
  }

  /** 补齐 v3 新键（幂等；供首次启动、迁移后、以及损坏文件兜底）。 */
  private ensureNewKeys(): void {
    if (!this.store.has('exams')) {
      this.store.set('exams', { ulearning: [], hw: [] });
    }
    if (!this.store.has('lastSuccessByKind')) {
      this.store.set('lastSuccessByKind', {});
    }
    const s = this.store.get('settings') as unknown as Record<string, unknown> | undefined;
    if (s && typeof s === 'object') {
      let dirty = false;
      if (!Array.isArray(s['examThresholds'])) {
        s['examThresholds'] = DEFAULT_EXAM_THRESHOLDS.map((t) => ({ ...t }));
        dirty = true;
      }
      if (typeof s['examSyncEnabled'] !== 'boolean') {
        // 只在字段缺失时补默认值，不覆盖用户已保存的选择。
        s['examSyncEnabled'] = DEFAULT_SETTINGS.examSyncEnabled;
        dirty = true;
      }
      if (dirty) this.store.set('settings', s as unknown as AppSettings);
    }
  }

  getSettings(): AppSettings {
    const s = this.store.get('settings') as AppSettings & { thresholdsHours?: number[] };
    const out: AppSettings = { ...DEFAULT_SETTINGS, ...s };
    // 兜底：若仍是旧字段，实时转换（防止迁移漏掉的边缘情况）
    if (!Array.isArray(out.thresholds) || out.thresholds.length === 0) {
      const legacy = (s as { thresholdsHours?: number[] }).thresholdsHours;
      out.thresholds = Array.isArray(legacy) && legacy.length > 0
        ? legacy.map((hours) => ({ hours, enabled: true, urgent: hours <= 12 }))
        : DEFAULT_THRESHOLDS.map((t) => ({ ...t }));
    }
    if (!Array.isArray(out.examThresholds) || out.examThresholds.length === 0) {
      out.examThresholds = DEFAULT_EXAM_THRESHOLDS.map((t) => ({ ...t }));
    }
    return out;
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.getSettings(), ...patch };
    this.store.set('settings', next);
    return next;
  }

  // ── 作业缓存 ────────────────────────────────────────────────

  getAssignments(source: SourceId): Assignment[] {
    const list = (this.store.get(`assignments.${source}`) ?? []) as Array<
      Assignment & { kind?: string }
    >;
    // 兜底：任何漏补 kind 的旧数据都按作业处理（v2 时期只存在作业）
    return list.map((item) =>
      item && item.kind === 'homework' ? (item as Assignment) : ({ ...item, kind: 'homework' } as Assignment),
    );
  }

  getAllAssignments(): Assignment[] {
    return [...this.getAssignments('ulearning'), ...this.getAssignments('hw')];
  }

  /** 成功同步：整体替换该平台的**作业**缓存（不影响考试缓存）。 */
  replaceAssignments(source: SourceId, list: Assignment[], at: string): void {
    this.store.set(`assignments.${source}`, list);
    this.store.set(`lastSuccess.${source}`, at);
    this.setLastSuccessByKind(source, 'homework', at);
  }

  // ── 考试缓存（与作业完全分开，失败互不影响）─────────────────

  getExamItems(source: SourceId): ExamItem[] {
    return this.store.get(`exams.${source}`) ?? [];
  }

  getAllExamItems(): ExamItem[] {
    return [...this.getExamItems('ulearning'), ...this.getExamItems('hw')];
  }

  /** 成功同步：整体替换该平台的**考试**缓存（不影响作业缓存）。 */
  replaceExamItems(source: SourceId, list: ExamItem[], at: string): void {
    this.store.set(`exams.${source}`, list);
    this.setLastSuccessByKind(source, 'exam', at);
  }

  /** 作业 + 考试合并视图（提醒与快照用）。 */
  getAllListItems(): ListItem[] {
    return [...this.getAllAssignments(), ...this.getAllExamItems()];
  }

  getKindCounts(source: SourceId): { homework: number; exam: number } {
    return {
      homework: this.getAssignments(source).length,
      exam: this.getExamItems(source).length,
    };
  }

  // ── 会话与成功时间 ──────────────────────────────────────────

  /** 失败同步：**保留旧数据**，只更新状态。绝不因为失败而清空。 */
  markSession(source: SourceId, status: SessionStatus): void {
    this.store.set(`sessions.${source}`, status);
  }

  getSession(source: SourceId): SessionStatus | null {
    return this.store.get(`sessions.${source}`) ?? null;
  }

  getLastSuccess(source: SourceId): string | null {
    return this.store.get(`lastSuccess.${source}`) ?? null;
  }

  setLastSuccessByKind(source: SourceId, kind: ListItemKind, at: string): void {
    const all = this.store.get('lastSuccessByKind') ?? {};
    all[source] = { ...(all[source] ?? {}), [kind]: at };
    this.store.set('lastSuccessByKind', all);
  }

  getLastSuccessByKind(source: SourceId, kind: ListItemKind): string | null {
    return this.store.get(`lastSuccessByKind.${source}.${kind}`) ?? null;
  }

  // ── 提醒记录 ────────────────────────────────────────────────

  getReminders(): ReminderRecord[] {
    return this.store.get('reminders') ?? [];
  }

  hasReminder(key: string): boolean {
    return this.getReminders().some((r) => r.key === key);
  }

  addReminder(record: ReminderRecord): void {
    const list = this.getReminders();
    if (list.some((r) => r.key === record.key)) return;
    list.push(record);
    // 只保留最近 2000 条，避免无限增长
    this.store.set('reminders', list.slice(-2000));
  }

  /**
   * 清除某个列表项的提醒记录。
   * 前缀 `${itemId}:`：作业 id 形如 `hw:5841`、考试 id 形如 `ulearning:exam:9001@123`，
   * 两者不可能互相前缀匹配（考试段含 `exam:`）。
   */
  clearRemindersForItem(itemId: string): void {
    const prefix = `${itemId}:`;
    const list = this.getReminders().filter((r) => !r.key.startsWith(prefix));
    this.store.set('reminders', list);
  }

  /** @deprecated 用 clearRemindersForItem；保留以兼容既有调用。 */
  clearRemindersForAssignment(source: SourceId, assignmentId: string): void {
    this.clearRemindersForItem(`${source}:${assignmentId}`);
  }

  // ── 覆盖 ────────────────────────────────────────────────────

  getOverrides(): StoreSchema['overrides'] {
    return this.store.get('overrides') ?? {};
  }

  setOverride(id: string, patch: StoreSchema['overrides'][string]): void {
    const all = this.getOverrides();
    all[id] = { ...all[id], ...patch };
    this.store.set('overrides', all);
  }

  get path(): string {
    return this.store.path;
  }
}
