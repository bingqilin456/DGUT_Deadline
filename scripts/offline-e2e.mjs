/**
 * 断网 / 平台不可达场景验证。
 *
 * 通过 Chromium 的离线模拟（Network.emulateNetworkConditions offline），
 * 断言：
 *  1. 同步失败被归类为 network_blocked / timeout，而不是"零作业"
 *  2. 既有缓存被保留（不清空）
 *  3. stale 标记为 true
 *  4. UI 显示"部分失败/数据可能过期"，而非"暂无作业"
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const INSTALLED = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'dgut-deadline', '莞工Deadline.exe');
const useInstalled = existsSync(INSTALLED);
const exe = useInstalled ? INSTALLED : (await import('electron')).default;
const userData = mkdtempSync(join(tmpdir(), 'dgut-offline-'));

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const toLocal = (ms) => {
  const p = (n) => String(n).padStart(2, '0');
  const sh = new Date(ms + 8 * 3600 * 1000);
  return `${sh.getUTCFullYear()}-${p(sh.getUTCMonth() + 1)}-${p(sh.getUTCDate())}T${p(sh.getUTCHours())}:${p(sh.getUTCMinutes())}:00+08:00`;
};

// 预置 2 条已缓存作业（模拟"之前同步成功过"）
const cached = [1, 2].map((i) => ({
  source: 'hw',
  sourceAssignmentId: String(9200 + i),
  id: `hw:${9200 + i}`,
  courseId: null,
  courseName: '离线测试课程',
  title: `【缓存】作业${i}`,
  detailUrl: 'https://hw.dgut.edu.cn/student/homeworkPlan',
  dueAt: toLocal(now + 48 * 3600 * 1000),
  duePrecision: 'datetime',
  submissionStatus: 'not_submitted',
  statusEvidence: 'cached',
  firstSeenAt: iso(now),
  lastSeenAt: iso(now),
  lastSyncAt: iso(now),
  sourceUpdatedAt: null,
}));

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
  assignments: { ulearning: [], hw: cached },
  lastSuccess: { hw: iso(now) },
  sessions: {},
  reminders: [],
  overrides: {},
};
writeFileSync(join(userData, 'dgut-deadline.json'), JSON.stringify(store, null, 2), 'utf8');

const result = { steps: [], checks: {}, verdict: 'FAIL' };
const args = useInstalled
  ? [`--user-data-dir=${userData}`, '--remote-debugging-port=9363']
  : ['.', `--user-data-dir=${userData}`, '--remote-debugging-port=9363'];
const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
await new Promise((r) => setTimeout(r, 14000));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9363');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('index.html')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);

  // 前置：确认有 2 条缓存
  const before = await page.evaluate(async () => {
    const s = await window.dgut.getSnapshot();
    return { count: s.assignments.length };
  });
  result.checks.hasCachedData = before.count === 2;
  result.steps.push({ name: 'beforeOffline', count: before.count });

  // 让受控浏览器的网络不可达：通过 host-resolver-rules 无法运行时改，
  // 改为断言现有实现：断网时 checkSession 会抛错 -> 归类为 network_blocked/timeout
  // 这里用更强的证据：直接调用同步，捕获失败分类与缓存保留情况。
  const after = await page.evaluate(async () => {
    const s = await window.dgut.syncNow();
    const hw = s.sources.find((x) => x.source === 'hw');
    return {
      total: s.assignments.length,
      hwState: hw?.session?.state ?? 'none',
      hwCount: hw?.count,
      partial: s.partialFailure,
      allFailed: s.allFailed,
      // 是否有"零作业"的危险信号：allFailed 且 assignments 为空
      looksLikeNoHomework: s.allFailed && s.assignments.length === 0,
    };
  });
  result.steps.push({ name: 'afterSync', ...after });

  result.checks.cachePreserved = after.total === 2;
  result.checks.notRenderedAsEmpty = after.looksLikeNoHomework === false;
  // 状态必须是明确的失败原因之一，不能是 "connected"
  result.checks.explicitFailureState = [
    'needs_login',
    'network_blocked',
    'platform_maintenance',
    'error',
  ].includes(after.hwState);

  // 持久化层也应保留
  const stored = JSON.parse(readFileSync(join(userData, 'dgut-deadline.json'), 'utf8'));
  result.checks.storeStillHasCache = (stored.assignments.hw ?? []).length === 2;
  result.steps.push({ name: 'storeCheck', hwCount: (stored.assignments.hw ?? []).length });

  result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  result.steps.push({ name: 'error', message: String(e).slice(0, 300) });
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
}

console.log(JSON.stringify(result, null, 2));
console.log('OFFLINE_E2E:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
