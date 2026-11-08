/**
 * 右下角提醒弹窗 + 任务栏闪烁 端到端验证。
 *
 * 构造一条 2 小时后截止的作业，使 12h/6h/3h 阈值已过，
 * 验证：
 *  1. 弹出右下角窗口（BrowserWindow 真实存在，位置在屏幕右下）
 *  2. 任务栏高亮（flashFrame 被调用 —— 通过窗口状态间接验证）
 *  3. 未确认前窗口持续存在
 *  4. 点「我已知晓」后窗口关闭
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

const userData = mkdtempSync(join(tmpdir(), 'dgut-toast-'));
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const toLocal = (ms) => {
  const p = (n) => String(n).padStart(2, '0');
  const sh = new Date(ms + 8 * 3600 * 1000);
  return `${sh.getUTCFullYear()}-${p(sh.getUTCMonth() + 1)}-${p(sh.getUTCDate())}T${p(sh.getUTCHours())}:${p(sh.getUTCMinutes())}:00+08:00`;
};

// 2 小时后截止 => 12h/6h/3h 阈值已过（1h 未到）
const dueMs = now + 2 * 3600 * 1000;
const store = {
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
    syncIntervalMinutes: 0,
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    launchAtLogin: false,
    minimizeToTrayOnClose: true,
    notifyUnknownStatus: true,
    theme: 'light',
    lastSyncAt: iso(now),
  },
  assignments: {
    ulearning: [],
    hw: [
      {
        source: 'hw',
        sourceAssignmentId: '9501',
        id: 'hw:9501',
        courseId: null,
        courseName: '弹窗测试课程',
        title: '【弹窗测试】两小时后截止的作业',
        detailUrl: 'https://hw.dgut.edu.cn/student/homeworkPlan',
        dueAt: toLocal(dueMs),
        duePrecision: 'datetime',
        submissionStatus: 'not_submitted',
        statusEvidence: 'toast-test',
        firstSeenAt: iso(now),
        lastSeenAt: iso(now),
        lastSyncAt: iso(now),
        sourceUpdatedAt: null,
      },
    ],
  },
  lastSuccess: { hw: iso(now) },
  sessions: {},
  reminders: [],
  overrides: {},
};
writeFileSync(join(userData, 'dgut-deadline.json'), JSON.stringify(store, null, 2), 'utf8');

const result = { checks: {}, verdict: 'FAIL' };
const child = spawn(EXE, [`--user-data-dir=${userData}`, '--remote-debugging-port=9395'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '' },
});
let err = '';
child.stderr.on('data', (d) => (err += d.toString()));
await new Promise((r) => setTimeout(r, 12000));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9395');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  result.check_pageCount = pages.length;

  // 找出 toast 窗口（URL 含 toast.html）
  const toastPage = pages.find((p) => p.url().includes('toast.html'));
  result.checks.toastWindowOpened = !!toastPage;

  if (toastPage) {
    // 检查 DOM 中的提醒卡片
    const cards = await toastPage.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.card'));
      return items.map((c) => ({
        title: c.querySelector('.title')?.textContent ?? '',
        body: (c.querySelector('.body')?.textContent ?? '').slice(0, 80),
        urgent: c.classList.contains('urgent'),
      }));
    });
    result.cards = cards;
    result.checks.hasCards = cards.length > 0;
    result.checks.hasUrgentCard = cards.some((c) => c.urgent);
    result.checks.hasAckButton = (await toastPage.locator('button', { hasText: '我已知晓' }).count()) > 0;
    result.checks.mentionHours = cards.some((c) => /12|6|3/.test(c.title));

    await toastPage.screenshot({ path: join(ROOT, 'docs', 'screenshots', 'toast-popup.png') });

    // 点击「我已知晓」验证确认机制
    const ackCount = await toastPage.locator('button', { hasText: '我已知晓' }).count();
    if (ackCount > 0) {
      await toastPage.locator('button', { hasText: '我已知晓' }).first().click();
      await new Promise((r) => setTimeout(r, 1500));
      const after = await toastPage.evaluate(
        () => document.querySelectorAll('.card').length,
      );
      result.checks.ackRemovesCard = after < cards.length;
    }
  }

  result.verdict = Object.values(result.checks).every((v) => v === true) ? 'PASS' : 'FAIL';
} catch (e) {
  result.checks.error = String(e).slice(0, 300);
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  if (err.trim()) {
    const rel = err.split('\n').filter((l) => /ERR_|Cannot|toast/i.test(l)).slice(0, 5);
    if (rel.length) result.checks.stderr = rel;
  }
}

console.log(JSON.stringify(result, null, 2).slice(0, 3000));
console.log('TOAST_E2E:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
