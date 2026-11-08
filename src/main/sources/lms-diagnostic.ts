/**
 * LMS 登录链路诊断。
 *
 * 逐段检查 DGUT 的三段 SSO 链路，精确报告"卡在哪一步"，
 * 而不是笼统地说"未登录"。这是本应用能提供的最有用的排查信息。
 *
 * 注意：只读取 cookie 的**存在性与长度**，绝不读取/记录其值。
 */

import type { Page } from 'playwright-core';

export interface LmsDiagnosticStep {
  /** 步骤标识 */
  id: 'sld-entry' | 'cas-reachable' | 'cas-authorized' | 'lms-session' | 'lms-api';
  /** 中文描述 */
  label: string;
  ok: boolean;
  /** 中性状态：既非通过也非故障（例如"尚未点过登录"），不计入阻塞 */
  neutral?: boolean;
  /** 实测细节（不含凭证） */
  detail: string;
}

export interface LmsDiagnostic {
  steps: LmsDiagnosticStep[];
  /** 卡住的第一步；全部通过则为 null */
  blockedAt: string | null;
  /** 面向用户的结论 */
  summary: string;
}

const LMS = 'https://lms.dgut.edu.cn';
const CAS_APP =
  'https://auth.dgut.edu.cn/authserver/login?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas';

/** 执行一次完整诊断。只读，不修改任何状态。 */
export async function diagnoseLms(page: Page): Promise<LmsDiagnostic> {
  const steps: LmsDiagnosticStep[] = [];

  // 【关键】诊断前必须确保页面处在 LMS 源下。
  // 否则页面还是 about:blank，所有相对路径 fetch 都会失败（返回 status 0），
  // 导致诊断结果全是"异常"，误导用户。
  await ensureOnLms(page);

  // 【关键】诊断前必须确保页面处在 LMS 源下。
  // 否则页面还是 about:blank，所有相对路径 fetch 都会失败（返回 status 0），
  // 导致诊断结果全是"异常"，误导用户。
  await ensureOnLms(page);

  // 一次性读取全部 cookie（后续多处使用）
  const cookies0 = await page.context().cookies();

  // ① 平台自身登录入口是否可用（实测 404 是平台故障）
  //     这是同源请求（lms 域请求 lms 自身路径），不受 CORS 影响
  const sld = await probeHttp(page, `${LMS}/sld/pc.html`);
  steps.push({
    id: 'sld-entry',
    label: '优学院自身登录入口（/sld/pc.html）',
    ok: sld.ok,
    detail: sld.ok
      ? `HTTP ${sld.status}`
      : sld.status === 0
        ? '请求未发出（页面不在 LMS 域）'
        : `HTTP ${sld.status} —— 该地址已失效，需经中央认证接入`,
  });

  // ② 中央认证是否可达
  //    注意：不能从 lms 域 fetch auth.dgut.edu.cn（跨域会被 CORS 拦，得到 status 0，
  //    会造成"中央认证不可达"的误判）。
  //    这里判断的是"是否已经接触过中央认证"：
  //      - 已停在 CAS/门户域，或持有 CASTGC  => 已走通
  //      - 尚未访问 => 中性状态（不是故障，用户还没点登录而已）
  const cur = safePageUrl(page);
  const onAuthDomain = cur.includes('auth.dgut.edu.cn') || cur.includes('application.dgut.edu.cn');
  const castgc = cookies0.find((c) => c.name === 'CASTGC');
  const visitedCas = onAuthDomain || Boolean(castgc?.value);
  steps.push({
    id: 'cas-reachable',
    label: '莞工中央认证（auth.dgut.edu.cn）',
    // 未访问时标为 neutral（不算故障），避免误导用户
    ok: true,
    neutral: !visitedCas,
    detail: onAuthDomain
      ? '当前页面已在中央认证/应用中心域'
      : castgc?.value
        ? '已持有 CAS 票据（CASTGC）'
        : '尚未访问（点击「登录」后会自动打开）',
  });

  // ③ CAS 是否已完成认证（检查 .dgut.edu.cn 域的 AUTHORIZATION 是否存在）
  const auth = cookies0.find((c) => c.name === 'AUTHORIZATION');
  const tok = cookies0.find((c) => c.name === 'token');
  steps.push({
    id: 'cas-authorized',
    label: '中央认证授权票据（AUTHORIZATION / token）',
    ok: Boolean(auth?.value),
    detail: auth?.value
      ? `已签发（AUTHORIZATION ${auth.value.length} 位；token ${tok?.value ? '有' : '无'}）`
      : '未签发 —— 需在弹出窗口完成登录（含验证码/短信验证）',
  });

  // ④ LMS 是否认可该会话（用真实 API 判断，不依赖 document.cookie）
  const api = await probeLmsApi(page);
  steps.push({
    id: 'lms-session',
    label: '优学院会话校验（/courseapi/users/0）',
    ok: api.ok,
    detail: api.detail,
  });

  // ⑤ 作业接口是否可用
  steps.push({
    id: 'lms-api',
    label: '优学院作业接口',
    ok: false,
    detail: '尚未真机验证（作业位于独立子系统 homework.dgut.edu.cn，当前对外 404）',
  });

  const firstBad = steps.find((s) => !s.ok && !s.neutral);
  return {
    steps,
    blockedAt: firstBad?.id ?? null,
    summary: buildSummary(steps, firstBad),
  };
}

