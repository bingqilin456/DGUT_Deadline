/**
 * 用**用户真实缓存数据**渲染列表，断言考试按结束时间排序。
 *
 * 只读：读取 store 副本，不联网、不登录、不写用户数据。
 * 复刻渲染层真实路径：App.vue 的 applyFilter(assignments, DEFAULT_FILTER, now)。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const PORT = 9471;
const REAL = join(process.env['APPDATA'] ?? '', 'dgut-deadline', 'dgut-deadline.json');
if (!existsSync(REAL)) {
  console.log('SKIP: 本机无真实缓存');
  process.exit(0);
}

// 复制到隔离目录，绝不动用户真实数据
const userData = mkdtempSync(join(tmpdir(), 'dgut-sortcheck-'));
copyFileSync(REAL, join(userData, 'dgut-deadline.json'));
mkdirSync(join(ROOT, 'docs', 'screenshots'), { recursive: true });

const electron = (await import('electron')).default;
const env = { ...process.env, NODE_OPTIONS: '' };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electron,
  ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`],
  { stdio: ['ignore', 'pipe', 'pipe'], env },
);
await new Promise((r) => setTimeout(r, 11000));

const result = { checks: {}, rows: [], verdict: 'FAIL' };
const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(3000);

  // 切到「考试」筛选，读表格前 N 行的结束时间与剩余文案
  const tab = page.locator('.tab, button', { hasText: '考试' }).first();
  if (await tab.count()) {
    await tab.click().catch(() => {});
    await page.waitForTimeout(1200);
  }

  const rows = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('tbody tr'));
    return trs.slice(0, 12).map((tr) => {
      const tds = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.replace(/\s+/g, ' ').trim());
      return tds;
    });
  });
  result.rows = rows;

  // 断言：按「结束」时间单调递增
  const endTimes = rows
    .map((tds) => {
      const joined = tds.join(' | ');
      const m = joined.match(/结束\s*(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2})/);
      return m ? Date.parse(m[1].replace(/\//g, '-')) : null;
    })
    .filter((x) => x !== null);

  let sorted = true;
  for (let i = 1; i < endTimes.length; i++) {
    if (endTimes[i] < endTimes[i - 1]) {
      sorted = false;
      break;
    }
  }
  result.checks.rowsRendered = rows.length > 0;
  result.checks.sortedByEndTimeAsc = sorted;
  result.checks.endTimesParsed = endTimes.length >= 2;
  result.endTimes = endTimes.map((t) => new Date(t).toISOString());

  await page.screenshot({ path: join(ROOT, 'docs', 'screenshots', 'exam-sort-by-end.png'), fullPage: false });
  result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  result.checks.error = String(e).slice(0, 300);
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
}

writeFileSync(join(ROOT, 'docs', 'screenshots', 'exam-sort-by-end.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2).slice(0, 3500));
console.log('EXAM_SORT_E2E:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
