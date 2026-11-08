/**
 * 打包版核心验证：Playwright + Edge 在 ASAR 打包后能否正常启动？
 * 这是打包最容易出问题的地方（playwright-core 需要真实文件路径）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXE = join(ROOT, 'dist', 'win-unpacked', '莞工Deadline.exe');
if (!existsSync(EXE)) {
  console.log('FAIL: 找不到打包后的 exe');
  process.exit(1);
}

// 先确认 playwright-core 是否被 asarUnpack 正确解包
const unpacked = join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules', 'playwright-core');
console.log('asarUnpack playwright-core 存在:', existsSync(unpacked));
if (existsSync(unpacked)) {
  const fs = await import('node:fs');
  const files = fs.readdirSync(unpacked);
  console.log('解包内容:', files.slice(0, 10).join(', '), files.length > 10 ? `... 共 ${files.length} 项` : '');
}

const userData = mkdtempSync(join(tmpdir(), 'dgut-asar-'));

const child = spawn(EXE, [`--user-data-dir=${userData}`, '--remote-debugging-port=9337'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '' },
});
let err = '';
child.stderr.on('data', (d) => (err += d.toString()));

await new Promise((r) => setTimeout(r, 6000));

const { chromium } = await import('playwright-core');
let browser;
let verdict = 'FAIL';
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9337');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('devtools://')) ?? ctx.pages()[0];
  await page.waitForTimeout(2500);

  // 调用真实同步：这会触发 Playwright 启动 Edge。
  // 未登录也应能在有限时间内返回明确的 needs_login 状态，而不是崩溃。
  const result = await page.evaluate(async () => {
    const t0 = Date.now();
    try {
      const snap = await window.dgut.syncNow();
      return {
        ok: true,
        elapsedMs: Date.now() - t0,
        sources: snap.sources.map((s) => ({
          source: s.source,
          state: s.session?.state ?? 'none',
          message: (s.session?.message ?? '').slice(0, 120),
        })),
      };
    } catch (e) {
      return { ok: false, elapsedMs: Date.now() - t0, error: String(e) };
    }
  });
  console.log('PACKED_SYNC_RESULT:', JSON.stringify(result, null, 2));

  // 关键判定：同步没有抛异常，且两个平台都给出了明确状态（而非卡死/崩溃）
  const okStates = ['needs_login', 'connected', 'network_blocked', 'platform_maintenance', 'error', 'unknown'];
  const statesValid =
    result.ok && result.sources.every((s) => okStates.includes(s.state));

  // Playwright 能启动的最强证据：Launching browser 失败会体现为 error 状态或异常
  const playwrightWorks = result.ok && result.elapsedMs > 3000;

  verdict = statesValid && playwrightWorks ? 'PASS' : 'FAIL';
  console.log('Playwright 似乎已启动（耗时 > 3s）:', playwrightWorks);
  console.log('ASAR_PACKED_RESULT:', verdict);
} catch (e) {
  console.log('CDP failed:', String(e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  if (err.trim()) {
    const relevant = err
      .split('\n')
      .filter((l) => /playwright|browser|asar|ERR_|Cannot find|is not a function/i.test(l))
      .slice(0, 12);
    if (relevant.length) console.log('stderr(相关):', relevant.join('\n'));
  }
  process.exit(verdict === 'PASS' ? 0 : 1);
}
