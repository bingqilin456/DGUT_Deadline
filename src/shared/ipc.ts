/**
 * IPC 契约（主进程 <-> 渲染进程）。
 *
 * 安全原则：
 *  - 只暴露这些白名单方法，不暴露 ipcRenderer 本身。
 *  - 不传递任何凭证、Cookie、Token。
 *  - 所有入参在主进程重新校验（渲染进程不可信）。
 */

import type { Assignment, SourceId, SessionStatus } from '@dgut-deadline/shared';

export interface UiAssignment extends Assignment {
  /** 剩余时间文案（渲染进程用统一时钟计算）。 */
  sourceLabel: string;
  /** 是否来自手动覆盖。 */
  overridden: boolean;
  /** 是否为演示数据（UI 必须显著标识，不得与真实数据混淆）。 */
  isDemo?: boolean;
}

export interface SourceStateDto {
  source: SourceId;
  label: string;
  session: SessionStatus | null;
  lastSuccessAt: string | null;
  /** 该平台的作业数（缓存）。 */
  count: number;
  /** 数据是否可能过期。 */
  stale: boolean;
}

export interface AppSnapshot {
  assignments: UiAssignment[];
  sources: SourceStateDto[];
  settings: SettingsDto;
  lastSyncAt: string | null;
  syncing: boolean;
  /** 是否存在"部分平台失败"——用于顶部提示。 */
  partialFailure: boolean;
  /** 全部平台都失败。 */
  allFailed: boolean;
  browserReady: boolean;
  /** 当前是否处于演示模式（列表中全部为演示数据）。 */
  demoMode?: boolean;
}

export interface SettingsDto {
  /** 提醒阈值（可逐项开关 + 强制弹出标记）。 */
  thresholds: { hours: number; enabled: boolean; urgent: boolean }[];
  syncIntervalMinutes: number;
  quietHours: { enabled: boolean; start: string; end: string };
  launchAtLogin: boolean;
  minimizeToTrayOnClose: boolean;
  notifyUnknownStatus: boolean;
  theme: 'light' | 'dark' | 'system';
  /** 是否显示演示数据（UI 会显著标注「演示」）。 */
  showDemoData?: boolean;
}

export type IpcChannel =
  | 'app:getSnapshot'
  | 'app:syncNow'
  | 'app:login'
  | 'app:openAssignment'
  | 'app:updateSettings'
  | 'app:exportDiagnostics'
  | 'app:testNotification'
  | 'app:diagnoseSource';

/** 通知能力诊断结果。 */
export interface NotificationDiag {
  /** 系统是否支持通知。 */
  supported: boolean;
  /** 实际是否成功调用通知 API。 */
  shown: boolean;
  reason?: string;
  /** 当前是否有待触发的提醒（用于区分"没到期"和"通知坏了"）。 */
  pendingReminders: number;
  /** 若 API 成功但可能不可见（勿扰模式等）时的排查提示。 */
  hint?: string;
}

/** 单个诊断步骤。 */
export interface DiagStep {
  id: string;
  label: string;
  ok: boolean;
  /** 中性状态（既非通过也非故障），UI 显示为「待进行」 */
  neutral?: boolean;
  detail: string;
}

/** 平台链路诊断结果。 */
export interface SourceDiagnostic {
  source: SourceId;
  generatedAt: string;
  steps: DiagStep[];
  blockedAt: string | null;
  summary: string;
}

export interface IpcApi {
  getSnapshot(): Promise<AppSnapshot>;
  syncNow(): Promise<AppSnapshot>;
  login(source: SourceId): Promise<AppSnapshot>;
  openAssignment(id: string): Promise<{ ok: boolean; reason?: string }>;
  updateSettings(patch: Partial<SettingsDto>): Promise<AppSnapshot>;
  exportDiagnostics(): Promise<{ ok: boolean; path?: string; reason?: string }>;
  /** 发一条测试通知，用于实机验证 Windows 通知是否可用。 */
  testNotification(): Promise<NotificationDiag>;
  /** 诊断某个平台的接入链路，精确报告卡在哪一步。 */
  diagnoseSource(source: SourceId): Promise<SourceDiagnostic>;
  /** 订阅同步状态变化。 */
  onSnapshot(cb: (snap: AppSnapshot) => void): () => void;
}
