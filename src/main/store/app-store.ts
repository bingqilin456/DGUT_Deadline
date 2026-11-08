/**
 * 本地持久化。
 *
 * 使用 electron-store（原子写入 + schema 版本迁移），满足需求中
 * "稳健、支持原子写入和版本迁移的本地存储"。
 *
 * 安全约定：
 *  - 只存课程/作业缓存、设置、提醒记录；绝不存密码。
 *  - 浏览器会话由 Playwright 的 userDataDir 独立管理，不写入本 store。
 *  - 文件位于 app.getPath('userData')，不入 Git。
 */

import Store from 'electron-store';
import type { Assignment, SessionStatus, SourceId } from '@dgut-deadline/shared';
import { DEFAULT_THRESHOLDS, type ThresholdSetting } from '../../shared/thresholds.js';

export const SETTINGS_SCHEMA_VERSION = 2;

export interface AppSettings {
  /**
   * 提醒阈值（可逐项开关 + 标记是否强制弹出）。
   * 默认：72h / 24h 普通提醒；12h / 6h / 3h / 1h 强制弹出。
   */
  thresholds: ThresholdSetting[];
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
   * 打开后会**覆盖**列表显示（真实缓存仍保留，关闭后恢复）。
   */
  showDemoData?: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  thresholds: DEFAULT_THRESHOLDS.map((t) => ({ ...t })),
  syncIntervalMinutes: 30,
  quietHours: { enabled: false, start: '23:00', end: '07:00' },
  launchAtLogin: false,
  minimizeToTrayOnClose: true,
  notifyUnknownStatus: true,
  theme: 'system',
  lastSyncAt: null,
  showDemoData: false,
};

export interface ReminderRecord {
  /** 幂等键：source:assignmentId:dueAt:threshold */
  key: string;
  firedAt: string;
  dueAtAtFire: string | null;
  thresholdHours: number;
}

export interface StoreSchema {
  schemaVersion: number;
  settings: AppSettings;
  /** 按平台缓存的作业（失败时保留旧数据）。 */
  assignments: Record<SourceId, Assignment[]>;
  /** 每个平台最近一次成功同步时间。 */
  lastSuccess: Partial<Record<SourceId, string>>;
  /** 每个平台最近一次连接状态。 */
  sessions: Partial<Record<SourceId, SessionStatus>>;
  /** 已触发提醒记录，用于幂等去重。 */
  reminders: ReminderRecord[];
  /** 用户手动覆盖（键为 assignment.id）。 */
  overrides: Record<string, { dueAt?: string | null; submissionStatus?: string; at: string }>;
}

const defaults: StoreSchema = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  settings: DEFAULT_SETTINGS,
  assignments: { ulearning: [], hw: [] },
  lastSuccess: {},
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
      migrations: {
        // 示例：'0.0.1': (s) => { ... }
      },
    });
    this.migrate();
  }

  private migrate(): void {
    const v = this.store.get('schemaVersion');
    if (v === undefined || v === null) {
      this.store.set('schemaVersion', SETTINGS_SCHEMA_VERSION);
      return;
    }
    if (v < SETTINGS_SCHEMA_VERSION) {
      // v1 -> v2：thresholdsHours(number[]) 升级为 thresholds(ThresholdSetting[])
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
      this.store.set('schemaVersion', SETTINGS_SCHEMA_VERSION);
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
    return out;
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.getSettings(), ...patch };
    this.store.set('settings', next);
    return next;
  }

  getAssignments(source: SourceId): Assignment[] {
    return this.store.get(`assignments.${source}`) ?? [];
  }

  getAllAssignments(): Assignment[] {
    return [...this.getAssignments('ulearning'), ...this.getAssignments('hw')];
  }

  /** 成功同步：整体替换该平台缓存。 */
  replaceAssignments(source: SourceId, list: Assignment[], at: string): void {
    this.store.set(`assignments.${source}`, list);
    this.store.set(`lastSuccess.${source}`, at);
  }

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

  /** 截止时间变更时需要撤销旧的提醒计划。 */
  clearRemindersForAssignment(source: SourceId, assignmentId: string): void {
    const prefix = `${source}:${assignmentId}:`;
    const list = this.getReminders().filter((r) => !r.key.startsWith(prefix));
    this.store.set('reminders', list);
  }

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
