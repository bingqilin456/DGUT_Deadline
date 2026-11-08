/**
 * 提醒阈值配置。
 *
 * 用户需求：
 *  - 截止前 12h / 6h / 3h / 1h 要**强制弹出**（持久通知 + 响铃，不自动消失）
 *  - 每个阈值可**单独开关**
 */

export interface ThresholdSetting {
  /** 提前多少小时提醒。 */
  hours: number;
  /** 是否启用。 */
  enabled: boolean;
  /**
   * 是否"强制弹出"：
   *  - Windows 上使用 timeoutType: 'never'，通知不会自动消失，需手动关闭
   *  - 不静音（有提示音）
   * 用于临近截止的关键提醒。
   */
  urgent: boolean;
}

/**
 * 默认阈值配置。
 *
 * 72h / 24h 为普通提醒（可被静默时段抑制）；
 * 12h / 6h / 3h / 1h 为强制弹出（临近截止，用户明确要求不能错过）。
 */
export const DEFAULT_THRESHOLDS: ThresholdSetting[] = [
  { hours: 72, enabled: true, urgent: false },
  { hours: 24, enabled: true, urgent: false },
  { hours: 12, enabled: true, urgent: true },
  { hours: 6, enabled: true, urgent: true },
  { hours: 3, enabled: true, urgent: true },
  { hours: 1, enabled: true, urgent: true },
];

/** 取已启用的阈值（按小时降序，便于展示与计算）。 */
export function enabledThresholds(config: readonly ThresholdSetting[]): ThresholdSetting[] {
  return config
    .filter((t) => t.enabled && t.hours > 0)
    .slice()
    .sort((a, b) => b.hours - a.hours);
}

/**
 * 规范化用户传入的阈值配置：去重、限制范围、按小时降序。
 * 用于主进程校验渲染进程传来的设置（渲染进程不可信）。
 */
export function normalizeThresholds(input: unknown): ThresholdSetting[] {
  if (!Array.isArray(input)) return DEFAULT_THRESHOLDS.map((t) => ({ ...t }));
  const seen = new Set<number>();
  const out: ThresholdSetting[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const hours = Number(r['hours']);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) continue;
    const h = Math.round(hours);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push({
      hours: h,
      enabled: r['enabled'] !== false,
      urgent: r['urgent'] === true,
    });
    if (out.length >= 10) break;
  }
  if (out.length === 0) return DEFAULT_THRESHOLDS.map((t) => ({ ...t }));
  return out.sort((a, b) => b.hours - a.hours);
}
