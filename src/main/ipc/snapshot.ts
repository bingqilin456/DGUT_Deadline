/**
 * 组装给渲染进程的只读快照。
 *
 * 职责边界：渲染进程只拿到"已经脱敏、已经判定"的数据；
 * 不接触 Cookie/Token/会话对象。
 */

import type { SourceId } from '@dgut-deadline/shared';
import { SOURCE_LABELS, dueToMs } from '@dgut-deadline/shared';
import type { AppSnapshot, SourceStateDto, UiAssignment } from '../../shared/ipc.js';
import type { AppStore } from '../store/app-store.js';
import type { SyncEngine } from '../sync/sync-engine.js';
import { detectEdge } from '../browser/session.js';
import { buildDemoAssignments, isDemoAssignment } from '../store/demo-data.js';

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export async function buildSnapshot(store: AppStore, engine: SyncEngine): Promise<AppSnapshot> {
  const now = Date.now();
  const settings = store.getSettings();
  const demoMode = settings.showDemoData === true;

  // 演示模式：用演示数据覆盖列表（真实缓存仍保留，关闭后恢复）
  // 需求硬约束：演示数据必须明确标识，绝不与真实数据混淆。
  const raw = demoMode ? buildDemoAssignments(now) : store.getAllAssignments();
  const overrides = store.getOverrides();

  const assignments: UiAssignment[] = raw.map((a) => {
    const ov = demoMode ? undefined : overrides[a.id];
    const merged = ov
      ? {
          ...a,
          dueAt: ov.dueAt !== undefined ? ov.dueAt : a.dueAt,
          submissionStatus:
            (ov.submissionStatus as typeof a.submissionStatus | undefined) ?? a.submissionStatus,
        }
      : a;
    return {
      ...merged,
      sourceLabel: SOURCE_LABELS[merged.source],
      overridden: Boolean(ov),
      isDemo: isDemoAssignment(merged),
      manuallyOverridden: ov ? { field: 'dueAt', at: ov.at } : undefined,
    };
  });

  // 排序：有截止时间的按升序在前；无截止时间的置底
  assignments.sort((x, y) => {
    const xd = dueToMs(x.dueAt);
    const yd = dueToMs(y.dueAt);
    if (xd === null && yd === null) return x.title.localeCompare(y.title, 'zh-CN');
    if (xd === null) return 1;
    if (yd === null) return -1;
    return xd - yd;
  });

  const sources: SourceStateDto[] = (['hw', 'ulearning'] as SourceId[]).map((source) => {
    const session = store.getSession(source);
    const lastSuccessAt = store.getLastSuccess(source);
    const list = store.getAssignments(source);
    const stale = lastSuccessAt === null || now - Date.parse(lastSuccessAt) > STALE_AFTER_MS;
    return {
      source,
      label: SOURCE_LABELS[source],
      session,
      lastSuccessAt,
      count: list.length,
      stale,
    };
  });

  const failed = sources.filter((s) => s.session && s.session.state !== 'connected');
  const edge = await detectEdge();

  return {
    assignments,
    sources,
    settings: {
      thresholds: settings.thresholds,
      syncIntervalMinutes: settings.syncIntervalMinutes,
      quietHours: settings.quietHours,
      launchAtLogin: settings.launchAtLogin,
      minimizeToTrayOnClose: settings.minimizeToTrayOnClose,
      notifyUnknownStatus: settings.notifyUnknownStatus,
      theme: settings.theme,
      showDemoData: demoMode,
    },
    lastSyncAt: settings.lastSyncAt,
    syncing: engine.isRunning,
    partialFailure: demoMode ? false : failed.length > 0 && failed.length < sources.length,
    allFailed: demoMode ? false : failed.length === sources.length && failed.length > 0,
    browserReady: edge.available,
    demoMode,
  };
}
