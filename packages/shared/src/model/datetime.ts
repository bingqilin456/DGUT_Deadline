/**
 * 日期/时区归一化。
 *
 * 规则（来自需求文档，逐条落实）：
 *  1. 一切展示与计算统一按 Asia/Shanghai。
 *  2. 内部保存带时区偏移的 ISO8601 字符串。
 *  3. 平台只给到"日期"时，**绝不补 23:59**，返回 precision='date' 且 dueAt 为该日 00:00(+08:00)，
 *     由 UI 标注"具体时间待确认"。
 *  4. 无法解析 -> dueAt=null, precision='none'，绝不猜测。
 */

export const DISPLAY_TIMEZONE = 'Asia/Shanghai';
export const DISPLAY_TZ_OFFSET = '+08:00';

/** Asia/Shanghai 无夏令时，固定 +08:00，可安全用固定偏移做纯字符串运算。 */
const TZ_MS = 8 * 60 * 60 * 1000;

export type ParsedDue =
  | { dueAt: string; duePrecision: 'datetime' }
  | { dueAt: string; duePrecision: 'date' }
  | { dueAt: null; duePrecision: 'none' };

export const UNKNOWN_DUE: ParsedDue = { dueAt: null, duePrecision: 'none' };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 用固定 +08:00 构造 ISO 字符串，避免依赖运行环境本地时区。 */
function toIsoShanghai(y: number, mo: number, d: number, h: number, mi: number, s = 0): string {
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${DISPLAY_TZ_OFFSET}`;
}

/** 校验年月日时分是否真实存在（例如 2 月 30 日应判为非法）。 */
function isValidParts(y: number, mo: number, d: number, h: number, mi: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  if (h > 23 || mi > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * 解析平台返回的截止时间文本。
 *
 * 已支持的真实形态（详见 docs/PLATFORM_FINDINGS.md）：
 *  - `2026-11-10 23:59`          -> datetime
 *  - `2026-11-10 23:59:00`       -> datetime
 *  - `2026/11/10 23:59`          -> datetime
 *  - `2026-11-10`                -> date（不补时间）
 *  - `2026年11月10日 23:59`       -> datetime
 *  - `2026年11月10日`             -> date
 *  - `11-10 23:59`（无年份）      -> 交由 assumeYear 处理
 *  - ISO 带偏移 `2026-11-10T23:59:00+08:00` -> datetime（保留原偏移）
 *  - 空 / `未设置截止日期` / `-`  -> none
 */
export function parseDueAt(raw: unknown, opts: { assumeYear?: number } = {}): ParsedDue {
  if (raw === null || raw === undefined) return UNKNOWN_DUE;
  const text = String(raw).trim();
  if (text === '') return UNKNOWN_DUE;

  // 明确的"无截止时间"标记：必须判为 none，不能当成 0 或今天。
  if (/^(未设置|暂无|无|--?|null|undefined|none)$/i.test(text)) return UNKNOWN_DUE;
  if (/未设置截止/.test(text)) return UNKNOWN_DUE;

  // 已是带偏移或 Z 的 ISO8601：直接保留（保证时区信息不丢）。
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, s, zoneRaw] = iso;
    const zone = zoneRaw ?? '+08:00';
    const Y = Number(y), MO = Number(mo), D = Number(d), H = Number(h), MI = Number(mi), S = Number(s ?? 0);
    if (!isValidParts(Y, MO, D, H, MI)) return UNKNOWN_DUE;
    if (zone === 'Z') {
      // 转成 Asia/Shanghai 展示用偏移
      const utcMs = Date.UTC(Y, MO - 1, D, H, MI, S);
      const sh = new Date(utcMs + TZ_MS);
      return {
        dueAt: toIsoShanghai(sh.getUTCFullYear(), sh.getUTCMonth() + 1, sh.getUTCDate(), sh.getUTCHours(), sh.getUTCMinutes(), sh.getUTCSeconds()),
        duePrecision: 'datetime',
      };
    }
    const sign = zone[0] === '-' ? -1 : 1;
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(4, 6));
    if (sign === 1 && zh === 8 && zm === 0) {
      return { dueAt: toIsoShanghai(Y, MO, D, H, MI, S), duePrecision: 'datetime' };
    }
    // 其他时区：换算到 +08:00
    const wallMs = Date.UTC(Y, MO - 1, D, H, MI, S) - sign * (zh * 60 + zm) * 60000;
    const sh = new Date(wallMs + TZ_MS);
    return {
      dueAt: toIsoShanghai(sh.getUTCFullYear(), sh.getUTCMonth() + 1, sh.getUTCDate(), sh.getUTCHours(), sh.getUTCMinutes(), sh.getUTCSeconds()),
      duePrecision: 'datetime',
    };
  }

  // 中文日期格式
  const cn = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (cn) {
    const Y = Number(cn[1]), MO = Number(cn[2]), D = Number(cn[3]);
    const hasTime = cn[4] !== undefined;
    const H = hasTime ? Number(cn[4]) : 0;
    const MI = hasTime ? Number(cn[5]) : 0;
    const S = hasTime && cn[6] ? Number(cn[6]) : 0;
    if (!isValidParts(Y, MO, D, H, MI)) return UNKNOWN_DUE;
    return hasTime
      ? { dueAt: toIsoShanghai(Y, MO, D, H, MI, S), duePrecision: 'datetime' }
      : { dueAt: toIsoShanghai(Y, MO, D, 0, 0, 0), duePrecision: 'date' };
  }

  // 纯数字格式 yyyy-MM-dd[ HH:mm[:ss]] / yyyy/MM/dd
  const num = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (num) {
    const Y = Number(num[1]), MO = Number(num[2]), D = Number(num[3]);
    const hasTime = num[4] !== undefined;
    const H = hasTime ? Number(num[4]) : 0;
    const MI = hasTime ? Number(num[5]) : 0;
    const S = hasTime && num[6] ? Number(num[6]) : 0;
    if (!isValidParts(Y, MO, D, H, MI)) return UNKNOWN_DUE;
    return hasTime
      ? { dueAt: toIsoShanghai(Y, MO, D, H, MI, S), duePrecision: 'datetime' }
      : { dueAt: toIsoShanghai(Y, MO, D, 0, 0, 0), duePrecision: 'date' };
  }

  // 只有月日：需要 assumeYear，否则无法确定年份 -> none（不猜测）。
  const md = /^(\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(text);
  if (md && opts.assumeYear) {
    const Y = opts.assumeYear;
    const MO = Number(md[1]), D = Number(md[2]);
    const hasTime = md[3] !== undefined;
    const H = hasTime ? Number(md[3]) : 0;
    const MI = hasTime ? Number(md[4]) : 0;
    if (!isValidParts(Y, MO, D, H, MI)) return UNKNOWN_DUE;
    return hasTime
      ? { dueAt: toIsoShanghai(Y, MO, D, H, MI, SOrZero()), duePrecision: 'datetime' }
      : { dueAt: toIsoShanghai(Y, MO, D, 0, 0, 0), duePrecision: 'date' };
  }

  return UNKNOWN_DUE;
}

function SOrZero(): number {
  return 0;
}

/**
 * 考试时间归一化（`ExamItem.startsAt` / `endsAt` 专用）。
 *
 * 为什么单独一个函数而不是复用 parseDueAt：考试**没有「只有日期」的语义**
 * —— 「2026-12-30 考试」这句话不能推出开考时刻，若按 duePrecision='date' 返回
 * 该日 00:00，会让一场下午的考试在凌晨就触发提醒（把不确定伪装成确定，违反红线 3）。
 *
 * 未验证（docs/LMS-EXAM-PLAN.md §4.5、证据表 C.6）：
 *   · 考试接口的时间是**毫秒数字**还是 **ISO 字符串**完全没有实测响应；
 *   · 作业接口实测是毫秒数字（PLATFORM_FINDINGS §3.5），但考试**不得**照搬这个假设。
 *   因此这里做双格式探测，任何不确定都返回 null（不猜）。
 *
 * 规则：
 *  1. 数值：`n > 1e12` 视为毫秒；`1e9 < n <= 1e12` 视为秒级（×1000，保守猜测，C.6 回填后确认）；
 *     其余（含 0、负数、NaN、Infinity）→ null。绝不 new Date(0) 之类的伪值。
 *  2. 字符串：复用 parseDueAt()；得到 duePrecision === 'date'（只有日期）→ null。
 *  3. 任何解析失败 → null；调用方必须计入 warning，不允许静默丢场次。
 *  4. 输出一律 +08:00 ISO（与 dueAt 同一套表示，便于统一比较）。
 */
export function parseExamTime(raw: unknown): { iso: string; precision: 'datetime' } | null {
  if (raw === null || raw === undefined) return null;

  // ── 数值形态（未验证：C.6 时间类型）────────────────────────────
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    let ms: number;
    if (raw > 1e12) {
      ms = raw; // 毫秒时间戳（作业接口实测形态）
    } else if (raw > 1e9) {
      // 秒级时间戳：保守猜测（×1000）。未验证；若真实平台用 1e9~1e12 区间的
      // 毫秒值（即 1970~2001 年），会被误判为秒级 —— 该区间与校园考试时间不重叠。
      ms = raw * 1000;
    } else {
      return null;
    }
    const iso = msToIsoShanghai(ms);
    return iso === null ? null : { iso, precision: 'datetime' };
  }

  // 纯数字字符串按数值处理（平台可能把时间戳序列化成字符串，未验证）。
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return null;
    if (/^\d+$/.test(text)) return parseExamTime(Number(text));
    const parsed = parseDueAt(text);
    if (parsed.dueAt === null) return null;
    // 只有日期 ⇒ 无法确定开考时刻 ⇒ 视为不可用（不猜）。
    if (parsed.duePrecision !== 'datetime') return null;
    return { iso: parsed.dueAt, precision: 'datetime' };
  }

  return null;
}

/** 毫秒时间戳 → +08:00 ISO；非法值返回 null。 */
function msToIsoShanghai(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  // 用固定偏移换算，不依赖运行环境本地时区。
  const sh = new Date(ms + TZ_MS);
  return toIsoShanghai(
    sh.getUTCFullYear(),
    sh.getUTCMonth() + 1,
    sh.getUTCDate(),
    sh.getUTCHours(),
    sh.getUTCMinutes(),
    sh.getUTCSeconds(),
  );
}

/** 毫秒时间戳（用于剩余时间计算）。null -> null，调用方必须显式处理。 */
export function dueToMs(dueAt: string | null): number | null {
  if (!dueAt) return null;
  const t = Date.parse(dueAt);
  return Number.isNaN(t) ? null : t;
}

/** 剩��时间的可读中文描述。 */
export function formatRemaining(nowMs: number, dueMs: number | null, precision: 'datetime' | 'date' | 'none'): string {
  if (dueMs === null) return '截止时间待确认';
  const diff = dueMs - nowMs;
  const abs = Math.abs(diff);
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const min = 60 * 1000;

  const suffix = precision === 'date' ? '（仅日期）' : '';
  if (diff <= 0) return `已截止${suffix}`;

  if (abs >= day) {
    const d = Math.floor(abs / day);
    const h = Math.floor((abs % day) / hour);
    return `剩 ${d} 天 ${h} 小时${suffix}`;
  }
  if (abs >= hour) {
    const h = Math.floor(abs / hour);
    const m = Math.floor((abs % hour) / min);
    return `剩 ${h} 小时 ${m} 分${suffix}`;
  }
  return `剩 ${Math.max(1, Math.floor(abs / min))} 分钟${suffix}`;
}

// ══════════════════════════════════════════════════════════════════════
// 考试阶段推导
// ══════════════════════════════════════════════════════════════════════

export type ExamPhase = 'upcoming' | 'ongoing' | 'ended' | 'unknown';

/**
 * 由**本地归一化时间**推导考试阶段，不依赖平台 `examState`
 * （其值域未验证，且已被前端用 `publishStatus` 合成过，不可信）。
 *
 * 放在 packages/shared 是因为**主进程（提醒）与渲染进程（列表）都要用**：
 * 此前两处各写一份语义等价的实现，靠注释约定同步 —— 一旦一方改动就会漂移，
 * 表现为「列表说进行中，提醒却说已结束」。现在只有这一份。
 *
 * 规则：
 *  - 无 startsAt            => unknown（不猜）
 *  - 未到 startsAt          => upcoming
 *  - 已过 startsAt 且无 endsAt => ongoing（保守：不谎称已结束）
 *  - 有 endsAt              => now < endsAt ? ongoing : ended
 */
export function examPhase(
  x: { startsAt: string | null; endsAt: string | null },
  nowMs: number,
): ExamPhase {
  const s = dueToMs(x.startsAt);
  if (s === null) return 'unknown';
  if (nowMs < s) return 'upcoming';
  const e = dueToMs(x.endsAt);
  if (e === null) return 'ongoing';
  return nowMs < e ? 'ongoing' : 'ended';
}
