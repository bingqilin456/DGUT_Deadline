/**
 * 提醒调度器：把纯逻辑的 ReminderPlanner 接到真实的提醒显示上。
 *
 * 显示策略（用户需求）：
 *  - **默认使用右下角自定义弹窗**（桌面右下角，需用户点「我已知晓」确认）
 *    同时让应用在任务栏高亮/闪烁
 *  - 系统通知作为**降级方案**（弹窗不可用时）
 *  - 强制提醒（12h/6h/3h/1h）不受静默时段限制
 *
 * 其他设计要点：
 *  - 只在应用运行期间提醒。
 *  - 持久化已触发键，避免每次同步重复弹窗。
 *  - 未确认的提醒会被保留（不静默消失），符合"等用户确认是否收到"的要求。
 *  - 休眠/断网恢复后做补偿扫描，但只补发未超过 24h 的。
 */

import { Notification, shell } from 'electron';
import type { Assignment, SourceId } from '@dgut-deadline/shared';
import { isAllowedDetailUrl } from '@dgut-deadline/shared';
import type { AppStore } from '../store/app-store.js';
import { isInQuietHours, planReminders, reminderText, type PlannedReminder } from './planner.js';
import type { ToastManager } from './toast-manager.js';

/** 调度检查间隔：1 分钟足够精确，也不会造成负担。 */
const TICK_MS = 60_000;

export interface DispatchResult {
  fired: number;
  suppressed: { quiet: number; unsupported: number; duplicate: number };
}

export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** 右下角弹窗管理器（可选；未注入时降级为系统通知）。 */
  private toasts: ToastManager | null = null;

  constructor(
    private readonly store: AppStore,
    private readonly opts: {
      now?: () => number;
      /** 通知点击时的回调（用于聚焦窗口）。 */
      onActivate?: () => void;
      /** 是否真的弹系统通知；测试时可关闭。 */
      showNotification?: (n: { title: string; body: string }) => boolean;
    } = {},
  ) {}

  /** 注入右下角弹窗管理器。 */
  attachToasts(mgr: ToastManager): void {
    this.toasts = mgr;
  }

  /** 供 UI 查询：当前有多少条待确认的提醒。 */
  get pendingToastCount(): number {
    return this.toasts?.count ?? 0;
  }

  /** 用户手动把所有待确认提醒标记为已知晓。 */
  acknowledgeAllPending(): void {
    this.toasts?.acknowledgeAll();
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    // 不阻止进程退出
    this.timer.unref?.();
    // 启动时立即检查一次（覆盖"关机期间错过了"的场景）
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 执行一次扫描并派发通知。并发保护：同一时刻只跑一次。 */
  async tick(): Promise<DispatchResult> {
    const empty: DispatchResult = { fired: 0, suppressed: { quiet: 0, unsupported: 0, duplicate: 0 } };
    if (this.ticking) return empty;
    this.ticking = true;
    try {
      return this.dispatch();
    } finally {
      this.ticking = false;
    }
  }

  private dispatch(): DispatchResult {
    const settings = this.store.getSettings();
    const nowMs = this.now();
    const assignments = this.store.getAllAssignments();
    const firedKeys = new Set(this.store.getReminders().map((r) => r.key));

    const inQuiet = isInQuietHours(nowMs, settings.quietHours);

    const planned = planReminders(assignments, {
      nowMs,
      thresholdsHours: settings.thresholds,
      notifyUnknownStatus: settings.notifyUnknownStatus,
      firedKeys,
      quietHours: settings.quietHours,
    });

    const result: DispatchResult = { fired: 0, suppressed: { quiet: 0, unsupported: 0, duplicate: 0 } };

    if (planned.length === 0) return result;

    // 静默时段：普通提醒不弹窗，但记录已触发（避免静默结束后补弹旧通知）。
    // 【例外】urgent（12h/6h/3h/1h）**强制弹出**，不受静默时段限制——
    // 这是用户在设置里明确勾选"强制弹出"时的预期行为。
    const urgent = planned.filter((r) => r.urgent);
    const normal = planned.filter((r) => !r.urgent);

    if (inQuiet) {
      for (const r of normal) {
        this.record(r);
        result.suppressed.quiet++;
      }
    }

    const usingRealNotifications = !this.opts.showNotification;
    const canNotify =
      !usingRealNotifications ||
      (typeof Notification !== 'undefined' && Notification.isSupported());
    if (!canNotify) {
      result.suppressed.unsupported = planned.length;
      return result;
    }

    // 静默时段内只发 urgent；否则全部发
    const toSend = inQuiet ? urgent : planned;
    if (toSend.length === 0) return result;

    // 优先用右下角弹窗（需用户确认）；不可用时降级到系统通知
    if (this.toasts && !usingRealNotifications) {
      // 测试注入模式：走注入的回调
      for (const r of toSend) {
        const ok = this.show(r, assignments);
        if (ok) {
          this.record(r);
          result.fired++;
        } else {
          result.suppressed.unsupported++;
        }
      }
      return result;
    }

    if (this.toasts) {
      // 真实模式：右下角弹窗 + 任务栏闪烁
      this.toasts.push(toSend);
      for (const r of toSend) this.record(r);
      result.fired = toSend.length;
      this.opts.onActivate?.();
      return result;
    }

    // 降级：系统通知
    for (const r of toSend) {
      const ok = this.show(r, assignments);
      if (ok) {
        this.record(r);
        result.fired++;
      } else {
        result.suppressed.unsupported++;
      }
    }
    return result;
  }

  private record(r: PlannedReminder): void {
    this.store.addReminder({
      key: r.key,
      firedAt: new Date(this.now()).toISOString(),
      dueAtAtFire: r.dueAt,
      thresholdHours: r.thresholdHours,
    });
  }

  private show(r: PlannedReminder, assignments: readonly Assignment[]): boolean {
    const text = reminderText(r);
    const assignment = assignments.find((a) => a.id === r.assignmentId);

    if (this.opts.showNotification) {
      return this.opts.showNotification(text);
    }

    try {
      const n = new Notification({
        title: text.title,
        body: text.body,
        silent: false,
      });

      n.on('click', () => {
        this.opts.onActivate?.();
        // 点击后打开源站（已过 allowlist 校验），不携带任何 token
        if (assignment && isAllowedDetailUrl(assignment.source, assignment.detailUrl)) {
          void shell.openExternal(assignment.detailUrl!);
        }
      });

      n.show();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 休眠/断网恢复后的补偿：立即跑一次扫描。
   * 由于 planReminders 已限制"过期超过 24h 不补发"，这里天然不会造成通知轰炸。
   */
  async compensate(): Promise<DispatchResult> {
    return this.tick();
  }

  /** 供 UI 预览：返回接下来会触发的提醒（不实际发送）。 */
  preview(): PlannedReminder[] {
    const settings = this.store.getSettings();
    const nowMs = this.now();
    const firedKeys = new Set(this.store.getReminders().map((r) => r.key));
    return planReminders(this.store.getAllAssignments(), {
      nowMs,
      thresholdsHours: settings.thresholds,
      notifyUnknownStatus: settings.notifyUnknownStatus,
      firedKeys,
      quietHours: settings.quietHours,
    });
  }
}

export type { SourceId };
