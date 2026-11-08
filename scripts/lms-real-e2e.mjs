/**
 * LMS 真实数据端到端验证。
 *
 * 使用应用已登录的 LMS profile，直接调用适配器读取真实作业。
 * 这是"优学院是否真的接通"的最终判据。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXE = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'dgut-deadline', '莞工Deadline.exe');
if (!existsSync(EXE)) {
  console.log('FAIL: 未安装');
  process.exit(1);
}
mkdirSync(join(ROOT, 'docs', 'screenshots'), { recursive: true });

const result = { checks: {}, assignments: [], verdict: 'FAIL' };

// 用真实用户数据（不隔离），以复用已登录的 LMS profile
const child = spawn(EXE, ['--remote-debugging-port=9380'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '' },
});
let err = '';
child.stderr.on('data', (d) => (err += d.toString()));
await new Promise((r) => setTimeout(r, 11000));

const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9380');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(3000);

  // 触发完整同步
  const snap = await page.evaluate(async () => {
    const s = await window.dgut.syncNow();
    return {
      sources: s.sources.map((x) => ({
        source: x.source,
        state: x.session?.state,
        count: x.count,
        msg: (x.session?.message ?? '').slice(0, 120),
      })),
      total: s.assignments.length,
      lmsAssignments: s.assignments
        .filter((a) => a.source === 'ulearning')
        .slice(0, 30)
        .map((a) => ({
          title: a.title,
          course: a.courseName,
          due: a.dueAt,
          status: a.submissionStatus,
          evidence: a.statusEvidence,
        })),
    };
  });

  result.lms = snap.sources.find((s) => s.source === 'ulearning');
  result.hw = snap.sources.find((s) => s.source === 'hw');
  result.total = snap.total;
  result.assignments = snap.lmsAssignments;

  result.checks.lmsConnected = result.lms?.state === 'connected';
  result.checks.lmsHasAssignments = (result.lms?.count ?? 0) > 0;
  result.checks.evidencePresent = snap.lmsAssignments.every((a) => a.evidence && a.evidence.length > 0);
  result.checks.dueParsed = snap.lmsAssignments.some((a) => a.due && a.due.includes('+08:00'));
  result.checks.noUnknownStatusFlood =
    snap.lmsAssignments.filter((a) => a.status === 'unknown').length < snap.lmsAssignments.length;

  result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL';

  // 截图作业列表
  await page.locator('.tab', { hasText: '作业列表' }).click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(ROOT, 'docs', 'screenshots', 'lms-real-data.png') });

  writeFileSync(
    join(ROOT, 'docs', 'screenshots', 'lms-real-probe.json'),
    JSON.stringify(result, null, 2),
  );
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

console.log(JSON.stringify(result, null, 2).slice(0, 4000));
console.log('LMS_REAL_E2E:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
