/**
 * 真实 store 副本的迁移验证（一次性检查，可作为回归保留）。
 *
 * 用用户机器上**真实**的 dgut-deadline.json 副本验证 v2→v3 迁移，
 * 确认：作业缓存条数不变、全部补上 kind、reminders 不被清、标题不丢。
 *
 * 用户机器上没有该文件时自动跳过（CI / 他人环境）。
 */

import { describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from './app-store.js';

const REAL_STORE = join(process.env['APPDATA'] ?? '', 'dgut-deadline', 'dgut-deadline.json');

describe('真实 store 副本迁移（本机有数据时）', () => {
  const has = existsSync(REAL_STORE);

  it.skipIf(!has)('作业缓存条数不变、kind 补齐、reminders 保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dgut-realcopy-'));
    const copy = join(dir, 'dgut-deadline.json');
    copyFileSync(REAL_STORE, copy);

    const before = JSON.parse(readFileSync(copy, 'utf8'));
    const beforeHw = (before.assignments?.hw ?? []).length;
    const beforeUl = (before.assignments?.ulearning ?? []).length;
    const beforeReminders = (before.reminders ?? []).length;
    const beforeOverrides = Object.keys(before.overrides ?? {}).length;

    const store = new AppStore(dir);

    const hw = store.getAssignments('hw');
    const ul = store.getAssignments('ulearning');

    // 条数一条不少
    expect(hw).toHaveLength(beforeHw);
    expect(ul).toHaveLength(beforeUl);
    // 全部补上判别字段
    expect([...hw, ...ul].every((a) => a.kind === 'homework')).toBe(true);
    // 历史提醒记录不被清（键格式兼容）
    expect(store.getReminders()).toHaveLength(beforeReminders);
    // 用户手动覆盖保留
    expect(Object.keys(store.getOverrides())).toHaveLength(beforeOverrides);
    // 标题等业务字段不被破坏（防乱码/丢字段）
    for (let i = 0; i < ul.length; i++) {
      expect(ul[i]!.title).toBe((before.assignments.ulearning as Array<{ title: string }>)[i]!.title);
    }
    // 考试缓存为空（尚未同步过）
    expect(store.getAllExamItems()).toEqual([]);
    // 新设置项就位
    expect(store.getSettings().examThresholds.length).toBe(4);
    // 真实 store 是 v2（没有 examSyncEnabled 字段），迁移应补成默认的 true
    expect(store.getSettings().examSyncEnabled).toBe(true);
    // 迁移后版本号
    expect(JSON.parse(readFileSync(copy, 'utf8')).schemaVersion).toBe(3);
  });
});
