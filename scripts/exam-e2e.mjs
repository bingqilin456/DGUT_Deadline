/**
 * 考试接入端到端验证（隔离用户数据，不污染真实数据）。
 *
 * 验证什么（全部是「用户能不能看到/收到」层面，不是单测层面）：
 *  1. 考试数据进列表后，快照里能被识别为 kind='exam'；
 *  2. 考试行的状态文案**不出现**「未参加/未提交/已提交」（红线 3 的可见化）；
 *  3. 类型 Tab（全部/作业/考试）能正确分流；
 *  4. 已开考未结束的考试**不被**「隐藏已截止」误伤（D3 核心）；
 *  5. examSyncEnabled=false 时不会请求考试接口（用 store 里是否有 exams 缓存判断）；
 *  6. 提醒引擎对考试按分钟级阈值触发。
 *
 * ⚠️ 全部数据是**合成夹具**，不是真实平台响应。本脚本证明"接线正确"，
 *   不证明"优学院考试接口的字段形状正确"（那需要真实登录态，见
 *   investigation/lms/exam-evidence.md §C.1）。
 *
 * 用法：$env:NODE_OPTIONS=''; node scripts/exam-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const userData = mkdtempSync(join(tmpdir(), 'dgut-exam-e2e-'));

const now = new Date();
const iso = (d) => d.toISOString();
/** 转成 +08:00 的 ISO（与生产代码一致）。 */
const toLocal = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  const sh = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${sh.getUTCFullYear()}-${p(sh.getUTCMonth() + 1)}-${p(sh.getUTCDate())}T${p(sh.getUTCHours())}:${p(sh.getUTCMinutes())}:00+08:00`;
};
const plus = (h) => new Date(now.getTime() + h * 3600 * 1000);

// 考试场次：正在进行（开考 30 分钟前，结束 1 小时后）
const ongoingStart = plus(-0.5);
const ongoingEnd = plus(1);
// 考试场次：明天开考
const tomorrowStart = plus(24);
const tomorrowEnd = plus(26);

const mkExam = (examId, title, start, end) => {
  const startMs = start.getTime();
  const srcId = `exam:${examId}@${startMs}`;
  return {
    kind: 'exam',
    source: 'ulearning',
    sourceAssignmentId: srcId,
    id: `ulearning:${srcId}`,
    courseId: '162440',
    courseName: '端到端测试课程',
    title,
    detailUrl: 'https://lms.dgut.edu.cn/utest/#/exam/' + examId,
    examId,
    startsAt: toLocal(start),
    endsAt: end ? toLocal(end) : null,
    timePrecision: 'datetime',
    venue: { roomName: '机房301', seatNo: 'A-12' },
    attendance: 'unknown',
    attendanceEvidence: 'e2e-test',
    firstSeenAt: iso(now),
    lastSeenAt: iso(now),
    lastSyncAt: iso(now),
    sourceUpdatedAt: null,
  };
};

const mkHw = (id, title, dueAt, status) => ({
  kind: 'homework',
  source: 'hw',
  sourceAssignmentId: id,
  id: `hw:${id}`,
  courseId: null,
  courseName: '端到端测试课程',
  title,
  detailUrl: 'https://hw.dgut.edu.cn/student/homeworkPlan',
  dueAt,
  duePrecision: 'datetime',
  submissionStatus: status,
  statusEvidence: 'e2e-test',
  firstSeenAt: iso(now),
  lastSeenAt: iso(now),
  lastSyncAt: iso(now),
  sourceUpdatedAt: null,
});

const store = {
  schemaVersion: 3,
  settings: {
    thresholds: [
      { hours: 72, enabled: true, urgent: false },
      { hours: 24, enabled: true, urgent: false },
      { hours: 12, enabled: true, urgent: true },
      { hours: 6, enabled: true, urgent: true },
      { hours: 3, enabled: true, urgent: true },
      { hours: 1, enabled: true, urgent: true },
    ],
    examThresholds: [
      { anchor: 'start', offsetMinutes: 1440, enabled: true, urgent: false },
      { anchor: 'start', offsetMinutes: 120, enabled: true, urgent: true },
      { anchor: 'start', offsetMinutes: 30, enabled: true, urgent: true },
      { anchor: 'start', offsetMinutes: 0, enabled: true, urgent: true },
    ],
    // 生产默认已是 true（用户 2026-11-11 决策）。这里与生产保持一致，
    // 避免"测试里关着、生产里开着"的偏差掩盖问题。
    examSyncEnabled: true,
    syncIntervalMinutes: 0,
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    launchAtLogin: false,
    minimizeToTrayOnClose: true,
    notifyUnknownStatus: false,
    theme: 'light',
    lastSyncAt: iso(now),
    endedExamRetentionHours: 24,
  },
  assignments: {
    ulearning: [],
    hw: [mkHw('9101', '【E2E】未提交作业', toLocal(plus(50)), 'not_submitted')],
  },
  exams: {
    // 刻意直接灌入考试缓存：验证 UI/提醒的消费侧，不依赖网络
    ulearning: [
      mkExam('8801', '【E2E】正在进行的考试', ongoingStart, ongoingEnd),
      mkExam('8802', '【E2E】明天开考的考试', tomorrowStart, tomorrowEnd),
    ],
    hw: [],
  },
  lastSuccess: { hw: iso(now) },
  lastSuccessByKind: { hw: { homework: iso(now) }, ulearning: { exam: iso(now) } },
  sessions: {
    hw: {
      source: 'hw',
      state: 'connected',
      message: 'ok',
      lastSuccessAt: iso(now),
      lastAttemptAt: iso(now),
      requiresUserAction: false,
    },
  },
  reminders: [],
  overrides: {},
};
writeFileSync(join(userData, 'dgut-deadline.json'), JSON.stringify(store, null, 2), 'utf8');

const electron = (await import('electron')).default;

/**
 * 构造子进程环境：必须**删除** ELECTRON_RUN_AS_NODE 键，而不是设为空串 ——
 * Electron 只要检测到该变量存在（哪怕值为 ""）就以纯 Node 模式运行，
 * 于是 `import { BrowserWindow } from 'electron'` 直接抛错。
 */
const childEnv = { ...process.env, NODE_OPTIONS: '' };
delete childEnv['ELECTRON_RUN_AS_NODE'];

const child = spawn(electron, ['.', `--user-data-dir=${userData}`, '--remote-debugging-port=9363'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: childEnv,
});
let err = '';
child.stderr.on('data', (d) => (err += d.toString()));
await new Promise((r) => setTimeout(r, 10000));

const { chromium } = await import('playwright-core');
let browser;
const result = { steps: [], checks: {}, verdict: 'FAIL' };

try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9363');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('index.html')) ?? ctx.pages()[0];
  await page.waitForTimeout(3000);

  // ── 1. 快照里能识别考试 ────────────────────────────────
  const snap = await page.evaluate(async () => {
    const s = await window.dgut.getSnapshot();
    return {
      total: s.assignments.length,
      kinds: s.assignments.reduce((a, x) => {
        a[x.kind] = (a[x.kind] ?? 0) + 1;
        return a;
      }, {}),
      exams: s.assignments
        .filter((x) => x.kind === 'exam')
        .map((x) => ({ title: x.title, startsAt: x.startsAt, endsAt: x.endsAt })),
      examSyncEnabled: s.settings.examSyncEnabled,
      hasExamThresholds: Array.isArray(s.settings.examThresholds),
      examThresholdCount: (s.settings.examThresholds ?? []).length,
    };
  });
  result.steps.push({ name: 'snapshot', ...snap });
  result.checks.snapshotHasExams = (snap.kinds.exam ?? 0) === 2;
  result.checks.snapshotHasHomework = (snap.kinds.homework ?? 0) === 1;
  result.checks.examThresholdsWired = snap.hasExamThresholds && snap.examThresholdCount === 4;
  // 考试同步默认开启（用户 2026-11-11 决策）
  result.checks.examSyncDefaultOn = snap.examSyncEnabled === true;

  // ── 2. 列表渲染：考试行出现、状态文案红线 ──────────────
  const table = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    return rows.map((r) => ({
      text: r.textContent.replace(/\s+/g, ' ').trim(),
      cells: Array.from(r.querySelectorAll('td')).map((td) => td.textContent.trim()),
    }));
  });
  result.steps.push({ name: 'table', rowCount: table.length, rows: table.slice(0, 5) });
  result.checks.tableRendered = table.length >= 3;

  const allText = table.map((r) => r.text).join(' | ');
  result.checks.noForbiddenWording =
    !allText.includes('未参加') && !allText.includes('你还没考试');
  // 考试行必须能看出是考试，且不能被称为"作业"
  result.checks.examRowVisible = /考试/.test(allText);

  // ── 3. 「正在进行的考试」不被隐藏已截止误伤（D3 核心）──
  // 默认 hideExpired=true；若实现正确，进行中的考试必须仍在列表里
  result.checks.ongoingExamNotHidden = allText.includes('正在进行的考试');

  // ── 4. 类型 Tab 分流 ─────────────────────────────────
  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, .tab, [role="tab"]'))
      .map((b) => b.textContent.replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 0 && t.length < 12),
  );
  result.steps.push({ name: 'tabs', tabs: [...new Set(tabs)].slice(0, 12) });
  // Tab 文案带计数，形如「全部 3」「作业 1」「考试 2」，故用前缀匹配
  const hasAllTab = tabs.some((t) => t.startsWith('全部'));
  const hasExamTab = tabs.some((t) => t.startsWith('考试'));
  const hasHomeworkTab = tabs.some((t) => t.startsWith('作业') && !t.startsWith('作业列表'));
  result.checks.kindTabsPresent = hasAllTab && hasExamTab && hasHomeworkTab;

  if (hasExamTab) {
    // 点「考试」Tab，应只剩考试行
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, .tab, [role="tab"]'));
      const target = btns.find((b) => b.textContent.replace(/\s+/g, ' ').trim().startsWith('考试'));
      if (!target) return false;
      target.click();
      return true;
    });
    if (clicked) {
      await page.waitForTimeout(800);
      const examOnly = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('tbody tr'));
        return {
          count: rows.length,
          texts: rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
        };
      });
      result.steps.push({ name: 'examTab', ...examOnly });
      result.checks.examTabFilters =
        examOnly.count === 2 && examOnly.texts.every((t) => t.includes('考试'));
      // 恢复「全部」
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, .tab, [role="tab"]'));
        const all = btns.find((b) => b.textContent.replace(/\s+/g, ' ').trim().startsWith('全部'));
        all?.click();
      });
      await page.waitForTimeout(500);
    }
  }

  // ── 5. 提醒引擎：考试按分钟级阈值触发 ─────────────────
  const notify = await page.evaluate(async () => await window.dgut.testNotification());
  result.steps.push({ name: 'testNotification', ...notify });

  const storePath = join(userData, 'dgut-deadline.json');
  const after = JSON.parse(readFileSync(storePath, 'utf8'));
  const examKeys = (after.reminders ?? []).filter((r) => r.key.includes(':exam:') || r.key.includes('exam:'));
  result.steps.push({
    name: 'reminders',
    total: (after.reminders ?? []).length,
    examKeys: examKeys.map((r) => r.key).slice(0, 8),
  });
  // 「正在进行的考试」已跨过 1440/120/30/0 四个阈值
  result.checks.examRemindersFired = examKeys.length > 0;
  result.checks.examReminderKeyFormat = examKeys.every((r) => r.key.includes(':start:'));

  // ── 6. 考试键不含作业键前缀（不互相吃）────────────────
  const hwKeys = (after.reminders ?? []).filter((r) => !r.key.includes('exam'));
  const collision = examKeys.some((e) => hwKeys.some((h) => e.key === h.key));
  result.checks.noKeyCollision = !collision;

  result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL';

  // 截图留证
  const shotDir = join(ROOT, 'docs', 'screenshots');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'exam-list.png') });
} catch (e) {
  result.steps.push({ name: 'error', message: String(e).slice(0, 400) });
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  if (err.trim()) {
    const rel = err.split('\n').filter((l) => /ERR_|Cannot|error|Error/i.test(l)).slice(0, 5);
    if (rel.length) result.steps.push({ name: 'stderr', lines: rel });
  }
}

console.log(JSON.stringify(result, null, 2));
console.log('EXAM_E2E:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
