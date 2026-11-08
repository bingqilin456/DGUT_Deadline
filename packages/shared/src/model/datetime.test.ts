import { describe, expect, it } from 'vitest';
import { DISPLAY_TZ_OFFSET, formatRemaining, parseDueAt } from '../model/datetime.js';

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
