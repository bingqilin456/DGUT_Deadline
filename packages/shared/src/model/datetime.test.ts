import { describe, expect, it } from 'vitest';
import { DISPLAY_TZ_OFFSET, formatRemaining, parseDueAt, parseExamTime } from '../model/datetime.js';

describe('parseDueAt —— 日期归一化', () => {
  it('解析 yyyy-MM-dd HH:mm 为带 +08:00 的时间点', () => {
    expect(parseDueAt('2026-11-10 23:59')).toEqual({
      dueAt: `2026-11-10T23:59:00${DISPLAY_TZ_OFFSET}`,
      duePrecision: 'datetime',
    });
  });

  it('解析带秒的时间', () => {
    expect(parseDueAt('2026-11-10 23:59:00')).toEqual({
      dueAt: `2026-11-10T23:59:00${DISPLAY_TZ_OFFSET}`,
      duePrecision: 'datetime',
    });
  });

  it('解析斜杠分隔格式', () => {
    expect(parseDueAt('2026/11/10 08:30')).toEqual({
      dueAt: `2026-11-10T08:30:00${DISPLAY_TZ_OFFSET}`,
      duePrecision: 'datetime',
    });
  });

  it('解析中文日期+时间', () => {
    expect(parseDueAt('2026年11月10日 23:59')).toEqual({
      dueAt: `2026-11-10T23:59:00${DISPLAY_TZ_OFFSET}`,
      duePrecision: 'datetime',
    });
  });

  it('【关键】只有日期时绝不补 23:59，标记为 date 精度', () => {
    const r = parseDueAt('2026-11-10');
    expect(r.duePrecision).toBe('date');
    expect(r.dueAt).toBe(`2026-11-10T00:00:00${DISPLAY_TZ_OFFSET}`);
    // 明确断言没有把时间猜成 23:59
    expect(r.dueAt).not.toContain('23:59');
  });

  it('中文日期只有日期时同样是 date 精度', () => {
    const r = parseDueAt('2026年11月10日');
    expect(r.duePrecision).toBe('date');
    expect(r.dueAt).toBe(`2026-11-10T00:00:00${DISPLAY_TZ_OFFSET}`);
  });

  it('已是 +08:00 的 ISO 直接保留', () => {
    expect(parseDueAt('2026-11-10T23:59:00+08:00')).toEqual({
      dueAt: `2026-11-10T23:59:00${DISPLAY_TZ_OFFSET}`,
      duePrecision: 'datetime',
    });
  });

  it('UTC 的 ISO 换算到 Asia/Shanghai', () => {
    // 2026-11-10T15:59:00Z == 2026-11-10 23:59 +08:00
    expect(parseDueAt('2026-11-10T15:59:00Z')).toEqual({
      dueAt: `2026-11-10T23:59:00${DISPLAY_TZ_OFFSET}`,
      duePrecision: 'datetime',
    });
  });

  it('UTC 换算跨日正确（23:00Z -> 次日 07:00 +08:00）', () => {
    expect(parseDueAt('2026-11-10T23:00:00Z')).toEqual({
      dueAt: `2026-11-11T07:00:00${DISPLAY_TZ_OFFSET}`,
      duePrecision: 'datetime',
    });
  });

  it('"未设置截止日期" 判为 none，而不是今天或 23:59', () => {
    expect(parseDueAt('未设置截止日期')).toEqual({ dueAt: null, duePrecision: 'none' });
  });

  it('空值与 null 判为 none', () => {
    expect(parseDueAt('')).toEqual({ dueAt: null, duePrecision: 'none' });
    expect(parseDueAt(null)).toEqual({ dueAt: null, duePrecision: 'none' });
    expect(parseDueAt(undefined)).toEqual({ dueAt: null, duePrecision: 'none' });
    expect(parseDueAt('-')).toEqual({ dueAt: null, duePrecision: 'none' });
  });

  it('非法日期（2 月 30 日）判为 none 而不是自动进位', () => {
    expect(parseDueAt('2026-02-30 10:00')).toEqual({ dueAt: null, duePrecision: 'none' });
  });

  it('无法识别的自由文本判为 none', () => {
    expect(parseDueAt('下周三之前')).toEqual({ dueAt: null, duePrecision: 'none' });
  });

  it('无年份的月日格式，未提供 assumeYear 时判为 none（不猜测年份）', () => {
    expect(parseDueAt('11-10 23:59')).toEqual({ dueAt: null, duePrecision: 'none' });
  });

  it('无年份的月日格式，提供 assumeYear 时可解析', () => {
    expect(parseDueAt('11-10 23:59', { assumeYear: 2026 })).toEqual({
      dueAt: `2026-11-10T23:59:00${DISPLAY_TZ_OFFSET}`,
      duePrecision: 'datetime',
    });
  });
});

