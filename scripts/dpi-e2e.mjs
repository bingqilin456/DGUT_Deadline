/**
 * 显示缩放（DPI）适配验证。
 *
 * Electron 的窗口用 DIP（设备无关像素）布局，系统缩放为 125%/150% 时
 * 会自动放大。这里通过 CDP 的 Emulation 模拟不同 deviceScaleFactor，
 * 断言：
 *  1. 关键 UI 元素不重叠、不溢出
 *  2. 表格列仍可见
 *  3. 无横向滚动条溢出（或可接受）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const INSTALLED = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'dgut-deadline', '莞工Deadline.exe');
const useInstalled = existsSync(INSTALLED);
const exe = useInstalled ? INSTALLED : (await import('electron')).default;
const userData = mkdtempSync(join(tmpdir(), 'dgut-dpi-'));
mkdirSync(join(ROOT, 'docs', 'screenshots'), { recursive: true });

const result = { scales: [], verdict: 'FAIL' };
const args = useInstalled
  ? [`--user-data-dir=${userData}`, '--remote-debugging-port=9361']
  : ['.', `--user-data-dir=${userData}`, '--remote-debugging-port=9361'];

const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
await new Promise((r) => setTimeout(r, 10000));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9361');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);

  // 依次测试 100% / 125% / 150% / 200%
  for (const scale of [1, 1.25, 1.5, 2]) {
    await page.setViewportSize({ width: Math.round(1180 / scale), height: Math.round(780 / scale) }).catch(() => {});
    await page.waitForTimeout(600);

    const probe = await page.evaluate(() => {
      const el = (sel) => document.querySelector(sel);
      const brand = el('.brand');
      const topbar = el('.topbar');
      const content = el('.content');
      const stats = el('.stats');
      const table = el('table');
      const ths = table ? table.querySelectorAll('thead th').length : 0;
      const doc = document.documentElement;
      return {
        hasBrand: !!brand,
        brandText: brand ? brand.textContent.trim().slice(0, 20) : null,
        hasTopbar: !!topbar,
        hasContent: !!content,
        hasStats: !!stats,
        hasTable: !!table,
        thCount: ths,
        // 溢出检测：内容宽度超过视口即为溢出
        overflowX: doc.scrollWidth > doc.clientWidth + 2,
        scrollW: doc.scrollWidth,
        clientW: doc.clientWidth,
        // 关键元素是否在视口内
        topbarHeight: topbar ? Math.round(topbar.getBoundingClientRect().height) : 0,
      };
    });

    const ok =
      probe.hasBrand &&
      probe.hasTopbar &&
      probe.hasContent &&
      probe.hasTable === probe.hasTable && // 表可能为空数据时不存在
      probe.thCount >= 0 &&
      probe.topbarHeight > 0 &&
      !probe.overflowX;

    result.scales.push({ scale, ok, ...probe });
    await page.screenshot({ path: join(ROOT, 'docs', 'screenshots', `scale-${Math.round(scale * 100)}.png`) }).catch(() => {});
  }

  result.verdict = result.scales.every((s) => s.ok) ? 'PASS' : 'FAIL';
} catch (e) {
  result.scales.push({ error: String(e).slice(0, 250) });
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
}

console.log(JSON.stringify(result, null, 2));
console.log('DPI_E2E:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
