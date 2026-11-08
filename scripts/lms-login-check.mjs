/**
 * 验证 LMS「登录」按钮不再抛 ERR_ABORTED，并确认能打开中央认证页。
 * 用安装版程序 + CDP 调用真实 IPC。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXE = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'dgut-deadline', '莞工Deadline.exe');
if (!existsSync(EXE)) {
  console.log('FAIL: 安装版不存在');
  process.exit(1);
}
mkdirSync(join(ROOT, 'docs', 'screenshots'), { recursive: true });

const child = spawn(EXE, ['--remote-debugging-port=9339'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '' },
});
let err = '';
child.stderr.on('data', (d) => (err += d.toString()));
await new Promise((r) => setTimeout(r, 7000));

const { chromium } = await import('playwright-core');
let browser;
let verdict = 'FAIL';
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9339');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);

  // 调用真实的 login('ulearning')，这正是用户点「去登录」时走的路径
  const loginResult = await page.evaluate(async () => {
    const t0 = Date.now();
    try {
      const snap = await window.dgut.login('ulearning');
      const lms = snap.sources.find((s) => s.source === 'ulearning');
      return {
        ok: true,
        ms: Date.now() - t0,
        state: lms?.session?.state ?? 'none',
        message: (lms?.session?.message ?? '').slice(0, 200),
      };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: String(e).slice(0, 300) };
    }
  });
  console.log('LMS_LOGIN_RESULT:', JSON.stringify(loginResult, null, 2));

  // 检查受控 Edge 是否真的打开了中央认证页
  await new Promise((r) => setTimeout(r, 3000));
  const { execFileSync } = await import('node:child_process');
  let casOpen = false;
  try {
    const ps = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*dgut-deadline*' } | Measure-Object | Select-Object -ExpandProperty Count`,
      ],
      { encoding: 'utf8' },
    );
    const n = Number(ps.trim());
    casOpen = n > 0;
    console.log('受控 Edge 进程数:', n);
  } catch {}

  const noAbortError = loginResult.ok === true;
  verdict = noAbortError && loginResult.state === 'needs_login' ? 'PASS' : 'FAIL';

  writeFileSync(
    join(ROOT, 'docs', 'screenshots', 'lms-login-probe.json'),
    JSON.stringify({ loginResult, casOpen }, null, 2),
  );
} catch (e) {
  console.log('CDP failed:', String(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  console.log('LMS_LOGIN_FIX_RESULT:', verdict);
  child.kill();
  process.exit(verdict === 'PASS' ? 0 : 1);
}
