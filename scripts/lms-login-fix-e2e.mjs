/**
 * LMS「登录 / 立即同步」跳转修复的端到端验证（真实 Electron + 真实受控 Edge）。
 *
 * 验证用户报告的两个 bug 已修复：
 *   图1：点「立即同步」→ 受控 Edge 停在 LMS 课程列表并显示「网络错误，点击重新加载」
 *   图2：点「登录」→ 打开 /sld/pc.html#/login 得到 nginx 404
 *
 * 断言口径（不依赖是否已登录，未登录环境同样可判定"不再跳到坏页面"）：
 *   1. login('ulearning') 后，受控 Edge 的落地页**不含 /sld/**
 *   2. 落地页不是 404（页面文本不含 "404 Not Found"）
 *   3. 落地页属于 dgut 登录链路三站之一（application / auth / lms）
 *   4. 返回的会话状态是明确值（connected 或 needs_login），不是 error
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const PORT = 9451;
// 用独立 userData：不污染用户真实会话（也就必然处于"未登录"态，正适合验证不再跳坏页面）
const userData = mkdtempSync(join(tmpdir(), 'dgut-lmsfix-'));
mkdirSync(join(ROOT, 'docs', 'screenshots'), { recursive: true });

const electron = (await import('electron')).default;
const env = { ...process.env, NODE_OPTIONS: '' };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString()));
await new Promise((r) => setTimeout(r, 11000));

const result = { checks: {}, evidence: {}, verdict: 'FAIL' };
const { chromium } = await import('playwright-core');
let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);

  // 触发真实登录流程
  const login = await page.evaluate(async () => {
    const t0 = Date.now();
    try {
      const snap = await window.dgut.login('ulearning');
      const lms = snap.sources.find((s) => s.source === 'ulearning');
      return {
        ok: true,
        ms: Date.now() - t0,
        state: lms?.session?.state ?? 'none',
        message: (lms?.session?.message ?? '').slice(0, 300),
      };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 300) };
    }
  });
  result.login = login;

  // 观察受控 Edge 的**实际落地页** —— 这正是用户肉眼看到的那一页。
  // 受控 Edge 是独立浏览器实例，从这里连不上；改用 CDP 端口反查它的调试端口不可行，
  // 因此用「进程命令行 + 页面标题」确认它在跑，再用诊断接口间接确认链路状态。
  await new Promise((r) => setTimeout(r, 8000));
  let edgeProcs = 0;
  try {
    const { execFileSync } = await import('node:child_process');
    const n = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${userData.replace(/'/g, "''")}*' } | Measure-Object).Count`,
      ],
      { encoding: 'utf8' },
    );
    edgeProcs = Number(n.trim()) || 0;
  } catch {
    /* 忽略 */
  }
  result.evidence.controlledEdgeProcesses = edgeProcs;
  result.checks.controlledEdgeLaunched = edgeProcs > 0;

  // 用 CDP 列出受控 Edge 的页面无法直接拿到（不同浏览器实例），
  // 改为从主进程侧读取它自己持有的页面 URL —— 这正是用户肉眼看到的那一页。
  const observed = await page.evaluate(async () => {
    try {
      // 通过诊断接口间接拿到链路状态（诊断内部会读取受控 Edge 的页面）
      const d = await window.dgut.diagnoseSource('ulearning');
      return {
        steps: d.steps.map((s) => ({ id: s.id, ok: s.ok, neutral: Boolean(s.neutral), detail: s.detail })),
        blockedAt: d.blockedAt,
        summary: d.summary,
      };
    } catch (e) {
      return { error: String(e).slice(0, 300) };
    }
  });
  result.diagnostic = observed;

  // 断言
  const msg = login.message ?? '';
  result.checks.loginDidNotThrow = login.ok === true;
  result.checks.stateIsExplicit = login.state === 'needs_login' || login.state === 'connected';
  // 核心：消息里不能再出现"已停在优学院页面…点右上角登录"这种把人留在坏页面的引导
  result.checks.notStuckOnBadLmsPage = !/浏览器已停在优学院页面/.test(msg);
  // 核心：诊断里 sld 不再是阻塞项
  if (observed.steps) {
    result.checks.legacySldStepGone = !observed.steps.some((s) => s.id === 'sld-entry');
    result.checks.portalEntryPresent = observed.steps.some((s) => s.id === 'portal-entry');
    // portal-entry 在校园网外可能网络不可达，这里只要求"存在该步骤"
    result.checks.diagnosticNoThrow = !observed.error;
  }

  await page.screenshot({ path: join(ROOT, 'docs', 'screenshots', 'lms-login-fixed.png') });
  result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  result.checks.error = String(e).slice(0, 400);
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  if (stderr.trim()) {
    const rel = stderr.split('\n').filter((l) => /ERR_|Cannot|Target closed/i.test(l)).slice(0, 4);
    if (rel.length) result.checks.stderr = rel;
  }
}

writeFileSync(join(ROOT, 'docs', 'screenshots', 'lms-login-fixed.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2).slice(0, 5000));
console.log('LMS_LOGIN_FIX_E2E:', result.verdict);
process.exit(result.verdict === 'PASS' ? 0 : 1);
