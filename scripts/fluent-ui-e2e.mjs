/** Source-build UI regression. Isolated profile + explicitly labelled demo IPC fixtures.
 * No school requests, browser credentials, notifications, or installed app involved.
 * Run after npm run build: node scripts/fluent-ui-e2e.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = process.cwd();
const userData = mkdtempSync(join(tmpdir(), 'dgut-fluent-ui-'));
const shots = join(root, 'docs', 'screenshots');
mkdirSync(shots, { recursive: true });
writeFileSync(join(userData, 'dgut-deadline.json'), JSON.stringify({
  schemaVersion: 2,
  settings: { theme: 'dark', syncIntervalMinutes: 0, showDemoData: true,
    launchAtLogin: false, thresholds: [{ hours: 1, enabled: false, urgent: false }] },
}));
const env = { ...process.env, NODE_OPTIONS: '' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: (await import('electron')).default,
  args: [root, `--user-data-dir=${userData}`], env, timeout: 20000 });
const errors = [];
const checks = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.stats');
  assert.equal(await page.locator('.open-link').first().isDisabled(), true, 'real demo links stay disabled');
  const base = await page.evaluate(() => window.dgut.getSnapshot());
  const now = Date.now();
  const iso = (hours) => new Date(now + hours * 3600000).toISOString();
  const fixture = (id, source, title, courseName, hours, submissionStatus) => ({
    ...base.assignments[0], id, source, title: `【演示】${title}`, courseName,
    dueAt: hours === null ? null : iso(hours), duePrecision: hours === null ? 'none' : 'datetime',
    submissionStatus, isDemo: true, detailUrl: 'https://hw.dgut.edu.cn/home',
  });
  const snapshot = { ...base, browserReady: true, demoMode: true, partialFailure: false, allFailed: false,
    assignments: [
      fixture('test-1', 'hw', '2小时后截止：长标题测试作业与实验报告，缩小窗口仍可查看完整内容', '数据库系统原理', 2, 'not_submitted'),
      fixture('test-2', 'hw', '已截止未提交', '数据库系统原理', -5, 'not_submitted'),
      fixture('test-3', 'ulearning', '20小时后截止', 'Python', 20, 'not_submitted'),
      fixture('test-4', 'ulearning', '已提交', 'Python', 50, 'submitted'),
      { ...fixture('test-5', 'hw', '状态待确认', '数学', 120, 'unknown'), duePrecision: 'date' },
      fixture('test-6', 'ulearning', '无截止时间', '数学', null, 'not_submitted'),
    ],
    sources: base.sources.map((s) => ({ ...s, count: 3, stale: s.source === 'ulearning',
      session: { source: s.source, state: s.source === 'hw' ? 'connected' : 'needs_login',
        message: '演示登录状态', requiresUserAction: s.source === 'ulearning' },
    })),
  };
  // Test-only IPC replacements exercise the real preload and template event wiring.
  await app.evaluate(({ ipcMain }, snap) => {
    globalThis.uiFixture = snap;
    globalThis.uiCalls = [];
    const replace = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, fn); };
    replace('app:getSnapshot', () => globalThis.uiFixture);
    replace('app:syncNow', async () => {
      globalThis.uiCalls.push('sync');
      await new Promise((r) => setTimeout(r, 250));
      return globalThis.uiFixture;
    });
    replace('app:login', (_event, source) => { globalThis.uiCalls.push(`login:${source}`); return globalThis.uiFixture; });
    replace('app:openAssignment', (_event, id) => { globalThis.uiCalls.push(`open:${id}`); return { ok: true }; });
    replace('app:updateSettings', (_event, patch) => {
      globalThis.uiFixture.settings = { ...globalThis.uiFixture.settings, ...patch };
      return globalThis.uiFixture;
    });
    replace('app:diagnoseSource', () => ({ source: 'hw', summary: '演示诊断结果', blockedAt: 'demo',
      generatedAt: new Date().toISOString(), steps: [
        { id: 'demo', label: '演示检查项', detail: '演示结果，不连接平台', ok: false, neutral: true },
      ] }));
  }, snapshot);
  await page.reload();
  const rows = page.locator('.table-wrap tbody tr');
  const count = async (n) => { await rows.first().waitFor({ state: n ? 'visible' : 'hidden' }); assert.equal(await rows.count(), n); };
  const select = (n) => page.locator('.filters select').nth(n);
  const reset = async () => { await page.getByRole('button', { name: '重置筛选' }).click(); await count(5); };
  await count(5);
  assert.match(await rows.first().innerText(), /2小时/);
  await select(0).selectOption('hw'); await count(2); await reset();
  await select(1).selectOption('Python'); await count(2); await reset();
  await select(2).selectOption('overdue'); await count(1);
  assert.equal(await page.locator('.filters input[type=checkbox]').isChecked(), false); await reset();
  await select(3).selectOption('24h'); await count(2); await reset();
  await select(4).selectOption('submitted'); await count(1); await reset();
  await select(5).selectOption('dueDesc');
  // Existing descending sort puts unknown deadlines first; preserve that behavior.
  assert.match(await rows.first().innerText(), /无截止时间/);
  assert.match(await rows.nth(1).innerText(), /状态待确认/); await reset();
  await page.locator('.filters input[type=text]').fill('20小时'); await count(1); await reset();
  await page.locator('.filters input[type=checkbox]').uncheck(); await count(6);
  await page.locator('.filters input[type=text]').fill('不存在的作业');
  await page.getByText('当前筛选条件下没有作业').waitFor(); await reset();
  checks.push('search, all filters, sorting, reset, empty filter state');

  await rows.first().getByRole('button', { name: '打开', exact: true }).click();
  await page.locator('.chip').filter({ hasText: '优学院' }).getByRole('button', { name: '登录', exact: true }).click();
  const sync = page.getByRole('button', { name: '立即同步', exact: true });
  await sync.click();
  assert.equal(await page.getByRole('button', { name: '同步中…' }).isDisabled(), true);
  await sync.waitFor();
  const calls = await app.evaluate(() => globalThis.uiCalls);
  assert.deepEqual(calls, ['open:test-1', 'login:ulearning', 'sync']);
  checks.push('open, login, sync and busy state through real preload');

  for (const theme of ['dark', 'light', 'system']) {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.settings select').selectOption(theme);
    for (const scheme of theme === 'system' ? ['dark', 'light'] : [theme]) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const actual = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.equal(actual, scheme === 'dark' ? 'rgb(32, 32, 32)' : 'rgb(243, 243, 243)');
    }
  }
  await page.getByRole('button', { name: '作业列表', exact: true }).click();
  await page.screenshot({ path: join(shots, 'fluent-light.png') });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.settings select').selectOption('dark');
  await page.screenshot({ path: join(shots, 'fluent-settings.png') });
  await page.getByRole('button', { name: '作业列表', exact: true }).click();
  checks.push('dark, light, system themes and settings navigation');

  for (const [width, height] of [[1180, 780], [900, 600], [720, 540], [590, 480]]) {
    await page.setViewportSize({ width, height });
    const probe = await page.evaluate(() => {
      const content = document.querySelector('.content');
      const title = document.querySelector('.title-cell');
      const elements = [...document.querySelectorAll('.filters input, .filters select, .filters button, .topbar button, .chip button')];
      return { overflow: content.scrollWidth > content.clientWidth + 1,
        docOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        titleWidth: title.getBoundingClientRect().width,
        badControls: elements.filter((el) => {
          const b = el.getBoundingClientRect(); return b.left < -1 || b.right > innerWidth + 1 || b.width < 15;
        }).map((el) => ({ name: el.outerHTML.slice(0, 100), x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width })),
        badgesFit: [...document.querySelectorAll('.assignment-table .badge')].every((el) => {
          const b = el.getBoundingClientRect(), td = el.closest('td').getBoundingClientRect();
          return b.right <= td.right + 1;
        }),
      };
    });
    await page.screenshot({ path: join(shots, `fluent-${width}.png`) });
    assert.equal(probe.overflow || probe.docOverflow, false, `page overflow at ${width}`);
    assert.deepEqual(probe.badControls, [], `control overflow at ${width}`);
    assert.ok(probe.titleWidth >= 180, `assignment column squeezed at ${width}: ${probe.titleWidth}`);
    assert.equal(probe.badgesFit, true, `badge overflow at ${width}`);
    if (width === 900) {
      const region = page.getByRole('region', { name: '作业列表，可横向滚动查看所有列' });
      await region.focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('.assignment-scroll').scrollLeft > 0);
      await rows.first().getByRole('button', { name: '打开', exact: true }).focus();
      const actionFits = await page.evaluate(() => {
        const action = document.activeElement.getBoundingClientRect();
        const region = document.querySelector('.assignment-scroll').getBoundingClientRect();
        return action.left >= region.left && action.right <= region.right;
      });
      assert.equal(actionFits, true, 'keyboard focus reveals the action in the narrow table');
      await page.screenshot({ path: join(shots, 'fluent-900-table.png') });
      await page.evaluate(() => { document.querySelector('.content').scrollTop = 0; document.querySelector('.assignment-scroll').scrollLeft = 0; });
    }
  }
  checks.push('1180/900/720/590 widths: containment, readable title, controls, badges and keyboard table scroll');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '诊断莞工作业平台', exact: true }).click();
  await page.getByText('演示诊断结果', { exact: true }).waitFor();
  for (const width of [900, 590]) {
    await page.setViewportSize({ width, height: 600 });
    const settingsFit = await page.evaluate(() => {
      const content = document.querySelector('.content');
      return content.scrollWidth <= content.clientWidth + 1 &&
        [...document.querySelectorAll('.settings .badge')].every((el) => el.scrollWidth <= el.clientWidth + 1);
    });
    assert.equal(settingsFit, true, `settings / diagnosis overflow at ${width}`);
  }
  checks.push('narrow settings and diagnosis labels');
  // Cached-failure and no-data warnings must survive the visual redesign.
  await app.evaluate(() => {
    globalThis.uiFixture = { ...globalThis.uiFixture, demoMode: false, allFailed: true, partialFailure: false,
      sources: globalThis.uiFixture.sources.map((s) => ({ ...s, stale: true,
        session: { ...s.session, state: 'error' } })) };
  });
  await page.reload(); await count(5);
  await page.getByText('所有平台同步失败。下方显示的是上次缓存的数据，可能已过期。').waitFor();
  await app.evaluate(() => { globalThis.uiFixture.assignments = []; });
  await page.reload();
  await page.getByText('暂无作业数据', { exact: true }).waitFor();
  await page.getByText('所有平台同步失败。下方显示的是上次缓存的数据，可能已过期。').waitFor();
  checks.push('cache preserved on failure; failure distinct from no data');
  assert.deepEqual(errors, [], 'renderer errors');
  console.log(JSON.stringify({ verdict: 'PASS', checks }, null, 2));
} finally {
  await app.close();
}
