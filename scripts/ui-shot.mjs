/**
 * UI 渲染验证：启动 Electron，截图主窗口，检查关键 DOM 是否存在。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const SHOT_DIR = join(ROOT, 'docs', 'screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

const userData = mkdtempSync(join(tmpdir(), 'dgut-deadline-ui-'));
const electron = (await import('electron')).default;

const child = spawn(electron, ['.', `--user-data-dir=${userData}`, '--remote-debugging-port=9333'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '', ELECTRON_ENABLE_LOGGING: '1' },
});

let err = '';
child.stderr.on('data', (d) => (err += d.toString()));

// 等 Electron 起来后，用 CDP 截图
await new Promise((r) => setTimeout(r, 4000));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => ({
    title: document.title,
    hasApp: !!document.querySelector('.app'),
    brand: document.querySelector('.brand')?.textContent ?? null,
    bodyLen: document.body.innerText.length,
    bodyStart: document.body.innerText.slice(0, 400),
  }));
  console.log('DOM:', JSON.stringify(info, null, 2));
  await page.screenshot({ path: join(SHOT_DIR, 'main-window.png'), fullPage: false });
  console.log('screenshot saved');
  writeFileSync(join(SHOT_DIR, 'ui-probe.json'), JSON.stringify(info, null, 2));
} catch (e) {
  console.log('CDP attach failed:', String(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  console.log('stderr tail:', err.slice(-600));
  process.exit(0);
}
