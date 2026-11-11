/**
 * 组装给渲染进程的只读快照。
 *
 * 职责边界：渲染进程只拿到"已经脱敏、已经判定"的数据；
 * 不接触 Cookie/Token/会话对象。
 *
 * 作业与考试在此合流为一个 UiAssignment 联合（靠 `kind` 收窄），
 * 但**排序锚点不同**：作业看截止时间，考试看开考时间。统一用 anchorOf()。
 */

import type { ExamItem, ListItem, ListItemKind, SourceId } from '@dgut-deadline/shared';
import { SOURCE_LABELS, anchorOf, dueToMs, isExamItem } from '@dgut-deadline/shared';
import type { AppSnapshot, SourceStateDto, UiAssignment } from '../../shared/ipc.js';
import type { AppStore } from '../store/app-store.js';
import type { SyncEngine } from '../sync/sync-engine.js';
import { detectEdge } from '../browser/session.js';
import {
  buildDemoAssignments,
  buildDemoExams,
  isDemoAssignment,
  isDemoExam,
} from '../store/demo-data.js';

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export async function buildSnapshot(store: AppStore, engine: SyncEngine): Promise<AppSnapshot> {
  const now = Date.now();
  const settings = store.getSettings();
  const demoMode = settings.showDemoData === true;

  // 演示模式：用演示数据覆盖列表（真实缓存仍保留，关闭后恢复）
  // 需求硬约束：演示数据必须明确标识，绝不与真实数据混淆。
  const raw: ListItem[] = demoMode
    ? [...buildDemoAssignments(now), ...buildDemoExams(now)]
    : store.getAllListItems();

  const overrides = store.getOverrides();

  // 已结束考试的保留窗口：默认 24h，便于回看考场/座位（D3 决策）。
  const endedRetentionHours = settings.endedExamRetentionHours ?? 24;

  const items: UiAssignment[] = raw
    // 过滤掉"结束超过保留窗口"的考试（演示数据同样适用，保持一致行为）
    .filter((i) => {
      if (!isExamItem(i)) return true;
      const endMs = dueToMs(i.endsAt ?? i.startsAt);
      if (endMs === null) return true; // 时间未知：保留，让用户看到并自行核对
      return now - endMs <= endedRetentionHours * 3600 * 1000;
    })
    .map((item): UiAssignment => {
      if (isExamItem(item)) {
        // 考试不参与手动覆盖（一期）：覆盖机制只针对作业的截止/状态
        return {
          ...item,
          sourceLabel: SOURCE_LABELS[item.source],
          overridden: false,
          isDemo: isDemoExam(item),
        };
      }
      const ov = demoMode ? undefined : overrides[item.id];
      const merged = ov
        ? {
            ...item,
            dueAt: ov.dueAt !== undefined ? ov.dueAt : item.dueAt,
            submissionStatus:
              (ov.submissionStatus as typeof item.submissionStatus | undefined) ??
              item.submissionStatus,
          }
        : item;
      return {
        ...merged,
        sourceLabel: SOURCE_LABELS[merged.source],
        overridden: Boolean(ov),
        isDemo: isDemoAssignment(merged),
        manuallyOverridden: ov ? { field: 'dueAt', at: ov.at } : undefined,
      };
    });

  // 排序：统一用「锚点」= 作业 dueAt / 考试 startsAt；无锚点置底。
  items.sort((x, y) => {
    const xd = dueToMs(anchorOf(x));
    const yd = dueToMs(anchorOf(y));
    if (xd === null && yd === null) return x.title.localeCompare(y.title, 'zh-CN');
    if (xd === null) return 1;
    if (yd === null) return -1;
    return xd - yd;
  });

  const sources: SourceStateDto[] = (['hw', 'ulearning'] as SourceId[]).map((source) => {
    const session = store.getSession(source);
    const lastSuccessAt = store.getLastSuccess(source);
    const counts = store.getKindCounts(source);
    const total = counts.homework + counts.exam;

    // 平台级 stale：作业或任一类数据的上次成功都已过时
    const hwLast = store.getLastSuccessByKind(source, 'homework');
    const examLast = store.getLastSuccessByKind(source, 'exam');
    const staleOf = (at: string | null): boolean => at === null || now - Date.parse(at) > STALE_AFTER_MS;

    const kinds: { kind: ListItemKind; count: number; stale: boolean }[] = [
      { kind: 'homework', count: counts.homework, stale: staleOf(hwLast ?? lastSuccessAt) },
    ];
    // 只有该平台确实支持考试时才列出考试明细，避免把"不具备能力"显示成"0 场考试"
    if (counts.exam > 0 || examLast !== null) {
      kinds.push({ kind: 'exam', count: counts.exam, stale: staleOf(examLast) });
    }

    return {
      source,
      label: SOURCE_LABELS[source],
      session,
      lastSuccessAt,
      count: total,
      stale: kinds.every((k) => k.stale),
      kinds,
    };
  });

  const failed = sources.filter((s) => s.session && s.session.state !== 'connected');
  const edge = await detectEdge();

  return {
    assignments: items,
    sources,
    settings: {
      thresholds: settings.thresholds,
      examThresholds: settings.examThresholds,
      examSyncEnabled: settings.examSyncEnabled,
      syncIntervalMinutes: settings.syncIntervalMinutes,
      quietHours: settings.quietHours,
      launchAtLogin: settings.launchAtLogin,
      minimizeToTrayOnClose: settings.minimizeToTrayOnClose,
      notifyUnknownStatus: settings.notifyUnknownStatus,
      theme: settings.theme,
      showDemoData: demoMode,
      endedExamRetentionHours: endedRetentionHours,
    },
    lastSyncAt: settings.lastSyncAt,
    syncing: engine.isRunning,
    partialFailure: demoMode ? false : failed.length > 0 && failed.length < sources.length,
    allFailed: demoMode ? false : failed.length === sources.length && failed.length > 0,
    browserReady: edge.available,
    demoMode,
  };
}
