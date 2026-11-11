/**
 * 桌面右下角提醒弹窗 + 任务栏高亮。
 *
 * 用户需求：
 *  1. 提醒在**屏幕右下角**以自定义窗口显示（不用系统横幅，因为系统横幅会被
 *     勿扰模式拦截，且无法要求"确认收到"）
 *  2. 应用在**任务栏高亮/闪烁**，吸引注意
 *  3. 必须**用户确认收到**后才消失（未确认则一直保留并持续提醒）
 *
 * 设计：
 *  - 一个独立 BrowserWindow（无边框、置顶、跳过任务栏、不进入 Alt-Tab）
 *  - 多条提醒时纵向堆叠
 *  - 点击「我已知晓」→ 回报给调度器 → 记录确认
 *  - 用户忽略时，定时重新置顶并再次闪烁任务栏
 */

import { BrowserWindow, app, screen, shell } from 'electron';
import { join } from 'node:path';
import type { PlannedReminder } from '../reminder/planner.js';
import { reminderText } from '../reminder/planner.js';
import { isAllowedDetailUrl } from '@dgut-deadline/shared';

/** 单个弹窗卡片需要的数据（定义在 src/shared/toast.ts，三方共用）。 */
export type { ToastItem } from '../../shared/toast.js';
import type { ToastItem } from '../../shared/toast.js';

const CARD_W = 380;
const CARD_H = 116;
const GAP = 10;
const MARGIN = 16;

/**
 * 右下角提醒窗口管理器。
 */
export class ToastManager {
  private win: BrowserWindow | null = null;
  private items: ToastItem[] = [];
  private blinkTimer: NodeJS.Timeout | null = null;
  private reassertTimer: NodeJS.Timeout | null = null;
  private readonly rtl: boolean;

  constructor(
    private readonly opts: {
      /** 用户确认收到后的回调。 */
      onAcknowledge: (keys: string[]) => void;
      /** 点击卡片正文时的回调（打开源站）。 */
      onOpen?: (key: string) => void;
      /** 关闭全部（用户点了全部确认）。 */
      onAllAcknowledged?: () => void;
    },
  ) {
    // Electron 的 app.getLocale 可判断语言方向；中文是 LTR
    this.rtl = false;
  }

