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

// ══════════════════════════════════════════════════════════════════════
// 考试提醒阈值（分钟级）
//
// 为什么必须独立于 ThresholdSetting：
//   · 考试提醒的锚点是「开考」，作业是「截止」，语义不同；
//   · 考试需要 30 分钟这种精度，而 ThresholdSetting.hours 是整数小时，
//     normalizeThresholds 里的 Math.round(hours) 会把 0.5 压成 1、把 0.4 压成 0
//     （0 随后被 enabledThresholds 的 hours > 0 过滤掉）——分钟级在这个模型里无法表达。
// 因此单独一套类型 + 单独的单位（分钟），不改动作业阈值（作业侧零风险）。
// ══════════════════════════════════════════════════════════════════════

export interface ExamThresholdSetting {
  /** 锚点：开考 / 结束。 */
  anchor: 'start' | 'end';
  /**
   * 相对锚点的分钟偏移。
   *  > 0：提前 N 分钟（如 1440 = 提前 1 天）
   *  = 0：锚点当时（如「现在开考」）
   *  < 0：锚点之后 N 分钟
   */
  offsetMinutes: number;
  enabled: boolean;
  /** 强制弹出：不受静默时段抑制。 */
  urgent: boolean;
}

/**
 * 默认考试提醒阈值（用户 2026-11-11 决策 D1 = 「只提醒开始」）：
 * 提前 1 天 / 2 小时 / 30 分钟 + 开考瞬间。
 *
 * 不做结束锚点提醒 —— 若日后要加，只需在设置里新增 anchor:'end' 的项，
 * planner/scheduler 无需改动（已按 anchor 泛化）。
 */
export const DEFAULT_EXAM_THRESHOLDS: ExamThresholdSetting[] = [
  { anchor: 'start', offsetMinutes: 1440, enabled: true, urgent: false },
  { anchor: 'start', offsetMinutes: 120, enabled: true, urgent: true },
  { anchor: 'start', offsetMinutes: 30, enabled: true, urgent: true },
  { anchor: 'start', offsetMinutes: 0, enabled: true, urgent: true },
];

/** 取已启用的考试阈值（|offset| 降序 = 越早提醒的排前面）。 */
export function enabledExamThresholds(
  config: readonly ExamThresholdSetting[],
): ExamThresholdSetting[] {
  return config
    .filter((t) => t.enabled)
    .slice()
    .sort((a, b) => Math.abs(b.offsetMinutes) - Math.abs(a.offsetMinutes));
}

/** 限幅：提前最多 30 天，之后最多 1 天（负偏移允许，用于「开考后」提醒）。 */
const EXAM_OFFSET_MIN = -1440;
const EXAM_OFFSET_MAX = 30 * 1440;
const EXAM_THRESHOLD_MAX_COUNT = 10;

/**
 * 规范化考试阈值：去重、限幅、按 |offset| 降序。
 * 主进程校验渲染进程传来的设置时使用（渲染进程不可信）。
 */
export function normalizeExamThresholds(input: unknown): ExamThresholdSetting[] {
  if (!Array.isArray(input)) return DEFAULT_EXAM_THRESHOLDS.map((t) => ({ ...t }));
  const seen = new Set<string>();
  const out: ExamThresholdSetting[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const anchor = r['anchor'];
    if (anchor !== 'start' && anchor !== 'end') continue;
    const offset = Number(r['offsetMinutes']);
    if (!Number.isFinite(offset)) continue;
    const m = Math.round(offset);
    if (m < EXAM_OFFSET_MIN || m > EXAM_OFFSET_MAX) continue;
    const key = `${anchor}:${m}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      anchor,
      offsetMinutes: m,
      enabled: r['enabled'] !== false,
      urgent: r['urgent'] === true,
    });
    if (out.length >= EXAM_THRESHOLD_MAX_COUNT) break;
  }
  if (out.length === 0) return DEFAULT_EXAM_THRESHOLDS.map((t) => ({ ...t }));
  return out.sort((a, b) => Math.abs(b.offsetMinutes) - Math.abs(a.offsetMinutes));
}

/** 阈值的中文说明（设置页与提醒文案共用，避免两处各写一份）。 */
export function describeExamThreshold(t: ExamThresholdSetting): string {
  const m = t.offsetMinutes;
  const anchor = t.anchor === 'start' ? '开考' : '结束';
  if (m === 0) return `${anchor}时`;
  const abs = Math.abs(m);
  const span =
    abs % 1440 === 0
      ? `${abs / 1440} 天`
      : abs % 60 === 0
        ? `${abs / 60} 小时`
        : `${abs} 分钟`;
  return m > 0 ? `${anchor}前 ${span}` : `${anchor}后 ${span}`;
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
