/**
 * 受控浏览器会话管理。
 *
 * 关键设计决策（依据阶段 0 实测，见 docs/PLATFORM_FINDINGS.md）：
 *  - hw 平台的会话是**服务端 session cookie**（`server_session_0910b76b` + `SESSION`），
 *    浏览器进程关闭后 cookie 即失效。因此应用必须持有长驻（headed 或 headless）浏览器实例，
 *    并把 storageState 落盘到应用专属目录，才能在重启后尝试恢复。
 *  - 使用 `channel: 'msedge'` 调用本机已安装的 Microsoft Edge；不下载 Chromium。
 *  - userDataDir 位于 app.getPath('userData')/browser-profile，绝不与用户日常浏览器共享，
 *    也绝不进入 Git。
 *  - 绝不读取用户默认浏览器的 Cookie。
 */

import { chromium, type BrowserContext, type Page } from 'playwright-core';

/** 判断错误是否属于"浏览器不可用"，需要给用户明确的回退指引。 */
export class BrowserUnavailableError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}

export interface BrowserSessionOptions {
  /** 应用专属的浏览器用户目录（绝对路径）。 */
  userDataDir: string;
  /** 是否在可见窗口中运行。登录必须为 true。 */
  headless?: boolean;
  /** 允许的最大并发页面数。 */
  viewport?: { width: number; height: number };
}

/**
 * 探测本机是否可用 Microsoft Edge。
 * 不抛错，返回结构化结果供 UI 展示。
 */
export async function detectEdge(): Promise<
  { available: true; version?: string } | { available: false; reason: string }
> {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  // 延迟 import，避免主进程启动时就加载 fs 相关逻辑
  const { existsSync } = await import('node:fs');
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    return {
      available: false,
      reason: '未检测到 Microsoft Edge。请先安装 Edge 稳定版，或改用 Chromium 回退方案。',
    };
  }
  return { available: true, version: found };
}

/** 单平台一个长驻会话。 */
export class BrowserSession {
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private lastActivityAt = 0;

  constructor(private readonly opts: BrowserSessionOptions) {}

  /** 浏览器是否已启动。 */
  get isRunning(): boolean {
    return this.context !== null;
  }

  get lastActivity(): number {
    return this.lastActivityAt;
  }

  /**
   * 启动（或复用）持久化上下文。
   * 并发调用会共享同一个启动 Promise，避免启动出多个浏览器实例。
   */
  async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      const edge = await detectEdge();
      if (!edge.available) {
        throw new BrowserUnavailableError(edge.reason);
      }
      try {
        const ctx = await chromium.launchPersistentContext(this.opts.userDataDir, {
          channel: 'msedge',
          headless: this.opts.headless ?? false,
          viewport: this.opts.viewport ?? { width: 1360, height: 900 },
          args: [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=msEdgeSidebarV2',
          ],
          // 明确不注入任何学校页面可访问的 Node 能力
          javaScriptEnabled: true,
        });
        this.context = ctx;
        this.lastActivityAt = Date.now();
        return ctx;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BrowserUnavailableError(
          '启动 Microsoft Edge 失败。可能原因：Edge 未安装、被安全软件拦截，或用户配置目录不可写。',
          msg,
        );
      } finally {
        this.launching = null;
      }
    })();

    return this.launching;
  }

  /**
   * 取一个可用的页面。
   *
   * 【关键】优先复用**已经导航到目标站点**的页面，而不是盲目返回 pages[0]。
   * 否则用户在第二个标签页登录成功后，应用却去读第一个空白页，
   * 表现为"明明登录了却显示未登录"。
   *
   * @param preferHost 期望的站点主机名（如 hw.dgut.edu.cn）
   */
  async getPage(preferHost?: string): Promise<Page> {
    const ctx = await this.ensureContext();
    const pages = ctx.pages();
    this.lastActivityAt = Date.now();

    if (preferHost && pages.length > 0) {
      const hit = pages.find((p) => {
        try {
          return p.url().includes(preferHost);
        } catch {
          return false;
        }
      });
      if (hit) return hit;
    }

    if (pages.length > 0) return pages[0]!;
    return ctx.newPage();
  }

  /** 当前所有页面（诊断用）。 */
  async pages(): Promise<Page[]> {
    const ctx = await this.ensureContext();
    return ctx.pages();
  }

  /** 落盘会话状态，供下次启动尝试恢复。 */
  async saveStorageState(file: string): Promise<void> {
    const ctx = await this.ensureContext();
    await ctx.storageState({ path: file });
  }

  /** 关闭浏览器并释放句柄（必须调用，否则会残留浏览器进程）。 */
  async close(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    if (!ctx) return;
    try {
      await ctx.close();
    } catch {
      // 关闭失败不阻塞退出流程
    }
  }
}
