/**
 * 打包版冒烟测试：直接启动 dist/win-unpacked 里的 exe，
 * 验证 ASAR、资源路径、preload、Playwright 解包是否都正常。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXE = join(ROOT, 'dist', 'win-unpacked', '莞工Deadline.exe');
if (!existsSync(EXE)) {
  console.log('FAIL: 找不到打包后的 exe:', EXE);
  process.exit(1);
}

const SHOT_DIR = join(ROOT, 'docs', 'screenshots');
mkdirSync(SHOT_DIR, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'dgut-packed-'));

console.log('启动:', EXE);
const child = spawn(EXE, [`--user-data-dir=${userData}`, '--remote-debugging-port=9336'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '' },
});
let err = '';
let out = '';
child.stderr.on('data', (d) => (err += d.toString()));
child.stdout.on('data', (d) => (out += d.toString()));

await new Promise((r) => setTimeout(r, 6000));

const { chromium } = await import('playwright-core');
let browser;
let verdict = 'FAIL';
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9336');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => ({
    title: document.title,
    hasApp: !!document.querySelector('.app'),
    brand: document.querySelector('.brand')?.textContent ?? null,
    preloadOk: typeof window.dgut === 'object' && window.dgut !== null,
    apiKeys: window.dgut ? Object.keys(window.dgut) : [],
    bodyLen: document.body.innerText.length,
  }));
  console.log('PACKED_DOM:', JSON.stringify(info, null, 2));

  // 测试 IPC 是否真的通（preload + 主进程）
  const ipcTest = await page.evaluate(async () => {
    try {
      const snap = await window.dgut.getSnapshot();
      return { ok: true, sources: snap.sources.map((s) => s.source), browserReady: snap.browserReady };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  console.log('IPC_TEST:', JSON.stringify(ipcTest));

  // 测试通知
  const notify = await page.evaluate(async () => {
    try {
      return await window.dgut.testNotification();
    } catch (e) {
      return { error: String(e) };
    }
  });
  console.log('NOTIFY_TEST:', JSON.stringify(notify));

  await page.screenshot({ path: join(SHOT_DIR, 'packed-app.png') });

  verdict =
    info.hasApp && info.preloadOk && ipcTest.ok && notify?.supported ? 'PASS' : 'FAIL';
  writeFileSync(join(SHOT_DIR, 'packed-probe.json'), JSON.stringify({ info, ipcTest, notify }, null, 2));
} catch (e) {
  console.log('CDP attach failed:', String(e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  if (err.trim()) console.log('stderr:', err.slice(-1200));
  console.log('PACKED_SMOKE_RESULT:', verdict);
  process.exit(verdict === 'PASS' ? 0 : 1);
}
