/**
 * 开机自启端到端验证（不需要真的重启，通过注册表客观断言）。
 *
 * 断言链：
 *  1. 默认不自启（注册表无该项）
 *  2. 开启后 → 注册表出现指向本应用的项
 *  3. 关闭后 → 注册表项被移除
 *  4. 设置持久化到 store
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const INSTALLED = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'dgut-deadline', '莞工Deadline.exe');
const useInstalled = existsSync(INSTALLED);
const exe = useInstalled ? INSTALLED : (await import('electron')).default;
const userData = mkdtempSync(join(tmpdir(), 'dgut-autostart-'));

const result = { steps: [], checks: {}, verdict: 'FAIL' };

/** 读取 HKCU Run 下是否有本应用的项 */
function readRunEntry() {
  const script = `
$p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
try {
  $v = Get-ItemProperty -Path $p -ErrorAction Stop
  $hit = @()
  foreach ($n in $v.PSObject.Properties.Name) {
    if ($n -notlike 'PS*' -and ($v.$n -like '*dgut-deadline*' -or $v.$n -like '*莞工*' -or $n -like '*dgut*' -or $n -like '*Deadline*')) {
      $hit += @{ name = $n; value = $v.$n }
    }
  }
  $hit | ConvertTo-Json -Compress
} catch { '[]' }
`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
    if (!out || out === '[]') return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

try {
  // 起始状态：应为空（默认关闭）
  const before = readRunEntry();
  result.checks.defaultOff = before.length === 0;
  result.steps.push({ name: 'initialRunEntries', entries: before });

  const args = useInstalled
    ? [`--user-data-dir=${userData}`, '--remote-debugging-port=9360']
    : ['.', `--user-data-dir=${userData}`, '--remote-debugging-port=9360'];

  const child = spawn(exe, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d.toString()));
  await new Promise((r) => setTimeout(r, 10000));

  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9360');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);

  // 1) 开启自启
  const on = await page.evaluate(async () => {
    const s = await window.dgut.updateSettings({ launchAtLogin: true });
    return { launchAtLogin: s.settings.launchAtLogin };
  });
  await new Promise((r) => setTimeout(r, 1500));
  const afterOn = readRunEntry();
  result.checks.enableWritesRegistry = afterOn.length > 0;
  result.checks.settingPersistedOn = on.launchAtLogin === true;
  result.steps.push({ name: 'enable', setting: on, entries: afterOn });

  // 2) 确认指向本应用
  const pointsToApp = afterOn.some(
    (e) => String(e.value).includes('dgut-deadline') || String(e.value).includes('莞工'),
  );
  result.checks.registryPointsToApp = pointsToApp;

  // 3) 关闭自启
  const off = await page.evaluate(async () => {
    const s = await window.dgut.updateSettings({ launchAtLogin: false });
    return { launchAtLogin: s.settings.launchAtLogin };
  });
  await new Promise((r) => setTimeout(r, 1500));
  const afterOff = readRunEntry();
  result.checks.disableRemovesRegistry = afterOff.length === 0;
  result.checks.settingPersistedOff = off.launchAtLogin === false;
  result.steps.push({ name: 'disable', setting: off, entries: afterOff });

  await browser.close().catch(() => {});
  child.kill();

  result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL';
  if (err.trim()) {
    const rel = err.split('\n').filter((l) => /ERR_|Cannot/i.test(l)).slice(0, 3);
    if (rel.length) result.steps.push({ name: 'stderr', lines: rel });
  }
} catch (e) {
  result.steps.push({ name: 'error', message: String(e).slice(0, 300) });
}

console.log(JSON.stringify(result, null, 2));
console.log('AUTOSTART_E2E:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
