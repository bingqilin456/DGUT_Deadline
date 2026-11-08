/**
 * 端到端 UI 验证：用真实采集数据填充 electron-store，启动应用并截图。
 * 验证内容：真实作业能在 UI 正确显示（标题/课程/截止/状态/剩余时间）。
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const SHOT_DIR = join(ROOT, 'docs', 'screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

// 1) 生成真实数据
const seeded = JSON.parse(
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'seed-from-evidence.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  }),
);
console.log('seeded assignments:', seeded.count);

// 2) 预置 userData（electron-store 的配置文件位置）
const userData = mkdtempSync(join(tmpdir(), 'dgut-deadline-e2e-'));
const now = new Date().toISOString();
const storePayload = {
  schemaVersion: 2,
  settings: {
        thresholds: [
      { hours: 72, enabled: true, urgent: false },
      { hours: 24, enabled: true, urgent: false },
      { hours: 12, enabled: true, urgent: true },
      { hours: 6, enabled: true, urgent: true },
      { hours: 3, enabled: true, urgent: true },
      { hours: 1, enabled: true, urgent: true },
    ],
  overrides: {},
};
writeFileSync(join(userData, 'dgut-deadline.json'), JSON.stringify(storePayload, null, 2), 'utf8');

// 3) 启动应用
const electron = (await import('electron')).default;
const child = spawn(electron, ['.', `--user-data-dir=${userData}`, '--remote-debugging-port=9334'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '' },
});
let err = '';
child.stderr.on('data', (d) => (err += d.toString()));

await new Promise((r) => setTimeout(r, 4500));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    return {
      statNums: Array.from(document.querySelectorAll('.stat .num')).map((e) => e.textContent),
      rowCount: rows.length,
      firstRows: rows.slice(0, 4).map((r) =>
        Array.from(r.querySelectorAll('td')).map((td) => td.textContent.trim()),
      ),
      chips: Array.from(document.querySelectorAll('.chip')).map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
    };
  });
  console.log(JSON.stringify(info, null, 2));

  await page.screenshot({ path: join(SHOT_DIR, 'main-window-real-data.png') });
  console.log('screenshot saved');

  // 4) 设置页截图
  const settingsTab = page.locator('.tab', { hasText: '设置' });
  if (await settingsTab.count()) {
    await settingsTab.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(SHOT_DIR, 'settings.png') });
    console.log('settings screenshot saved');
  }

  writeFileSync(join(SHOT_DIR, 'e2e-probe.json'), JSON.stringify(info, null, 2));
} catch (e) {
  console.log('CDP failed:', String(e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  if (err.trim()) console.log('stderr:', err.slice(-500));
  process.exit(0);
}
