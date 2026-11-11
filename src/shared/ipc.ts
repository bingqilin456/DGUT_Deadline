/**
 * IPC 契约（主进程 <-> 渲染进程）。
 *
 * 安全原则：
 *  - 只暴露这些白名单方法，不暴露 ipcRenderer 本身。
 *  - 不传递任何凭证、Cookie、Token。
 *  - 所有入参在主进程重新校验（渲染进程不可信）。
 *
 * 数据结构（2026-11-11 起）：
 *  - 列表实体是**判别联合** `UiAssignment = UiHomework | UiExam`，靠 `kind` 收窄。
 *    不能用 `interface ... extends Assignment | ExamItem`（TS2312：interface 不能 extends 联合）。
 *  - 作业有 submissionStatus/dueAt；考试有 startsAt/endsAt/attendance，
 *    但**物理上不存在** submissionStatus —— 类型层面堵死「凭空编造考试参加状态」。
 *  - 分类依据是**接口来源模块**，不是标题内容（用户 2026-11-11 决策 D4）。
 */

import type {
  Assignment,
  ExamItem,
  ListItemKind,
  SessionStatus,
  SourceId,
} from '@dgut-deadline/shared';
import type { ExamThresholdSetting, ThresholdSetting } from './thresholds';

/** 两种实体共用的 UI 附加字段（主进程组装，渲染进程只读）。 */
interface UiMeta {
  /** 平台中文名（用于展示，避免渲染层再查表）。 */
  sourceLabel: string;
  /** 是否被用户手动覆盖（考试一期不支持覆盖，恒 false）。 */
  overridden: boolean;
  /** 是否为演示数据（UI 必须显著标识，不得与真实数据混淆）。 */
  isDemo?: boolean;
}

export type UiHomework = Assignment & UiMeta;
export type UiExam = ExamItem & UiMeta;
/** 列表实体联合。访问 kind 专有字段前必须先收窄（isExamItem/isHomeworkItem）。 */
export type UiAssignment = UiHomework | UiExam;

export interface SourceStateDto {
  source: SourceId;
  label: string;
  session: SessionStatus | null;
  lastSuccessAt: string | null;
  /** 该平台条目总数（作业 + 考试）。 */
  count: number;
  /** 数据是否可能过期。 */
  stale: boolean;
  /**
   * 按 kind 的明细，用于 UI 显示「N 条作业 / M 场考试」。
   * 可选：老主进程不产出该字段时 UI 退化到 count。
   * 只在该平台确实具备对应能力（有缓存或曾同步成功）时才列出，避免把「不具备能力」显示成「0 场考试」。
   */
  kinds?: { kind: ListItemKind; count: number; stale: boolean }[];
}

export interface AppSnapshot {
  /** 作业 + 考试的统一列表；已按「锚点」（作业 dueAt / 考试 startsAt）排序。 */
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
  /** 作业提醒阈值（小时级，可逐项开关 + 强制弹出标记）。 */
  thresholds: ThresholdSetting[];
  /** 考试提醒阈值（分钟级，锚点 = 开考/结束）。与 thresholds 物理分离，见 §5.4。 */
  examThresholds: ExamThresholdSetting[];
  /** 是否同步优学院考试。默认 false：考试接口尚未用真实响应验证过。 */
  examSyncEnabled: boolean;
  syncIntervalMinutes: number;
  quietHours: { enabled: boolean; start: string; end: string };
  launchAtLogin: boolean;
  minimizeToTrayOnClose: boolean;
  notifyUnknownStatus: boolean;
  theme: 'light' | 'dark' | 'system';
  /** 是否显示演示数据（UI 会显著标注「演示」）。 */
  showDemoData?: boolean;
  /** 已结束考试在列表中保留多少小时（便于回看考场/座位），默认 24。 */
  endedExamRetentionHours?: number;
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