describe('formatRemaining —— 剩余时间文案', () => {
  const now = Date.parse(`2026-11-07T10:00:00${DISPLAY_TZ_OFFSET}`);

  it('超过 1 天显示天数与小时', () => {
    const due = Date.parse(`2026-11-10T10:00:00${DISPLAY_TZ_OFFSET}`);
    expect(formatRemaining(now, due, 'datetime')).toBe('剩 3 天 0 小时');
  });

  it('小于 1 天显示小时与分钟', () => {
    const due = Date.parse(`2026-11-07T13:30:00${DISPLAY_TZ_OFFSET}`);
    expect(formatRemaining(now, due, 'datetime')).toBe('剩 3 小时 30 分');
  });

  it('小于 1 小时显示分钟', () => {
    const due = Date.parse(`2026-11-07T10:45:00${DISPLAY_TZ_OFFSET}`);
    expect(formatRemaining(now, due, 'datetime')).toBe('剩 45 分钟');
  });

  it('已截止', () => {
    const due = Date.parse(`2026-11-06T10:00:00${DISPLAY_TZ_OFFSET}`);
    expect(formatRemaining(now, due, 'datetime')).toBe('已截止');
  });

  it('未知截止时间提示待确认，不显示"已截止"', () => {
    expect(formatRemaining(now, null, 'none')).toBe('截止时间待确认');
  });

  it('只有日期精度时明确标注', () => {
    const due = Date.parse(`2026-11-10T00:00:00${DISPLAY_TZ_OFFSET}`);
    expect(formatRemaining(now, due, 'date')).toContain('（仅日期）');
  });
});

describe('parseExamTime —— 考试时间归一化（双格式探测，失败即 null）', () => {
  // ⚠️ 这些用例只验证**归一化函数本身**的行为；
  // 考试接口真实返回的时间类型未验证（证据表 C.6），不据此断言平台形状。
  it('毫秒时间戳（>1e12）按毫秒解析为 +08:00', () => {
    // 1798646400000 = 2026-12-30T16:00:00Z = 2026-12-31T00:00:00+08:00
    expect(parseExamTime(1798646400000)).toEqual({
      iso: `2026-12-31T00:00:00${DISPLAY_TZ_OFFSET}`,
      precision: 'datetime',
    });
  });

  it('秒级时间戳（1e9~1e12）保守按秒解析', () => {
    expect(parseExamTime(1798646400)).toEqual({
      iso: `2026-12-31T00:00:00${DISPLAY_TZ_OFFSET}`,
      precision: 'datetime',
    });
  });

  it('纯数字字符串按数值处理', () => {
    expect(parseExamTime('1798646400000')).toEqual({
      iso: `2026-12-31T00:00:00${DISPLAY_TZ_OFFSET}`,
      precision: 'datetime',
    });
  });

  it('ISO 带偏移字符串复用 parseDueAt', () => {
    expect(parseExamTime('2026-12-30T09:00:00+08:00')).toEqual({
      iso: `2026-12-30T09:00:00${DISPLAY_TZ_OFFSET}`,
      precision: 'datetime',
    });
  });

  it('UTC ISO 换算到 +08:00', () => {
    expect(parseExamTime('2026-12-30T01:00:00Z')).toEqual({
      iso: `2026-12-30T09:00:00${DISPLAY_TZ_OFFSET}`,
      precision: 'datetime',
    });
  });

  it('"YYYY-MM-DD HH:mm" 平台文本格式', () => {
    expect(parseExamTime('2026-12-30 09:00')).toEqual({
      iso: `2026-12-30T09:00:00${DISPLAY_TZ_OFFSET}`,
      precision: 'datetime',
    });
  });

  it('【关键】只有日期 => null（考试没有"只有日期"语义，不补 00:00）', () => {
    expect(parseExamTime('2026-12-30')).toBeNull();
    expect(parseExamTime('2026年12月30日')).toBeNull();
  });

  it('空值 / null / undefined => null', () => {
    expect(parseExamTime('')).toBeNull();
    expect(parseExamTime('   ')).toBeNull();
    expect(parseExamTime(null)).toBeNull();
    expect(parseExamTime(undefined)).toBeNull();
  });

  it('0 / 负数 / NaN / Infinity => null（绝不产生 1970 伪值）', () => {
    expect(parseExamTime(0)).toBeNull();
    expect(parseExamTime(-1)).toBeNull();
    expect(parseExamTime(Number.NaN)).toBeNull();
    expect(parseExamTime(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseExamTime('0')).toBeNull();
  });

  it('小于 1e9 的数字（不是合理时间戳）=> null，不按秒猜', () => {
    expect(parseExamTime(12345)).toBeNull();
  });

  it('无法识别的自由文本 => null', () => {
    expect(parseExamTime('另行通知')).toBeNull();
    expect(parseExamTime('未设置')).toBeNull();
  });

  it('对象/布尔等非时间类型 => null', () => {
    expect(parseExamTime({})).toBeNull();
    expect(parseExamTime(true)).toBeNull();
    expect(parseExamTime([])).toBeNull();
  });
});
