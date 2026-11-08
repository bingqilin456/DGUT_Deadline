/**
 * 同步结果与连接状态模型。
 *
 * 关键约束：**同步失败绝不能被渲染成"没有作业"**。
 * 因此 SyncResult 一定是 discriminated union，UI 必须显式处理每种情况。
 */

import type { Assignment, SourceId } from './assignment.js';

export type SessionState =
  | 'unknown'
  /** 尚未做过任何连接尝试 */
  | 'connected'
  /** 已确认拿到真实数据 */
  | 'needs_login'
  /** 会话失效，需用户重新登录 */
  | 'network_blocked'
  /** 域名不可达 / DNS / TLS / 需要校园网或 VPN */
  | 'platform_maintenance'
  /** 平台返回维护页（例如 LMS 2026-11-04 ~ 11-08） */
  | 'error';

export interface SessionStatus {
  source: SourceId;
  state: SessionState;
  /** 面向用户的说明（中文，可含人工操作指引）。 */
  message: string;
  /** 最近一次成功同步时间；null 表示从未成功。 */
  lastSuccessAt: string | null;
  /** 最近一次尝试时间。 */
  lastAttemptAt: string;
  /** 是否需要用户人工介入（登录 / VPN / 等待维护结束）。 */
  requiresUserAction: boolean;
}

export type SyncOutcome =
  | {
      kind: 'ok';
      source: SourceId;
      assignments: Assignment[];
      /** 本次同步是否覆盖了全部课程/分页。 */
      complete: boolean;
      warnings: string[];
    }
  | {
      kind: 'empty';
      /** 明确确认"确实没有作业"，而不是"没读到"。 */
      source: SourceId;
      confirmedAt: string;
    }
  | {
      kind: 'failed';
      source: SourceId;
      reason:
        | 'needs_login'
        | 'network_blocked'
        | 'platform_maintenance'
        | 'structure_changed'
        | 'parse_error'
        | 'timeout'
        | 'unknown';
      message: string;
      requiresUserAction: boolean;
    };

/** 错误分类：把底层异常映射为可展示、可判定的原因。 */
export function classifyFailure(err: unknown): {
  reason: Extract<SyncOutcome, { kind: 'failed' }>['reason'];
  message: string;
  requiresUserAction: boolean;
} {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.toLowerCase();

  if (/(enotfound|eai_again|getaddrinfo|dns)/.test(m)) {
    return {
      reason: 'network_blocked',
      message: '无法解析平台域名。请确认已连接校园网或学校 VPN。',
      requiresUserAction: true,
    };
  }
  if (/(etimedout|timeout|econnreset|socket hang up)/.test(m)) {
    return {
      reason: 'timeout',
      message: '连接平台超时。可能是校园网或 VPN 不稳定，请稍后重试。',
      requiresUserAction: false,
    };
  }
  if (/(401|403|unauthorized|登录|login)/.test(m)) {
    return {
      reason: 'needs_login',
      message: '登录状态已失效，请点击「重新登录」并在弹出的浏览器中完成登录。',
      requiresUserAction: true,
    };
  }
  if (/(维护|maintenance|503)/.test(m)) {
    return {
      reason: 'platform_maintenance',
      message: '平台当前处于维护状态，请稍后再试。',
      requiresUserAction: true,
    };
  }
  if (/(selector|structure|未找到|not found element)/.test(m)) {
    return {
      reason: 'structure_changed',
      message: '平台页面结构可能已改版，本次解析失败。已保留上次数据。',
      requiresUserAction: false,
    };
  }
  return {
    reason: 'unknown',
    message: `同步失败：${raw.slice(0, 200)}`,
    requiresUserAction: false,
  };
}
