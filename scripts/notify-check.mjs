/**
 * 实机验证：真的能弹出 Windows 通知吗？
 * 通过 CDP 调用 app:testNotification，并观察主进程日志与系统通知状态。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const SHOT_DIR = join(ROOT, 'docs', 'screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

const userData = mkdtempSync(join(tmpdir(), 'dgut-notify-'));
const electron = (await import('electron')).default;

const child = spawn(electron, ['.', `--user-data-dir=${userData}`, '--remote-debugging-port=9335'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '' },
});
let err = '';
child.stderr.on('data', (d) => (err += d.toString()));

await new Promise((r) => setTimeout(r, 5000));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9335');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);

  // 直接调 preload 暴露的 API，等价于用户点按钮
  const result = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = window.dgut;
    if (!api) return { error: 'window.dgut 不存在（preload 未加载）' };
    try {
      return await api.testNotification();
    } catch (e) {
      return { error: String(e) };
    }
  });
  console.log('TEST_NOTIFICATION_RESULT:', JSON.stringify(result, null, 2));

  // 切到设置页截图，确认按钮存在
  const settingsTab = page.locator('.tab', { hasText: '设置' });
  if (await settingsTab.count()) {
    await settingsTab.click();
    await page.waitForTimeout(600);
    const hasTestBtn = await page.locator('button', { hasText: '发送测试通知' }).count();
    console.log('设置页有「发送测试通知」按钮:', hasTestBtn > 0);
    await page.screenshot({ path: join(SHOT_DIR, 'settings-notification.png') });
  }

  writeFileSync(join(SHOT_DIR, 'notification-probe.json'), JSON.stringify(result, null, 2));

  // 检查 Windows 通知是否被系统策略禁用
} catch (e) {
  console.log('CDP failed:', String(e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
}

// 独立检查 Windows 通知设置（注册表）
const { execFileSync } = await import('node:child_process');
try {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications'; if (Test-Path $k) { (Get-ItemProperty $k).ToastEnabled } else { 'key-missing' }`,
    ],
    { encoding: 'utf8' },
  );
  console.log('Windows ToastEnabled =', out.trim());
} catch (e) {
  console.log('无法读取 ToastEnabled:', String(e).slice(0, 120));
}

process.exit(0);
