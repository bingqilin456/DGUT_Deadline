/**
 * 温和采集：请求限流 + 指数退避。
 *
 * 需求要求"不过度请求"。学校平台是公共资源，同步时应：
 *  1. 对同一平台的请求保持最小间隔（默认 300ms）
 *  2. 遇到 429 / 5xx / 网络错误时指数退避重试
 *  3. 超过重试上限则快速失败，不要死循环
 */

export interface RateLimitOptions {
  /** 两次请求之间的最小间隔（毫秒）。 */
  minIntervalMs?: number;
  /** 最大重试次数。 */
  maxRetries?: number;
  /** 退避基数（毫秒），第 n 次重试等待 base * 2^n。 */
  backoffBaseMs?: number;
  /** 单次退避上限（毫秒），防止等待过久。 */
  maxBackoffMs?: number;
  /** 注入时钟，便于测试。 */
  sleep?: (ms: number) => Promise<void>;
  /** 注入当前时间，便于测试。 */
  now?: () => number;
}

export const DEFAULT_RATE_LIMIT: Required<Pick<RateLimitOptions, 'minIntervalMs' | 'maxRetries' | 'backoffBaseMs' | 'maxBackoffMs'>> = {
  minIntervalMs: 300,
  maxRetries: 2,
  backoffBaseMs: 800,
  maxBackoffMs: 8_000,
};

/** 判断错误是否值得重试。 */
export function isRetryable(status: number, message = ''): boolean {
  if (status === 429) return true; // 限流
  if (status >= 500 && status < 600) return true; // 服务端临时故障
  if (status === 0) {
    // 网络层错误：只有在明确是临时性问题时才重试
    return /ECONNRESET|ETIMEDOUT|socket hang up|network|timeout/i.test(message);
  }
  return false;
}

/**
 * 限流 + 退避执行器。
 *
 * 每个平台一个实例，保证同一平台串行且不超频。
 */
export class RateLimiter {
  /** 上次请求完成的时刻；null 表示尚未发起过请求。 */
  private lastAt: number | null = null;
  private readonly opts: Required<Omit<RateLimitOptions, 'sleep' | 'now'>> & {
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  };

  constructor(options: RateLimitOptions = {}) {
    this.opts = {
      minIntervalMs: options.minIntervalMs ?? DEFAULT_RATE_LIMIT.minIntervalMs,
      maxRetries: options.maxRetries ?? DEFAULT_RATE_LIMIT.maxRetries,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULT_RATE_LIMIT.backoffBaseMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_RATE_LIMIT.maxBackoffMs,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: options.now ?? (() => Date.now()),
    };
  }

  /** 等待到满足最小间隔。 */
  private async waitTurn(): Promise<void> {
    if (this.lastAt !== null) {
      const elapsed = this.opts.now() - this.lastAt;
      const need = this.opts.minIntervalMs - elapsed;
      if (need > 0) await this.opts.sleep(need);
    }
    this.lastAt = this.opts.now();
  }

  /**
   * 执行一次请求，自动限流与退避重试。
   *
   * @param fn 返回 { status, retryable? } 的函数；抛错也会被判定为可重试
   */
  async run<T>(fn: () => Promise<T & { status?: number }>): Promise<{
    ok: boolean;
    value?: T;
    attempts: number;
    lastStatus?: number;
    lastError?: string;
  }> {
    let lastStatus: number | undefined;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      await this.waitTurn();
      try {
        const value = await fn();
        const status = (value as { status?: number })?.status ?? 0;
        lastStatus = status;

        if (status === 0 || (status >= 200 && status < 400)) {
          return { ok: true, value, attempts: attempt + 1, lastStatus: status };
        }
        if (!isRetryable(status)) {
          return { ok: false, attempts: attempt + 1, lastStatus: status };
        }
        // 可重试但已达上限
        if (attempt === this.opts.maxRetries) break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (!isRetryable(0, lastError)) {
          return { ok: false, attempts: attempt + 1, lastError };
        }
        if (attempt === this.opts.maxRetries) break;
      }

      // 指数退避
      const delay = Math.min(
        this.opts.backoffBaseMs * Math.pow(2, attempt),
        this.opts.maxBackoffMs,
      );
      await this.opts.sleep(delay);
    }

    return {
      ok: false,
      attempts: this.opts.maxRetries + 1,
      lastStatus,
      lastError,
    };
  }

  /** 重置节流状态（用于测试或平台切换）。 */
  reset(): void {
    this.lastAt = null;
  }
}
