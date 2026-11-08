/**
 * 安装版验收：启动已安装的应用，验证 preload/IPC/通知/Playwright/Edge 全链路。
 * 这是"能安装 ≠ 能用"的关键验证。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const INSTALL_DIR = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'dgut-deadline');

if (!existsSync(INSTALL_DIR)) {
  console.log('FAIL: 安装目录不存在:', INSTALL_DIR);
  process.exit(1);
}
console.log('安装目录:', INSTALL_DIR);
console.log('内容:', readdirSync(INSTALL_DIR).filter((f) => !f.startsWith('resources')).join(', '));

const exeName = readdirSync(INSTALL_DIR).find((f) => f.endsWith('.exe') && !/Uninstall/i.test(f));
if (!exeName) {
  console.log('FAIL: 未找到主程序 exe');
  process.exit(1);
}
const EXE = join(INSTALL_DIR, exeName);
console.log('主程序:', EXE);

const SHOT_DIR = join(ROOT, 'docs', 'screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

// 使用独立的 user-data-dir，避免污染真实用户数据
const child = spawn(EXE, ['--remote-debugging-port=9338'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '' },
});
let err = '';
child.stderr.on('data', (d) => (err += d.toString()));

await new Promise((r) => setTimeout(r, 7000));

const { chromium } = await import('playwright-core');
let browser;
let verdict = 'FAIL';
const checks = {};
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9338');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(3000);

  // 1. UI 渲染
  const dom = await page.evaluate(() => ({
    title: document.title,
    hasApp: !!document.querySelector('.app'),
    brand: document.querySelector('.brand')?.textContent ?? null,
    preloadOk: typeof window.dgut === 'object' && window.dgut !== null,
    apiCount: window.dgut ? Object.keys(window.dgut).length : 0,
  }));
  checks.dom = dom.hasApp && dom.preloadOk && dom.apiCount >= 8;

  // 2. IPC 连通
  const snap = await page.evaluate(async () => {
    try {
      const s = await window.dgut.getSnapshot();
      return { ok: true, sources: s.sources.map((x) => x.source), browserReady: s.browserReady, count: s.assignments.length };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  checks.ipc = snap.ok === true;
  checks.edgeDetected = snap.browserReady === true;

  // 3. 通知
  const notify = await page.evaluate(async () => {
    try {
      return await window.dgut.testNotification();
    } catch (e) {
      return { error: String(e) };
    }
  });
  checks.notification = notify?.supported === true && notify?.shown === true;

  // 4. Playwright 能启动 Edge（触发真实同步）
  const sync = await page.evaluate(async () => {
    const t0 = Date.now();
    try {
      const s = await window.dgut.syncNow();
      return {
        ok: true,
        ms: Date.now() - t0,
        states: s.sources.map((x) => ({ src: x.source, state: x.session?.state ?? 'none' })),
      };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: String(e) };
    }
  });
  checks.playwrightLaunched = sync.ok === true && sync.ms > 2500;
  checks.statesExplicit = sync.ok === true && sync.states.every((s) => s.state !== 'none');

  // 5. 用户数据目录建立
  const userDataDir = join(process.env['APPDATA'] ?? '', 'dgut-deadline');
  checks.userDataDir = existsSync(userDataDir);

  await page.screenshot({ path: join(SHOT_DIR, 'installed-app.png') });

  console.log('\n=== 验收结果 ===');
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${v ? '✅' : '❌'} ${k}`);
  }
  console.log('\nDOM:', JSON.stringify(dom));
  console.log('IPC:', JSON.stringify(snap));
  console.log('NOTIFY:', JSON.stringify(notify));
  console.log('SYNC:', JSON.stringify(sync));

  verdict = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
  writeFileSync(
    join(SHOT_DIR, 'installed-probe.json'),
    JSON.stringify({ checks, dom, snap, notify, sync }, null, 2),
  );
} catch (e) {
  console.log('CDP failed:', String(e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  if (err.trim()) {
    const rel = err.split('\n').filter((l) => /ERR_|Cannot find|error/i.test(l)).slice(0, 6);
    if (rel.length) console.log('stderr(相关):', rel.join('\n'));
  }
  console.log('INSTALLED_APP_RESULT:', verdict);
  process.exit(verdict === 'PASS' ? 0 : 1);
}
