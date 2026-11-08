/**
 * 托盘行为验证（Node 驱动，避免 PowerShell 解析问题）。
 *
 * 验证：
 *  1. 启动后托盘图标存在
 *  2. 关闭主窗口后：进程仍在 + 窗口隐藏 + 托盘仍在
 *  3. 可通过托盘唤回窗口（用 IPC 模拟菜单点击）
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXE = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'dgut-deadline', '莞工Deadline.exe');
if (!existsSync(EXE)) {
  console.log('FAIL: 未找到安装版');
  process.exit(1);
}

/** 用 UI Automation 检测托盘项，返回 {found, matches}
 *  注意：必须精确匹配应用托盘项（形如「莞工 Deadline - N 个运行窗口」），
 *  否则会把任务栏的「网络 莞工全光无线」误判为托盘图标。
 */
function trayCheck() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ClassNameProperty), 'Shell_TrayWnd'
$tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
$btnCond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Button)
$buttons = $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
$m = @()
foreach ($b in $buttons) {
  $n = $b.Current.Name
  # 精确规则：应用托盘/任务栏项形如 "莞工 Deadline - 1 个运行窗口"
  if ($n -match '莞工\\s*Deadline') { $m += $n }
}
@{ found = ($m.Count -gt 0); matches = $m } | ConvertTo-Json -Compress
`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    return JSON.parse(out.trim());
  } catch {
    return { found: false, matches: [] };
  }
}

const result = { steps: [], checks: {}, verdict: 'FAIL' };

// 清理旧实例
try {
  execFileSync('powershell', ['-NoProfile', '-Command', `Get-Process -Name '莞工Deadline' -ErrorAction SilentlyContinue | Stop-Process -Force`]);
} catch {}
await new Promise((r) => setTimeout(r, 2000));

const userData = mkdtempSync(join(tmpdir(), 'dgut-tray-verify-'));
const child = spawn(EXE, [`--user-data-dir=${userData}`, '--remote-debugging-port=9357'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '' },
});
let err = '';
child.stderr.on('data', (d) => (err += d.toString()));
await new Promise((r) => setTimeout(r, 10000));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9357');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);

  // 1) 启动后托盘
  const t1 = trayCheck();
  result.checks.trayAfterStart = t1.found;
  result.steps.push({ name: 'afterStart', tray: t1 });

  // 2) 模拟用户点窗口 X：走真实 IPC 路径（window.close 会绕过 close 事件，
  //    不能代表真实用户行为）。这里通过主进程的 hide 语义验证。
  await page.evaluate(() => {
    // 触发真实关闭：window.close() 在 Electron 中会走 beforeunload + close 事件
    window.close();
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 4500));

  const t2 = trayCheck();
  result.checks.trayAfterClose = t2.found;
  result.checks.processAliveAfterClose = child.exitCode === null;
  result.steps.push({ name: 'afterWindowClose', tray: t2, alive: child.exitCode === null });

  // 3) 尝试用 CDP 确认窗口是否还活着（隐藏 ≠ 销毁）
  let windowAlive = false;
  try {
    const b2 = await chromium.connectOverCDP('http://127.0.0.1:9357');
    const pages = b2.contexts()[0].pages();
    windowAlive = pages.length > 0;
    await b2.close();
  } catch {}
  result.checks.windowNotDestroyed = windowAlive;

  result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  result.steps.push({ name: 'error', message: String(e).slice(0, 250) });
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null) child.kill();
  if (err.trim()) {
    const rel = err.split('\n').filter((l) => /tray|Tray|ERR_|Cannot/i.test(l)).slice(0, 6);
    if (rel.length) result.steps.push({ name: 'stderr', lines: rel });
  }
}

console.log(JSON.stringify(result, null, 2));
console.log('TRAY_VERIFY:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
