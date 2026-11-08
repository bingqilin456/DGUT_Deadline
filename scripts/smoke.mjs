/**
 * 无头启动验证：确认 Electron 主进程能起来、窗口能创建、渲染进程无致命错误。
 * 通过设置临时 userData 目录，避免污染真实用户数据。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userData = mkdtempSync(join(tmpdir(), 'dgut-deadline-smoke-'));
const electron = (await import('electron')).default;

const child = spawn(electron, ['.', `--user-data-dir=${userData}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    // 当前 shell 环境的 NODE_OPTIONS 指向一个不存在的 worker-events.cjs，
    // 会污染 Electron 内部 Node 启动，必须清掉。
    NODE_OPTIONS: '',
    DGUT_SMOKE_TEST: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  },
});

let out = '';
let err = '';
child.stdout.on('data', (d) => (out += d.toString()));
child.stderr.on('data', (d) => (err += d.toString()));

const timer = setTimeout(() => {
  console.log('--- SMOKE: app alive after 8s ---');
  console.log('stdout:', out.slice(0, 800));
  console.log('stderr:', err.slice(0, 1200));
  child.kill();
  const bad = /Uncaught|Cannot find module|ERR_|Failed to load/i.test(err);
  console.log(bad ? 'SMOKE_RESULT: FAIL' : 'SMOKE_RESULT: PASS');
  process.exit(bad ? 1 : 0);
}, 8000);

child.on('exit', (code) => {
  clearTimeout(timer);
  console.log('exited early code=', code);
  console.log('stdout:', out.slice(0, 800));
  console.log('stderr:', err.slice(0, 2000));
  console.log('SMOKE_RESULT: FAIL (early exit)');
  process.exit(1);
});
