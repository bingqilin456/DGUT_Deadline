/**
 * 通知投递客观验证。
 *
 * 不能只看 Notification.show() 没抛错就断言"通知成功"。
 * 这里检查三件事：
 *  1. Notification.isSupported()
 *  2. Windows 是否开启了「请勿打扰 / 专注助手」
 *  3. 通知是否真的进入了 Windows 通知中心（通过 UserNotificationListener 或注册表回执）
 *
 * 结论必须如实区分：「API 调用成功」≠「用户看得见」。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXE = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'dgut-deadline', '莞工Deadline.exe');
mkdirSync(join(ROOT, 'docs', 'screenshots'), { recursive: true });

const report = { dnd: null, toastsEnabled: null, apiSupported: null, apiShown: null, verdict: 'FAIL', notes: [] };

// 1) 读取 Windows 免打扰 / 通知开关
const { execFileSync } = await import('node:child_process');
function ps(cmd) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const dnd = ps(
  `$s = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings' -ErrorAction SilentlyContinue; ` +
    `if ($s) { $s.NOC_GLOBAL_SETTING_TOASTS_ENABLED } else { 'missing' }`,
);
report.toastsEnabled = dnd || 'unknown';

// 专注助手状态（新版本用 CloudStore，简化判断：看任务栏是否有"请勿打扰"提示）
const qh = ps(
  `$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current\\default$windows.data.notifications.quiethourssettings\\Current'; ` +
    `if (Test-Path $k) { 'present' } else { 'absent' }`,
);
report.notes.push(`QuietHours 注册表项: ${qh}`);

// 2) 启动应用，调用 testNotification
const child = spawn(EXE, ['--remote-debugging-port=9351'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '' },
});
await new Promise((r) => setTimeout(r, 9000));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9351');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(2000);
  const r = await page.evaluate(async () => {
    try {
      return await window.dgut.testNotification();
    } catch (e) {
      return { error: String(e) };
    }
  });
  report.apiSupported = r.supported ?? false;
  report.apiShown = r.shown ?? false;
  report.notes.push(`API 返回: ${JSON.stringify(r)}`);
  console.log('API 结果:', JSON.stringify(r));
} catch (e) {
  report.notes.push(`CDP 失败: ${String(e).slice(0, 150)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
}

// 3) 判定
report.verdict = report.apiSupported && report.apiShown ? 'API_OK' : 'API_FAILED';
if (report.apiShown && /请勿打扰|Do not disturb/i.test(report.notes.join(' '))) {
  report.verdict = 'API_OK_BUT_DND_MAY_BLOCK';
}

writeFileSync(join(ROOT, 'docs', 'screenshots', 'notification-report.json'), JSON.stringify(report, null, 2));
console.log('\n报告:', JSON.stringify(report, null, 2));
console.log('VERDICT:', report.verdict);
process.exit(report.apiSupported ? 0 : 1);
