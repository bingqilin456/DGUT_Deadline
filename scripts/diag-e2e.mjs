/**
 * 诊断功能端到端验证：确认 diagnoseSource 能返回精确的链路诊断。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const INSTALLED = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'dgut-deadline', '莞工Deadline.exe');
const useInstalled = existsSync(INSTALLED);
const exe = useInstalled ? INSTALLED : (await import('electron')).default;
const userData = mkdtempSync(join(tmpdir(), 'dgut-diag-'));
mkdirSync(join(ROOT, 'docs', 'screenshots'), { recursive: true });

const result = { diag: null, checks: {}, verdict: 'FAIL' };
const args = useInstalled
  ? [`--user-data-dir=${userData}`, '--remote-debugging-port=9370']
  : ['.', `--user-data-dir=${userData}`, '--remote-debugging-port=9370'];
const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
let err = '';
child.stderr.on('data', (d) => (err += d.toString()));
await new Promise((r) => setTimeout(r, 10000));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9370');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);

  // 1) LMS 诊断
  const lms = await page.evaluate(async () => await window.dgut.diagnoseSource('ulearning'));
  result.diag = lms;
  result.checks.hasSteps = Array.isArray(lms.steps) && lms.steps.length >= 4;
  result.checks.hasSummary = typeof lms.summary === 'string' && lms.summary.length > 10;
  result.checks.reportsBlockedStep = typeof lms.blockedAt === 'string';
  // sld/pc.html 应为 404（异常），cas 应可达（正常）
  const sld = lms.steps.find((s) => s.id === 'sld-entry');
  const cas = lms.steps.find((s) => s.id === 'cas-reachable');
  result.checks.sldDetectedAsBroken = sld ? sld.ok === false : false;
  result.checks.casReachable = cas ? cas.ok === true : false;

  // 2) hw 诊断
  const hw = await page.evaluate(async () => await window.dgut.diagnoseSource('hw'));
  result.checks.hwDiagWorks = Array.isArray(hw.steps) && hw.steps.length >= 1;

  // 3) 切到设置页截图
  const tab = page.locator('.tab', { hasText: '设置' });
  if (await tab.count()) {
    await tab.click();
    await page.waitForTimeout(600);
    // 点诊断按钮
    const btn = page.locator('button', { hasText: '诊断优学院' });
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(6000);
      const rows = await page.locator('table tbody tr').count();
      result.checks.uiRendersDiagTable = rows >= 4;
      await page.screenshot({ path: join(ROOT, 'docs', 'screenshots', 'diagnostic-panel.png') });
    }
  }

  result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  result.checks.error = String(e).slice(0, 300);
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  if (err.trim()) {
    const rel = err.split('\n').filter((l) => /ERR_|Cannot/i.test(l)).slice(0, 4);
    if (rel.length) result.checks.stderr = rel;
  }
}

console.log(JSON.stringify(result, null, 2));
console.log('DIAG_E2E:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
