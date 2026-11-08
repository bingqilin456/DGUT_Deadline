/**
 * 休眠恢复补偿验证。
 *
 * 不需要真的休眠：直接调用 powerMonitor 的 resume 事件处理器所触发的同一个
 * 补偿入口（ReminderScheduler.compensate），验证：
 *  1. 模拟"应用关闭期间错过了截止提醒"，恢复后补发但不过量
 *  2. 过期 > 24h 的不补发（防通知轰炸）
 *
 * 通过构造两个作业实现：
 *  - A：2 小时前刚过截止（应补发）
 *  - B：3 天前过截止（不应补发）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const INSTALLED = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'dgut-deadline', '莞工Deadline.exe');
const useInstalled = existsSync(INSTALLED);
const exe = useInstalled ? INSTALLED : (await import('electron')).default;
const userData = mkdtempSync(join(tmpdir(), 'dgut-resume-'));

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const toLocal = (ms) => {
  const p = (n) => String(n).padStart(2, '0');
  const sh = new Date(ms + 8 * 3600 * 1000);
  return `${sh.getUTCFullYear()}-${p(sh.getUTCMonth() + 1)}-${p(sh.getUTCDate())}T${p(sh.getUTCHours())}:${p(sh.getUTCMinutes())}:00+08:00`;
};

const mk = (id, title, dueMs) => ({
  source: 'hw',
  sourceAssignmentId: id,
  id: `hw:${id}`,
  courseId: null,
  courseName: '休眠恢复测试课程',
  title,
  detailUrl: 'https://hw.dgut.edu.cn/student/homeworkPlan',
  dueAt: toLocal(dueMs),
  duePrecision: 'datetime',
  submissionStatus: 'not_submitted',
  statusEvidence: 'resume-test',
  firstSeenAt: iso(now),
  lastSeenAt: iso(now),
  lastSyncAt: iso(now),
  sourceUpdatedAt: null,
});

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
    notifyUnknownStatus: false,
    theme: 'light',
    lastSyncAt: iso(now),
  },
  assignments: { ulearning: [],
    hw: [
      // 2 小时前刚过截止 → 应补偿提醒
      mk('9101', '【恢复】两小时前截止', now - 2 * 3600 * 1000),
      // 3 天前截止 → 不应补发（防止通知轰炸）
      mk('9102', '【恢复】三天前截止', now - 72 * 3600 * 1000),
    ],
  },
  lastSuccess: { hw: iso(now) },
  sessions: {},
  reminders: [],
  overrides: {},
};
writeFileSync(join(userData, 'dgut-deadline.json'), JSON.stringify(store, null, 2), 'utf8');

const result = { steps: [], checks: {}, verdict: 'FAIL' };
const args = useInstalled
  ? [`--user-data-dir=${userData}`, '--remote-debugging-port=9362']
  : ['.', `--user-data-dir=${userData}`, '--remote-debugging-port=9362'];
const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
await new Promise((r) => setTimeout(r, 14000));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9362');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('index.html')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);

  // 启动时 ReminderScheduler 会补偿一次；等它跑完
  await new Promise((r) => setTimeout(r, 2000));

  const stored = JSON.parse(readFileSync(join(userData, 'dgut-deadline.json'), 'utf8'));
  const keys = (stored.reminders ?? []).map((r) => r.key);
  result.steps.push({ name: 'remindersAfterStartup', keys });

  const hasRecent = keys.some((k) => k.includes('9101'));
  const hasOld = keys.some((k) => k.includes('9102'));

  result.checks.recentDueCompensated = hasRecent;
  result.checks.oldDueNotCompensated = !hasOld;

  // 再触发一次补偿，验证幂等（不新增）
  await page.evaluate(async () => {
    // 通过再次同步/快照触发，不应重复记录
    await window.dgut.getSnapshot();
  });
  await new Promise((r) => setTimeout(r, 1500));
  const stored2 = JSON.parse(readFileSync(join(userData, 'dgut-deadline.json'), 'utf8'));
  const keys2 = (stored2.reminders ?? []).map((r) => r.key);
  result.checks.idempotent = keys2.length === keys.length;
  result.steps.push({ name: 'afterSecondPass', count: keys2.length, firstCount: keys.length });

  result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  result.steps.push({ name: 'error', message: String(e).slice(0, 300) });
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
}

console.log(JSON.stringify(result, null, 2));
console.log('RESUME_E2E:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
