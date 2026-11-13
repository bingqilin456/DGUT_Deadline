/**
 * LMS 诊断模块单测。
 *
 * 保护 2026-11-11 修复的口径：
 *  · 优学院旧登录页 /sld/pc.html 已永久 404 → 不再是"阻塞项"，也不该再当作唯一登录入口；
 *  · 「网络错误，点击重新加载」= token 失效（不是断网），诊断必须能解释这一点；
 *  · token 要经官方 isValidToken 校验有效性，不能只看 cookie 存在。
 *
 * 这里只测纯逻辑（步骤 → 结论）与探测函数在无浏览器时的降级行为，
 * 不启动真实浏览器（真实链路由 scripts/diag-e2e.mjs 覆盖）。
 */

import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  buildLmsDiagnosticSummary,
  diagnoseLms,
  NETWORK_ERROR_HINT,
  SLD_LEGACY_PATH,
  type LmsDiagnosticStep,
} from './lms-diagnostic.js';

function step(over: Partial<LmsDiagnosticStep> & Pick<LmsDiagnosticStep, 'id'>): LmsDiagnosticStep {
  return { label: over.id, ok: true, detail: '', ...over };
}

describe('LMS 诊断结论', () => {
  it('全部通过时结论为"正常"', () => {
    const s = buildLmsDiagnosticSummary([
      step({ id: 'portal-entry' }),
      step({ id: 'cas-reachable' }),
      step({ id: 'cas-authorized' }),
      step({ id: 'lms-session' }),
    ]);
    expect(s).toContain('正常');
  });

  it('应用中心不可达时，指向网络/VPN 而不是误导为平台故障', () => {
    const s = buildLmsDiagnosticSummary([
      step({ id: 'portal-entry', ok: false }),
      step({ id: 'cas-reachable', neutral: true }),
    ]);
    expect(s).toContain('校园网');
    // 旧实现会把 /sld/pc.html 404 说成"平台故障"并卡在这里；新口径不该再出现这种误导
    expect(s).not.toContain('平台故障');
  });

  it('token 存在但失效时，明确说是"登录失效"而非断网', () => {
    const s = buildLmsDiagnosticSummary(
      [
        step({ id: 'portal-entry' }),
        step({ id: 'cas-authorized', ok: false }),
        step({ id: 'lms-session', ok: false }),
      ],
      { tokenPresent: true, tokenValid: false },
    );
    expect(s).toContain('失效');
    expect(s).toMatch(/不是断网/);
  });

  it('未登录（从未签发 token）时，引导去点「登录」', () => {
    const s = buildLmsDiagnosticSummary(
      [
        step({ id: 'portal-entry' }),
        step({ id: 'cas-authorized', ok: false }),
      ],
      { tokenPresent: false },
    );
    expect(s).toContain('登录');
    expect(s).not.toContain('不是断网');
  });

  it('会话不被认可时，引导重走「应用中心 → 优学院」', () => {
    const s = buildLmsDiagnosticSummary([
      step({ id: 'portal-entry' }),
      step({ id: 'cas-authorized' }),
      step({ id: 'lms-session', ok: false }),
    ]);
    expect(s).toContain('应用中心');
  });
});

describe('LMS 诊断口径常量', () => {
  it('旧登录页路径被明确标记为 legacy（用于向用户解释为什么不用它）', () => {
    expect(SLD_LEGACY_PATH).toBe('/sld/pc.html');
  });

  it('「网络错误」提示明确说明这是登录失效而不是断网', () => {
    expect(NETWORK_ERROR_HINT).toMatch(/不是断网/);
  });
});

describe('diagnoseLms 在无浏览器时的降级行为', () => {
  it('页面对象不可用时仍返回结构化步骤，而不是抛错', async () => {
    // 模拟"浏览器上下文不可用"：所有 evaluate/cookies 都抛错
    const brokenPage = {
      url: () => {
        throw new Error('Target closed');
      },
      goto: async () => {
        throw new Error('Target closed');
      },
      evaluate: async () => {
        throw new Error('Target closed');
      },
      context: () => ({
        cookies: async () => {
          throw new Error('Target closed');
        },
      }),
    } as unknown as Page;

    const d = await diagnoseLms(brokenPage);
    expect(Array.isArray(d.steps)).toBe(true);
    expect(d.steps.length).toBeGreaterThanOrEqual(4);
    expect(typeof d.summary).toBe('string');
    expect(d.summary.length).toBeGreaterThan(10);
  });
});
