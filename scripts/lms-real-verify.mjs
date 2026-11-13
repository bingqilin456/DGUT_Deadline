/**
 * LMS 真实会话只读验证（复用**用户真实 profile**，不做任何登录动作）。
 *
 * 用途：用户已在受控 Edge 里手工完成中央认证后，证明「登录 → 读作业」链路真的通了。
 *
 * 严格只读：只发 GET；不提交任何表单；不读取/不打印/不落盘任何 cookie 或 token 值。
 * 只输出「会话状态 + 作业条目 + 字段解析结论」。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PORT = 9461;
// 复用真实用户数据（不隔离），以命中已登录的 LMS profile
const REAL_USERDATA = join(process.env['APPDATA'] ?? '', 'dgut-deadline');
mkdirSync(join(ROOT, 'docs', 'screenshots'), { recursive: true });

const electron = (await import('electron')).default;
const env = { ...process.env, NODE_OPTIONS: '' };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electron,
  ['.', `--user-data-dir=${REAL_USERDATA}`, `--remote-debugging-port=${PORT}`],
  { stdio: ['ignore', 'pipe', 'pipe'], env },
);
let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString()));
await new Promise((r) => setTimeout(r, 11000));

const result = { checks: {}, verdict: 'FAIL', sample: [] };
const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);

  // 1) 只读诊断：判断当前会话是否真的有效
  const diag = await page.evaluate(async () => {
    const d = await window.dgut.diagnoseSource('ulearning');
    return { steps: d.steps, blockedAt: d.blockedAt, summary: d.summary };
  });
  result.diagnostic = diag;

  const authed = diag.steps.find((s) => s.id === 'cas-authorized');
  const session = diag.steps.find((s) => s.id === 'lms-session');
  result.checks.sessionValid = Boolean(authed?.ok) && Boolean(session?.ok);
  result.checks.noBlockingStep = diag.blockedAt === null;

  // 2) 只有会话有效才同步（避免未登录时白跑一轮网络请求）
  if (result.checks.sessionValid) {
    const snap = await page.evaluate(async () => {
      const s = await window.dgut.syncNow();
      const lms = s.sources.find((x) => x.source === 'ulearning');
      return {
        lmsState: lms?.session?.state,
        lmsCount: lms?.count,
        lmsMsg: (lms?.session?.message ?? '').slice(0, 200),
        items: s.assignments
          .filter((a) => a.source === 'ulearning')
          .slice(0, 8)
          .map((a) => ({
            title: a.title,
            course: a.courseName,
            due: a.dueAt,
            status: a.submissionStatus,
            evidence: a.statusEvidence,
            kind: a.kind,
          })),
      };
    });
    result.sync = {
      lmsState: snap.lmsState,
      lmsCount: snap.lmsCount,
      lmsMsg: snap.lmsMsg,
    };
    result.sample = snap.items;
    result.checks.syncConnected = snap.lmsState === 'connected';
    result.checks.hasAssignments = (snap.lmsCount ?? 0) > 0;
    result.checks.evidencePresent = snap.items.every((a) => a.evidence && a.evidence.length > 0);
    result.checks.dueParsed = snap.items.some((a) => a.due && a.due.includes('+08:00'));
  }

  await page.screenshot({ path: join(ROOT, 'docs', 'screenshots', 'lms-real-verify.png') });
  result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  result.checks.error = String(e).slice(0, 400);
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  if (stderr.trim()) {
    const rel = stderr.split('\n').filter((l) => /ERR_|Cannot|Target closed/i.test(l)).slice(0, 3);
    if (rel.length) result.checks.stderr = rel;
  }
}

writeFileSync(join(ROOT, 'docs', 'screenshots', 'lms-real-verify.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2).slice(0, 4000));
console.log('LMS_REAL_VERIFY:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