  /** 当前是否显示中。 */
  get isVisible(): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.isVisible();
  }

  get count(): number {
    return this.items.length;
  }

  /** 追加提醒（已存在的 key 不重复添加）。 */
  push(reminders: readonly PlannedReminder[]): void {
    const existing = new Set(this.items.map((i) => i.key));
    let added = 0;
    for (const r of reminders) {
      if (existing.has(r.key)) continue;
      this.items.push(this.toItem(r));
      existing.add(r.key);
      added++;
    }
    if (added === 0) return;
    this.render();
    this.startAttention();
  }

  /** 移除已确认的项。 */
  remove(keys: string[]): void {
    const set = new Set(keys);
    this.items = this.items.filter((i) => !set.has(i.key));
    if (this.items.length === 0) {
      this.close();
    } else {
      this.render();
    }
  }

  /** 关闭窗口并清理定时器。 */
  close(): void {
    this.stopAttention();
    if (this.win && !this.win.isDestroyed()) {
      this.win.close();
    }
    this.win = null;
    this.items = [];
  }

  /** 确认全部。 */
  acknowledgeAll(): void {
    const keys = this.items.map((i) => i.key);
    if (keys.length === 0) return;
    this.opts.onAcknowledge(keys);
    this.opts.onAllAcknowledged?.();
    this.remove(keys);
  }

  // ── 内部 ─────────────────────────────────────────────

  private toItem(r: PlannedReminder): ToastItem {
    // 文案统一由 planner 产出：作业与考试措辞完全不同，
    // 这里另写一套会产出"作业即将截止"这类错误文案（考试用的是开考时间）。
    const text = reminderText(r);

    return {
      key: r.key,
      title: text.title,
      body: text.body,
      urgent: r.urgent,
      detailUrl: null,
      courseName: r.courseName,
      assignmentTitle: r.title,
      thresholdHours: r.thresholdHours,
      kind: r.kind,
    };
  }

  /** 计算窗口位置与尺寸（右下角，多卡片纵向堆叠）。 */
  private geometry(): { x: number; y: number; width: number; height: number } {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const wa = display.workArea; // 排除任务栏的可用区域

    const n = Math.min(this.items.length, 5); // 最多同时显示 5 条
    const width = CARD_W + MARGIN * 2;
    const height = n * CARD_H + Math.max(0, n - 1) * GAP + MARGIN * 2;

    const x = wa.x + wa.width - width - MARGIN;
    const y = wa.y + wa.height - height - MARGIN;
    return { x: Math.round(x), y: Math.round(y), width, height };
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;

    const g = this.geometry();
    const win = new BrowserWindow({
      width: g.width,
      height: g.height,
      x: g.x,
      y: g.y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true, // 弹窗本身不进任务栏（任务栏高亮由主窗口负责）
      alwaysOnTop: true,
      show: false,
      focusable: true,
      hasShadow: true,
      webPreferences: {
        preload: join(__dirname, '../preload/toast.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    // 置顶到最高层级（高于全屏应用）
    win.setAlwaysOnTop(true, 'screen-saver');

    win.loadFile(join(__dirname, '../renderer/toast.html'));
    win.once('ready-to-show', () => {
      win.showInactive(); // 不抢焦点，但可见
      this.pushData();
    });

    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });

    this.win = win;
    return win;
  }

  /** 把数据推给渲染进程。 */
  private pushData(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('toast:items', this.items);
  }

  private render(): void {
    const win = this.ensureWindow();
    const g = this.geometry();
    win.setBounds(g);
    win.setAlwaysOnTop(true, 'screen-saver');
    if (!win.isVisible()) win.showInactive();
    this.pushData();
  }

  /**
   * 吸引注意：任务栏闪烁 + 周期性重新置顶。
   *
   * Electron 的 `flashFrame(true)` 在 Windows 上会让任务栏图标闪烁，
   * 直到用户聚焦窗口或调用 flashFrame(false)。
   */
  private startAttention(): void {
    this.stopAttention();

    // 任务栏闪烁
    if (this.win && !this.win.isDestroyed()) {
      this.win.flashFrame(true);
    }

    // 每 20 秒重新置顶一次，防止被其它窗口盖住（用户忽略时）
    this.reassertTimer = setInterval(() => {
      if (!this.win || this.win.isDestroyed()) return;
      if (this.items.length === 0) return;
      this.win.setAlwaysOnTop(true, 'screen-saver');
      this.win.moveTop?.();
      // 继续闪烁，直到用户确认
      this.win.flashFrame(true);
    }, 20_000);
    this.reassertTimer.unref?.();
  }

  private stopAttention(): void {
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    if (this.reassertTimer) {
      clearInterval(this.reassertTimer);
      this.reassertTimer = null;
    }
    if (this.win && !this.win.isDestroyed()) {
      this.win.flashFrame(false);
    }
  }

  /** 处理渲染进程的确认请求。 */
  handleAcknowledge(keys: string[]): void {
    const valid = keys.filter((k) => this.items.some((i) => i.key === k));
    if (valid.length === 0) return;
    this.opts.onAcknowledge(valid);
    this.remove(valid);
  }

  /** 处理"打开源站"。 */
  handleOpen(key: string): void {
    const item = this.items.find((i) => i.key === key);
    if (!item) return;
    this.opts.onOpen?.(key);
    if (item.detailUrl) {
      void shell.openExternal(item.detailUrl);
    }
  }
}

/** 供 main 进程判断是否支持的辅助。 */
export function toastSupported(): boolean {
  return app.isReady();
}