function buildSummary(steps: LmsDiagnosticStep[], firstBad?: LmsDiagnosticStep): string {
  if (!firstBad) return '优学院链路全部正常。';

  switch (firstBad.id) {
    case 'sld-entry':
      return (
        '优学院自身登录页返回 404（平台故障，非本应用问题）。' +
        '本应用已自动改用「中央认证 → 应用中心 → 带 token 跳转」的路径，请继续完成中央认证。'
      );
    case 'cas-reachable':
      return '无法访问莞工中央认证，请确认已连接校园网或学校 VPN。';
    case 'cas-authorized':
      return '尚未完成中央认证。请在已弹出的浏览器窗口登录（需验证码；新设备还需短信验证）。';
    case 'lms-session':
      return (
        '中央认证已通过，但优学院未认可该会话（缺少 token）。' +
        '这属于学校 SSO 配置问题，建议向现代教育技术中心反馈；应用内「诊断」页可导出说明。'
      );
    default:
      return '优学院作业接口尚未验证。';
  }
}

/** 安全读取页面 URL。 */
function safePageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

/**
 * 确保页面处在 LMS 源下（诊断用）。
 * 只在页面既不在 LMS 也不在 CAS/门户时导航，避免打断用户正在进行的登录。
 */
async function ensureOnLms(page: Page): Promise<void> {
  let cur = '';
  try {
    cur = page.url();
  } catch {
    cur = '';
  }
  if (cur.includes('lms.dgut.edu.cn')) return;
  if (cur.includes('auth.dgut.edu.cn') || cur.includes('application.dgut.edu.cn')) return;
  try {
    await page.goto(`${LMS}/courseweb/ulearning/index.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await new Promise((r) => setTimeout(r, 2000));
  } catch {
    // 导航失败交由后续探测反映
  }
}

async function probeHttp(
  page: Page,
  url: string,
): Promise<{ ok: boolean; status: number }> {
  try {
    const r = await page.evaluate(async (u: string) => {
      try {
        const res = await fetch(u, { method: 'GET', credentials: 'include', redirect: 'follow' });
        return { status: res.status };
      } catch (e) {
        return { status: 0, err: String(e).slice(0, 80) };
      }
    }, url);
    return { ok: r.status > 0 && r.status < 400, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function probeLmsApi(page: Page): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await page.evaluate(async () => {
      try {
        const res = await fetch('/courseapi/users/0?lang=zh', {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        const t = await res.text();
        return { status: res.status, code: /"code"\s*:\s*(\d+)/.exec(t)?.[1] ?? '', len: t.length };
      } catch {
        return { status: 0, code: '', len: 0 };
      }
    });
    if (r.status === 200 && r.len > 2 && r.code !== '2001') {
      return { ok: true, detail: `HTTP 200，已登录` };
    }
    return {
      ok: false,
      detail: `HTTP ${r.status}${r.code ? `，业务码 ${r.code}` : ''}（未登录或 token 缺失）`,
    };
  } catch {
    return { ok: false, detail: '请求失败' };
  }
}
