/**
 * 演示模式验证。
 *
 * 需求硬约束：演示数据必须**明确标注「演示」**，绝不能与真实数据混淆。
 * 断言：
 *  1. 开启后列表全部为演示数据，每条带 isDemo 标记与「演示」前缀
 *  2. 顶部显示醒目横幅
 *  3. 关闭后恢复真实数据
 *  4. 演示数据不写入真实缓存、不触发真实提醒
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXE = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'dgut-deadline', '莞工Deadline.exe');
if (!existsSync(EXE)) {
  console.log('FAIL: 未安装');
  process.exit(1);
}
mkdirSync(join(ROOT, 'docs', 'screenshots'), { recursive: true });

const userData = mkdtempSync(join(tmpdir(), 'dgut-demo-'));
const result = { checks: {}, verdict: 'FAIL' };

const child = spawn(EXE, [`--user-data-dir=${userData}`, '--remote-debugging-port=9390'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '' },
});
let err = '';
child.stderr.on('data', (d) => (err += d.toString()));
await new Promise((r) => setTimeout(r, 11000));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9390');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);

  // 1) 开启演示模式
  const on = await page.evaluate(async () => {
    const s = await window.dgut.updateSettings({ showDemoData: true });
    return {
      demoMode: s.demoMode,
      count: s.assignments.length,
      allDemo: s.assignments.every((a) => a.isDemo === true),
      allPrefixed: s.assignments.every((a) => a.title.startsWith('【演示】')),
      sampleTitles: s.assignments.slice(0, 3).map((a) => a.title),
    };
  });
  result.checks.demoModeOn = on.demoMode === true;
  result.checks.allMarkedDemo = on.allDemo === true;
  result.checks.allPrefixed = on.allPrefixed === true;
  result.on = on;

  // 2) UI 应显示醒目横幅
  await page.waitForTimeout(1200);
  const banner = await page.evaluate(() => {
    const el = document.querySelector('.banner.danger');
    return el ? el.textContent.trim().slice(0, 100) : null;
  });
  result.checks.bannerShown = typeof banner === 'string' && banner.includes('演示模式');
  result.banner = banner;

  // 3) 表格内应有「演示」徽章
  const demoBadges = await page.evaluate(
    () => document.querySelectorAll('td .badge').length,
  );
  result.checks.hasBadges = demoBadges > 0;

  await page.screenshot({ path: join(ROOT, 'docs', 'screenshots', 'demo-mode.png') });

  // 4) 演示数据不写入真实缓存
  const storePath = join(userData, 'dgut-deadline.json');
  let cachedCount = 0;
  if (existsSync(storePath)) {
    const st = JSON.parse(readFileSync(storePath, 'utf8'));
    cachedCount = (st.assignments?.hw?.length ?? 0) + (st.assignments?.ulearning?.length ?? 0);
  }
  result.checks.noCachePollution = cachedCount === 0;
  result.cachedCount = cachedCount;

  // 5) 关闭后恢复
  const off = await page.evaluate(async () => {
    const s = await window.dgut.updateSettings({ showDemoData: false });
    return { demoMode: s.demoMode, count: s.assignments.length, anyDemo: s.assignments.some((a) => a.isDemo) };
  });
  result.checks.demoModeOff = off.demoMode === false;
  result.checks.noDemoAfterOff = off.anyDemo === false;

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
console.log('DEMO_E2E:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
