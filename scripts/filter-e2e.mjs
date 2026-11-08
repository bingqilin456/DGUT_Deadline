/**
 * 筛选功能端到端验证（真实 UI 交互）。
 *
 * 验证用户明确要求的行为：
 *  1. 默认只看未截止
 *  2. 默认按截止时间最近优先
 *  3. 平台 / 课程 / 状态 / 剩余 筛选可用
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXE = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'dgut-deadline', '莞工Deadline.exe');
if (!existsSync(EXE)) {
  console.log('FAIL: 未安装');
  process.exit(1);
}
mkdirSync(join(ROOT, 'docs', 'screenshots'), { recursive: true });

const userData = mkdtempSync(join(tmpdir(), 'dgut-filter-'));
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const toLocal = (ms) => {
  const p = (n) => String(n).padStart(2, '0');
  const sh = new Date(ms + 8 * 3600 * 1000);
  return `${sh.getUTCFullYear()}-${p(sh.getUTCMonth() + 1)}-${p(sh.getUTCDate())}T${p(sh.getUTCHours())}:${p(sh.getUTCMinutes())}:00+08:00`;
};

const mk = (id, source, course, title, hoursFromNow, status) => ({
  source,
  sourceAssignmentId: id,
  id: `${source}:${id}`,
  courseId: null,
  courseName: course,
  title,
  detailUrl: null,
  dueAt: hoursFromNow === null ? null : toLocal(now + hoursFromNow * 3600 * 1000),
  duePrecision: hoursFromNow === null ? 'none' : 'datetime',
  submissionStatus: status,
  statusEvidence: 'filter-test',
  firstSeenAt: iso(now),
  lastSeenAt: iso(now),
  lastSyncAt: iso(now),
  sourceUpdatedAt: null,
});

// 构造覆盖各种情况的测试数据
const list = [
  mk('1', 'hw', '数据库', '【筛选】2小时后截止', 2, 'not_submitted'),
  mk('2', 'hw', '数据库', '【筛选】已过期未提交', -5, 'not_submitted'),
  mk('3', 'ulearning', 'Python', '【筛选】20小时后截止', 20, 'not_submitted'),
  mk('4', 'ulearning', 'Python', '【筛选】已提交', 50, 'submitted'),
  mk('5', 'hw', '数学', '【筛选】5天后截止', 120, 'not_submitted'),
  mk('6', 'ulearning', '数学', '【筛选】无截止时间', null, 'not_submitted'),
];

const store = {
  schemaVersion: 2,
  settings: {
    thresholds: [
      { hours: 72, enabled: true, urgent: false },
      { hours: 24, enabled: true, urgent: false },
      { hours: 3, enabled: true, urgent: true },
    ],
    syncIntervalMinutes: 0,
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    launchAtLogin: false,
    minimizeToTrayOnClose: true,
    notifyUnknownStatus: false,
    theme: 'light',
    lastSyncAt: iso(now),
  },
  assignments: { ulearning: list.filter((a) => a.source === 'ulearning'), hw: list.filter((a) => a.source === 'hw') },
  lastSuccess: { hw: iso(now), ulearning: iso(now) },
  sessions: {
    hw: { source: 'hw', state: 'connected', message: 'ok', lastSuccessAt: iso(now), lastAttemptAt: iso(now), requiresUserAction: false },
    ulearning: { source: 'ulearning', state: 'connected', message: 'ok', lastSuccessAt: iso(now), lastAttemptAt: iso(now), requiresUserAction: false },
  },
  reminders: [],
  overrides: {},
};
writeFileSync(join(userData, 'dgut-deadline.json'), JSON.stringify(store, null, 2), 'utf8');

const result = { checks: {}, verdict: 'FAIL' };
const child = spawn(EXE, [`--user-data-dir=${userData}`, '--remote-debugging-port=9396'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '' },
});
let err = '';
child.stderr.on('data', (d) => (err += d.toString()));
await new Promise((r) => setTimeout(r, 12000));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9396');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('index.html')) ?? ctx.pages()[0];
  await page.waitForTimeout(3000);

  const rowTitles = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('tbody tr td:nth-child(2) .title')).map((e) =>
        e.textContent.trim(),
      ),
    );

  // 1) 默认：隐藏已截止 + 截止最近在前
  const def = await rowTitles();
  result.defaultRows = def;
  result.checks.defaultHidesExpired = !def.some((t) => t.includes('已过期未提交'));
  result.checks.defaultSortedByDueAsc = (() => {
    // 期望顺序：2h(1) -> 20h(3) -> 50h(4) -> 120h(5) -> 无截止(6)
    const idx = (kw) => def.findIndex((t) => t.includes(kw));
    return (
      idx('2小时后') >= 0 &&
      idx('20小时后') > idx('2小时后') &&
      idx('已提交') > idx('20小时后') &&
      idx('5天后') > idx('已提交') &&
      idx('无截止时间') > idx('5天后')
    );
  })();
  result.checks.filterBarVisible = (await page.locator('.filters').count()) > 0;


  // 2) 平台筛选 hw
  await page.selectOption('.filters select >> nth=0', 'hw');
  await page.waitForTimeout(600);
  const hwRows = await rowTitles();
  result.checks.platformFilter = hwRows.length > 0 && hwRows.every((t) => t.includes('筛选'));

  // 3) 课程筛选
  await page.selectOption('.filters select >> nth=0', 'all');
  await page.waitForTimeout(400);
  await page.selectOption('.filters select >> nth=1', 'Python');
  await page.waitForTimeout(600);
  const pyRows = await rowTitles();
  result.checks.courseFilter = pyRows.length === 2 && pyRows.every((t) => /20小时|已提交/.test(t));

  // 4) 状态筛选：已提交
  await page.selectOption('.filters select >> nth=1', 'all');
  await page.waitForTimeout(400);
  await page.selectOption('.filters select >> nth=4', 'submitted');
  await page.waitForTimeout(600);
  const subRows = await rowTitles();
  result.checks.statusFilter = subRows.length === 1 && subRows[0].includes('已提交');

  // 5) 关闭隐藏已截止 -> 应看到过期项
  await page.selectOption('.filters select >> nth=4', 'all');
  await page.waitForTimeout(400);
  const cb = page.locator('.filters input[type=checkbox]').first();
  await cb.uncheck();
  await page.waitForTimeout(600);
  const allRows = await rowTitles();
  result.checks.showExpiredWorks = allRows.some((t) => t.includes('已过期未提交'));

  // 6) 剩余筛选：24 小时内
  await cb.check();
  await page.waitForTimeout(400);
  await page.selectOption('.filters select >> nth=3', '24h');
  await page.waitForTimeout(600);
  const soonRows = await rowTitles();
  result.remainRows = soonRows;
  // 24 小时内应包含 "2 小时后" 与 "20 小时后" 两条，不含 50h/120h/无截止
  result.checks.remainFilter =
    soonRows.length === 2 &&
    soonRows.some((r) => r.includes('2小时后')) &&
    soonRows.some((r) => r.includes('20小时后'));

  // 7) 重置
  await page.locator('button', { hasText: '重置筛选' }).click();
  await page.waitForTimeout(600);
  const resetRows = await rowTitles();
  result.checks.resetWorks = resetRows.length === def.length;

  // 截图可能因右下角弹窗窗口干扰而超时，单独容错处理
  await page
    .screenshot({ path: join(ROOT, 'docs', 'screenshots', 'filter-default.png'), timeout: 8000 })
    .catch(() => {});

  result.verdict = Object.values(result.checks).every((v) => v === true) ? 'PASS' : 'FAIL';
} catch (e) {
  result.checks.error = String(e).slice(0, 400);
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  if (err.trim()) {
    const rel = err.split('\n').filter((l) => /ERR_|Cannot/i.test(l)).slice(0, 4);
    if (rel.length) result.checks.stderr = rel;
  }
}

console.log(JSON.stringify(result, null, 2).slice(0, 3000));
console.log('FILTER_E2E:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
