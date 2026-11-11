/**
 * 主进程入口。
 *
 * 安全基线（Electron 官方建议 + 需求硬约束）：
 *  - contextIsolation: true, sandbox: true, nodeIntegration: false
 *  - preload 仅通过 contextBridge 暴露白名单方法
 *  - 禁止渲染进程发起任意导航 / 打开新窗口（will-navigate / setWindowOpenHandler）
 *  - 校网页运行在独立的 Playwright 浏览器中，与 Electron 渲染进程完全隔离，
 *    不向校网页暴露任何系统 API。
 */

import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, powerMonitor, shell } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { SourceId } from '@dgut-deadline/shared';
import { AppStore } from './store/app-store.js';
import { SyncEngine } from './sync/sync-engine.js';
import { HwAssignmentSource } from './sources/hw-source.js';
import { UlearningAssignmentSource } from './sources/ulearning-source.js';
import { buildSnapshot } from './ipc/snapshot.js';
import { detectEdge } from './browser/session.js';
import { ReminderScheduler } from './reminder/scheduler.js';
import { ToastManager } from './reminder/toast-manager.js';
import { normalizeExamThresholds, normalizeThresholds } from '../shared/thresholds.js';
import { isAllowedDetailUrl } from '@dgut-deadline/shared';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const store = new AppStore();
const userData = app.getPath('userData');
const profileRoot = join(userData, 'browser-profile');
mkdirSync(profileRoot, { recursive: true });

const sources = new Map<SourceId, HwAssignmentSource | UlearningAssignmentSource>([
  ['hw', new HwAssignmentSource({ userDataDir: join(profileRoot, 'hw') })],
  ['ulearning', new UlearningAssignmentSource({ userDataDir: join(profileRoot, 'ulearning') })],
]);

const engine = new SyncEngine(store, sources);

/**
 * 右下角提醒弹窗管理器。
 *
 * 用户需求：提醒在桌面右下角显示，应用在任务栏高亮，且**必须用户确认收到**。
 * 确认后写入 store（reminders 已有记录，这里只是 UI 层的确认），
 * 未确认时弹窗持续存在并周期性闪烁任务栏。
 */
const toastManager = new ToastManager({
  onAcknowledge: (keys) => {
    // 已触发记录已在派发时写入；这里只需停止任务栏闪烁
    stopTaskbarAttention();
    // 让主窗口刷新一次（待确认数量变化）
    void broadcast();
    void keys;
  },
  onAllAcknowledged: () => {
    stopTaskbarAttention();
  },
});

/** 提醒调度器：把提醒逻辑接到右下角弹窗（不可用时降级系统通知）。 */
const reminderScheduler = new ReminderScheduler(store, {
  onActivate: () => {
    // 有新提醒时：主窗口在任务栏高亮闪烁，吸引注意
    startTaskbarAttention();
  },
});
reminderScheduler.attachToasts(toastManager);

/** 任务栏闪烁状态。 */
let taskbarFlashTimer: NodeJS.Timeout | null = null;

/** 让主窗口在任务栏闪烁，直到用户确认或聚焦。 */
function startTaskbarAttention(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.flashFrame(true);
  } catch {
    // 某些平台/窗口状态不支持，忽略
  }
  if (taskbarFlashTimer) clearInterval(taskbarFlashTimer);
  taskbarFlashTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (reminderScheduler.pendingToastCount === 0) {
      stopTaskbarAttention();
      return;
    }
    try {
      mainWindow.flashFrame(true);
    } catch {
      // 忽略
    }
  }, 15_000);
  taskbarFlashTimer.unref?.();
}

/** 停止任务栏闪烁。 */
function stopTaskbarAttention(): void {
  if (taskbarFlashTimer) {
    clearInterval(taskbarFlashTimer);
    taskbarFlashTimer = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.flashFrame(false);
    } catch {
      // 忽略
    }
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: '莞工 Deadline',
    backgroundColor: '#f7f8fa',
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 用户聚焦主窗口时停止任务栏闪烁（但待确认的提醒仍然保留在右下角）
  win.on('focus', () => {
    try {
      win.flashFrame(false);
    } catch {
      // 忽略
    }
  });

  // 关闭窗口 -> 最小化到托盘（可设置）
  win.on('close', (e) => {
    if (!quitting && store.getSettings().minimizeToTrayOnClose) {
      e.preventDefault();
      win.hide();
      ensureTrayAlive();
    }
  });

  // 兜底：若窗口最终还是被销毁（例如渲染进程调用 window.close() 绕过 close 事件），
  // 必须保证托盘仍在，否则用户无法再唤回应用。
  win.on('closed', () => {
    if (quitting) return;
    if (mainWindow === win) mainWindow = null;
    ensureTrayAlive();
    // 若设置为托盘驻留，则重建一个隐藏窗口以便托盘点击能唤回
    if (store.getSettings().minimizeToTrayOnClose) {
      // 延迟到当前事件循环之后，避免在 closed 回调里同步创建窗口
      setTimeout(() => {
        if (!quitting && (!mainWindow || mainWindow.isDestroyed())) {
          mainWindow = createWindow();
          mainWindow.hide();
        }
      }, 50);
    }
  });

  // 安全：禁止任意导航
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl && url.startsWith(devUrl)) return;
    e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 只允许在系统浏览器打开白名单链接
    if (/^https:\/\/(hw|lms)\.dgut\.edu\.cn\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(join(__dirname, '../renderer/index.html'));

  return win;
}

