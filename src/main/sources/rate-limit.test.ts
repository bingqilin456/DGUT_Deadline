import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMIT, RateLimiter, isRetryable } from './rate-limit.js';

/** 可控时钟，便于验证退避时长。 */
function mkClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    get time() {
      return t;
    },
  };
}

describe('isRetryable —— 哪些错误值得重试', () => {
  it('429 限流可重试', () => {
    expect(isRetryable(429)).toBe(true);
  });

  it('5xx 服务端故障可重试', () => {
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(502)).toBe(true);
    expect(isRetryable(503)).toBe(true);
  });

  it('4xx 客户端错误不重试（除 429）', () => {
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable(401)).toBe(false);
    expect(isRetryable(403)).toBe(false);
    expect(isRetryable(404)).toBe(false);
  });

  it('200/302 不重试', () => {
    expect(isRetryable(200)).toBe(false);
    expect(isRetryable(302)).toBe(false);
  });

  it('网络临时错误可重试', () => {
    expect(isRetryable(0, 'ECONNRESET')).toBe(true);
    expect(isRetryable(0, 'socket hang up')).toBe(true);
    expect(isRetryable(0, 'Timeout 30000ms exceeded')).toBe(true);
  });

  it('未知网络错误不盲目重试', () => {
    expect(isRetryable(0, 'something weird')).toBe(false);
  });
});

describe('RateLimiter —— 限流', () => {
  it('首次请求不等待', async () => {
    const clock = mkClock();
    const rl = new RateLimiter({ minIntervalMs: 300, sleep: clock.sleep, now: clock.now });
    await rl.run(async () => ({ status: 200 }));
    expect(clock.sleeps).toHaveLength(0);
  });

  it('连续两次请求至少间隔 minIntervalMs', async () => {
    const clock = mkClock();
    const rl = new RateLimiter({ minIntervalMs: 300, sleep: clock.sleep, now: clock.now });
    await rl.run(async () => ({ status: 200 }));
    await rl.run(async () => ({ status: 200 }));
    // 第二次应等待 300ms
    expect(clock.sleeps.some((s) => s >= 300)).toBe(true);
  });

  it('minIntervalMs=0 时不等待', async () => {
    const clock = mkClock();
    const rl = new RateLimiter({ minIntervalMs: 0, sleep: clock.sleep, now: clock.now });
    await rl.run(async () => ({ status: 200 }));
    await rl.run(async () => ({ status: 200 }));
    expect(clock.sleeps.filter((s) => s > 0)).toHaveLength(0);
  });
});

describe('RateLimiter —— 指数退避', () => {
  it('503 会重试并最终成功', async () => {
    const clock = mkClock();
    const rl = new RateLimiter({
      minIntervalMs: 0,
      maxRetries: 2,
      backoffBaseMs: 100,
      sleep: clock.sleep,
      now: clock.now,
    });
    let calls = 0;
    const r = await rl.run(async () => {
      calls++;
      return { status: calls < 2 ? 503 : 200 };
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it('退避时长按指数增长', async () => {
    const clock = mkClock();
    const rl = new RateLimiter({
      minIntervalMs: 0,
      maxRetries: 2,
      backoffBaseMs: 100,
      maxBackoffMs: 10000,
      sleep: clock.sleep,
      now: clock.now,
    });
    await rl.run(async () => ({ status: 503 }));
    // 第 1 次退避 100，第 2 次 200
    expect(clock.sleeps).toEqual([100, 200]);
  });

  it('退避不超过 maxBackoffMs', async () => {
    const clock = mkClock();
    const rl = new RateLimiter({
      minIntervalMs: 0,
      maxRetries: 5,
      backoffBaseMs: 1000,
      maxBackoffMs: 1500,
      sleep: clock.sleep,
      now: clock.now,
    });
    await rl.run(async () => ({ status: 503 }));
    expect(clock.sleeps.every((s) => s <= 1500)).toBe(true);
  });

  it('超过重试上限后失败返回', async () => {
    const clock = mkClock();
    const rl = new RateLimiter({
      minIntervalMs: 0,
      maxRetries: 2,
      sleep: clock.sleep,
      now: clock.now,
    });
    const r = await rl.run(async () => ({ status: 503 }));
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(3); // 1 次原始 + 2 次重试
    expect(r.lastStatus).toBe(503);
  });

  it('4xx 不重试，立即失败（避免无谓请求）', async () => {
    const clock = mkClock();
    const rl = new RateLimiter({ minIntervalMs: 0, maxRetries: 3, sleep: clock.sleep, now: clock.now });
    let calls = 0;
    const r = await rl.run(async () => {
      calls++;
      return { status: 401 };
    });
    expect(calls).toBe(1);
    expect(r.ok).toBe(false);
  });

  it('抛出的网络错误若可重试则重试', async () => {
    const clock = mkClock();
    const rl = new RateLimiter({
      minIntervalMs: 0,
      maxRetries: 2,
      backoffBaseMs: 50,
      sleep: clock.sleep,
      now: clock.now,
    });
    let calls = 0;
    const r = await rl.run(async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET');
      return { status: 200 };
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('不可重试的异常立即失败', async () => {
    const clock = mkClock();
    const rl = new RateLimiter({ minIntervalMs: 0, maxRetries: 3, sleep: clock.sleep, now: clock.now });
    let calls = 0;
    const r = await rl.run(async () => {
      calls++;
      throw new Error('完全未知的错误');
    });
    expect(calls).toBe(1);
    expect(r.ok).toBe(false);
  });
});

describe('默认参数符合"温和采集"', () => {
  it('默认最小间隔 >= 300ms', () => {
    expect(DEFAULT_RATE_LIMIT.minIntervalMs).toBeGreaterThanOrEqual(300);
  });
  it('默认重试次数保守（<= 3）', () => {
    expect(DEFAULT_RATE_LIMIT.maxRetries).toBeLessThanOrEqual(3);
  });
  it('默认单次退避上限 <= 10s', () => {
    expect(DEFAULT_RATE_LIMIT.maxBackoffMs).toBeLessThanOrEqual(10_000);
  });
});