async function broadcast(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const snap = await buildSnapshot(store, engine);
  mainWindow.webContents.send('app:snapshot', snap);
}

function registerIpc(): void {
  // ── 右下角提醒弹窗的通道 ──────────────────────────────
  ipcMain.on('toast:acknowledge', (_e, keys: unknown) => {
    if (Array.isArray(keys)) {
      toastManager.handleAcknowledge(keys.filter((k) => typeof k === 'string') as string[]);
    }
  });
  ipcMain.on('toast:open', (_e, key: unknown) => {
    if (typeof key === 'string') {
      // 打开主窗口并定位（不直接开外部链接，避免误操作）
      showMainWindow();
      toastManager.handleOpen(key);
    }
  });
  ipcMain.on('toast:ready', () => {
    // 弹窗就绪，无需额外动作（数据由 pushData 推送）
  });

  /** 手动确认全部待确认提醒。 */
  ipcMain.handle('app:acknowledgeReminders', async () => {
    reminderScheduler.acknowledgeAllPending();
    stopTaskbarAttention();
    return { ok: true };
  });

  ipcMain.handle('app:getSnapshot', async () => buildSnapshot(store, engine));

  ipcMain.handle('app:syncNow', async () => {
    await engine.syncAll();
    store.setSettings({ lastSyncAt: new Date().toISOString() });
    await broadcast();
    return buildSnapshot(store, engine);
  });

  ipcMain.handle('app:login', async (_e, source: SourceId) => {
    const src = sources.get(source);
    if (src) {
      // 打开受控浏览器让用户手工登录；不代填任何凭证
      await src.connect();
      if (mainWindow) mainWindow.show();
      await broadcast();
    }
    return buildSnapshot(store, engine);
  });

  ipcMain.handle('app:openAssignment', async (_e, id: string) => {
    // 作业与考试都可能被「打开」：用合并视图查找
    const all = store.getAllListItems();
    const found = all.find((a) => a.id === id);
    if (!found) return { ok: false, reason: '该条目不存在（可能已被平台移除）' };
    if (!isAllowedDetailUrl(found.source, found.detailUrl)) {
      return { ok: false, reason: '该链接不在允许列表内，已阻止打开' };
    }
    await shell.openExternal(found.detailUrl!);
    return { ok: true };
  });

  ipcMain.handle('app:updateSettings', async (_e, patch: Record<string, unknown>) => {
    // 主进程侧重新校验，渲染进程不可信
    const safe: Record<string, unknown> = {};
    if (Array.isArray(patch['thresholds'])) {
      const normalized = normalizeThresholds(patch['thresholds']);
      if (normalized.length) safe['thresholds'] = normalized;
    }
    if (Array.isArray(patch['examThresholds'])) {
      const normalized = normalizeExamThresholds(patch['examThresholds']);
      if (normalized.length) safe['examThresholds'] = normalized;
    }
    if (typeof patch['examSyncEnabled'] === 'boolean') {
      safe['examSyncEnabled'] = patch['examSyncEnabled'];
    }
    if (typeof patch['endedExamRetentionHours'] === 'number') {
      const v = Math.max(0, Math.min(24 * 30, Math.floor(patch['endedExamRetentionHours'] as number)));
      safe['endedExamRetentionHours'] = v;
    }
    if (typeof patch['syncIntervalMinutes'] === 'number') {
      const v = Math.max(0, Math.min(24 * 60, Math.floor(patch['syncIntervalMinutes'] as number)));
      safe['syncIntervalMinutes'] = v;
    }
    if (typeof patch['launchAtLogin'] === 'boolean') {
      safe['launchAtLogin'] = patch['launchAtLogin'];
      // 显式指定 name，避免注册表项名变成 "electron.app.Electron" 这种非产品名，
      // 用户在两处（设置→启动应用、任务管理器→启动）看到的名称应一致。
      app.setLoginItemSettings({
        openAtLogin: patch['launchAtLogin'] as boolean,
        name: '莞工 Deadline',
      });
    }
    if (typeof patch['minimizeToTrayOnClose'] === 'boolean') {
      safe['minimizeToTrayOnClose'] = patch['minimizeToTrayOnClose'];
    }
    if (typeof patch['notifyUnknownStatus'] === 'boolean') {
      safe['notifyUnknownStatus'] = patch['notifyUnknownStatus'];
    }
    if (typeof patch['showDemoData'] === 'boolean') {
      safe['showDemoData'] = patch['showDemoData'];
    }
    if (patch['theme'] === 'light' || patch['theme'] === 'dark' || patch['theme'] === 'system') {
      safe['theme'] = patch['theme'];
    }
    const q = patch['quietHours'] as Record<string, unknown> | undefined;
    if (q && typeof q === 'object') {
      const toTime = (v: unknown): string | null => {
        if (typeof v !== 'string') return null;
        return /^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim() : null;
      };
      const start = toTime(q['start']);
      const end = toTime(q['end']);
      const enabled = typeof q['enabled'] === 'boolean' ? q['enabled'] : undefined;
      if (start && end) {
        safe['quietHours'] = {
          enabled: enabled ?? store.getSettings().quietHours.enabled,
          start,
          end,
        };
      }
    }
    store.setSettings(safe);
    await broadcast();
    return buildSnapshot(store, engine);
  });

  ipcMain.handle('app:testNotification', async () => {
    const supported = Notification.isSupported();
    if (!supported) {
      return {
        supported: false,
        shown: false,
        reason: '当前系统不支持通知，或 Windows 通知已被系统策略禁用。',
        pendingReminders: reminderScheduler.preview().length,
      };
    }
    try {
      const n = new Notification({
        title: '莞工 Deadline 通知测试',
        body: '如果你看到这条通知，说明 Windows 通知工作正常。点击可打开主窗口。',
      });
      n.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      });
      n.show();

      // 关键：show() 不抛错 ≠ 用户看得见。
      // Windows 开启「勿扰模式」时通知会被静默拦截，只进通知中心不弹窗。
      // 这里给出可操作的排查提示，而不是让用户以为应用坏了。
      return {
        supported: true,
        shown: true,
        pendingReminders: reminderScheduler.preview().length,
        hint:
          '如果没看到弹窗，请检查：① 任务栏是否有「请勿打扰」图标（开启时通知不会弹出）；' +
          '② 设置 → 系统 → 通知 中是否允许「莞工Deadline」；③ 是否处于全屏/演示模式。',
      };
    } catch (err) {
      return {
        supported: true,
        shown: false,
        reason: err instanceof Error ? err.message : String(err),
        pendingReminders: reminderScheduler.preview().length,
      };
    }
  });

  ipcMain.handle('app:diagnoseSource', async (_e, source: SourceId) => {
    const generatedAt = new Date().toISOString();
    try {
      if (source === 'ulearning') {
        const src = sources.get('ulearning');
        if (src && 'diagnose' in src) {
          const d = await (src as UlearningAssignmentSource).diagnose();
          return { source, generatedAt, ...d };
        }
        return {
          source,
          generatedAt,
          steps: [],
          blockedAt: 'unavailable',
          summary: 'LMS 适配器不可用。',
        };
      }
      // hw 平台：用会话检查结果构造一个简单诊断
      const src = sources.get('hw');
      const st = src ? await src.checkSession() : null;
      return {
        source,
        generatedAt,
        steps: [
          {
            id: 'hw-session',
            label: '莞工作业平台会话',
            ok: st?.state === 'connected',
            detail: st ? `${st.state}: ${st.message}` : '适配器不可用',
          },
        ],
        blockedAt: st?.state === 'connected' ? null : 'hw-session',
        summary: st?.state === 'connected' ? '莞工作业平台链路正常。' : (st?.message ?? '未知'),
      };
    } catch (err) {
      return {
        source,
        generatedAt,
        steps: [],
        blockedAt: 'error',
        summary: `诊断失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  ipcMain.handle('app:exportDiagnostics', async () => {
    try {
      const edge = await detectEdge();
      const snap = await buildSnapshot(store, engine);
      // 脱敏：绝不包含 Cookie/Token/密码/完整作业标题以外敏感信息
      const diag = {
        generatedAt: new Date().toISOString(),
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        edge,
        storePath: store.path,
        settings: snap.settings,
        sources: snap.sources,
        assignmentCount: snap.assignments.length,
        // 仅统计，不导出正文。必须按 kind 分组：
        // 考试项没有 submissionStatus，直接取会得到 "undefined" 桶（既有缺陷）。
        kindCounts: snap.assignments.reduce<Record<string, number>>((acc, a) => {
          acc[a.kind] = (acc[a.kind] ?? 0) + 1;
          return acc;
        }, {}),
        statusCounts: snap.assignments.reduce<Record<string, number>>((acc, a) => {
          if (a.kind !== 'homework') return acc;
          acc[a.submissionStatus] = (acc[a.submissionStatus] ?? 0) + 1;
          return acc;
        }, {}),
      };
      const dir = join(app.getPath('downloads'), 'dgut-deadline-diagnostics');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `diagnostics-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(diag, null, 2), 'utf8');
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** 资源路径解析：开发态用项目 resources/，打包后用 process.resourcesPath。 */
function resourcePath(name: string): string {
  const devPath = join(app.getAppPath(), 'resources', name);
  if (existsSync(devPath)) return devPath;
  const packed = join(process.resourcesPath, name);
  if (existsSync(packed)) return packed;
  return devPath;
}

/** 窗口图标（ICO 优先，Windows 下高 DPI 更清晰）。 */
function appIconPath(): string | undefined {
  for (const name of ['icon.ico', 'icon.png']) {
    const p = resourcePath(name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * 托盘强引用。
 *
 * 【实测缺陷】仅用模块级 `let tray` 时，窗口隐藏后托盘图标会从任务栏消失，
 * 导致应用变成"进程还在但无法唤回"的僵尸状态。
 * 这里用数组额外持有引用，防止被 GC 回收，并在 hide 后主动校验/重建。
 */
const trayRefs: Tray[] = [];

function createTray(): void {
  // 使用真实托盘图标；缺失时回退为空图标（但会记录警告，不静默失败）
  const trayIconPath = resourcePath('tray.png');
  let icon = nativeImage.createFromPath(trayIconPath);
  if (icon.isEmpty()) {
    console.warn('[tray] 托盘图标加载失败，路径：', trayIconPath);
    icon = nativeImage.createEmpty();
  } else {
    icon = icon.resize({ width: 16, height: 16 });
  }
  tray = new Tray(icon);
  // 强引用，防止 GC 导致托盘消失
  trayRefs.push(tray);
  tray.setToolTip('莞工 Deadline');
  const menu = Menu.buildFromTemplate([
    {
      label: '打开主窗口',
      click: () => showMainWindow(),
    },
    {
      label: '立即同步',
      click: () => {
        void engine.syncAll().then(broadcast);
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        showMainWindow();
      }
    } else {
      // 窗口已被销毁：重建一个
      mainWindow = createWindow();
    }
  });
}

/** 显示主窗口（若已销毁则重建）。 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/**
 * 确保托盘图标仍存在。
 *
 * 实测：`win.hide()` 之后托盘图标会从 Windows 任务栏消失。
 * 这里在每次隐藏后重建托盘，保证用户始终能通过托盘唤回窗口。
 */
function ensureTrayAlive(): void {
  try {
    if (tray) {
      // setToolTip 是轻量操作；若托盘已失效，下面的 checks 会兜底
      tray.setToolTip('莞工 Deadline');
      return;
    }
  } catch {
    // 托盘已失效，走重建
  }
  tray = null;
  createTray();
}

/** 定时同步。 */
let syncTimer: NodeJS.Timeout | null = null;
function scheduleSync(): void {
  if (syncTimer) clearInterval(syncTimer);
  const minutes = store.getSettings().syncIntervalMinutes;
  if (!minutes || minutes <= 0) return;
  syncTimer = setInterval(
    () => {
      if (engine.isRunning) return;
      void engine.syncAll().then(broadcast);
    },
    minutes * 60 * 1000,
  );
}

app.whenReady().then(async () => {
  registerIpc();
  mainWindow = createWindow();
  createTray();
  scheduleSync();

  // 启动提醒调度：1 分钟一拍，启动时立即补偿一次
  reminderScheduler.start();

  // 系统休眠/恢复：恢复后立即补偿扫描（planReminders 已限制过期 >24h 不补发）
  powerMonitor.on('resume', () => {
    void reminderScheduler.compensate().then((r) => {
      if (r.fired > 0) void broadcast();
    });
  });

  // 同步成功后重新评估提醒（新数据可能跨过阈值）
  // 由 syncNow / 定时同步的 then(broadcast) 之后的调度器 tick 自然覆盖
});

app.on('before-quit', () => {
  quitting = true;
  reminderScheduler.stop();
  toastManager.close();
  stopTaskbarAttention();
  if (syncTimer) clearInterval(syncTimer);
  void engine.closeAll();
});

app.on('window-all-closed', () => {
  // Windows 上保持托盘驻留；真正退出由托盘菜单触发
  if (quitting) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
  }
});

export { isAllowedDetailUrl };
