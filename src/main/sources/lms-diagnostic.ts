/**
 * LMS 登录链路诊断。
 *
 * 逐段检查 DGUT 的四段 SSO 链路，精确报告"卡在哪一步"，
 * 而不是笼统地说"未登录"。这是本应用能提供的最有用的排查信息。
 *
 * 2026-11-11 实测纠正：优学院自身登录页 `/sld/pc.html` **整目录 404**，
 * 它已不是"平台暂时故障"，而是**永久下线**（LMS 自己的失效跳转改指向
 * `/courseweb/ulearning/tip/timeout.html`）。因此这里不再把它当作阻塞项，
 * 改为检查「应用中心入口是否可达」+「token 是否有效」。
 *
 * 注意：只读取 cookie 的**存在性**与官方探活接口的布尔结果，
 * 绝不读取/记录/落盘任何凭证值。
 */

import type { Page } from 'playwright-core';

export interface LmsDiagnosticStep {
  /** 步骤标识 */
  id: 'portal-entry' | 'cas-reachable' | 'cas-authorized' | 'lms-session' | 'lms-api';
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
/** 应用中心（融合门户）：登录的唯一可用入口（实测 200）。 */
const PORTAL = 'https://application.dgut.edu.cn/';

/**
 * 已永久下线的优学院自身登录页（实测 404）。
 * 保留常量是为了在 UI 里向用户解释"为什么不能点平台自带的登录"，
 * 而**不是**把它当成可用入口。
 */
export const SLD_LEGACY_PATH = '/sld/pc.html';
const SLD_LEGACY = `${LMS}${SLD_LEGACY_PATH}`;

/**
 * 「网络错误，点击重新加载」的真实含义。
 *
 * 该文案来自 `courseweb/common/nls/public.js` 的 `netError`，
 * 是 `/courseapi/*` 拿不到有效 token 时渲染的兜底 UI —— **不是断网**。
 * 若把它当断网，用户会去反复检查网络，而真正该做的是重新登录。
 */
export const NETWORK_ERROR_HINT =
  '页面显示「网络错误，点击重新加载」表示优学院登录已失效（token 无效），不是断网，重新登录即可。';

/** 执行一次完整诊断。只读，不修改任何状态。 */
export async function diagnoseLms(page: Page): Promise<LmsDiagnostic> {
  const steps: LmsDiagnosticStep[] = [];

  // 【关键】诊断前必须确保页面处在可探测的源下。
  // 否则页面还是 about:blank，所有相对路径 fetch 都会失败（返回 status 0），
  // 导致诊断结果全是"异常"，误导用户。
  await ensureOnLms(page);

  // 一次性读取全部 cookie（后续多处使用；只读存在性）
  // 【健壮性】浏览器上下文可能已被关闭（用户关掉了受控 Edge、或进程刚崩溃）。
  // 此时读 cookie 会抛 "Target closed"；诊断面板**不能因此整体报错**——
  // 它恰恰是用户排查"为什么连不上"的地方，必须永远返回可读结果。
  const cookies0 = await readCookiesSafely(page);
  const browserAlive = cookies0 !== null;
  const cookies = cookies0 ?? [];

  // ① 应用中心入口是否可用 —— 这才是用户真正该走的登录入口
  const portal = await probeHttp(page, PORTAL);
  const sld = await probeHttp(page, SLD_LEGACY);
  steps.push({
    id: 'portal-entry',
    label: '应用中心登录入口（application.dgut.edu.cn）',
    ok: portal.ok,
    detail: portal.ok
      ? `HTTP ${portal.status} —— 可用` +
        (sld.status === 404 ? '（优学院旧登录页 /sld/pc.html 已 404，勿用）' : '')
      : portal.status === 0
        ? '请求未发出（页面不在可探测域）'
        : `HTTP ${portal.status} —— 应用中心不可达，请确认已连校园网/VPN`,
  });

  // ② 中央认证是否可达
  //    注意：不能从 lms 域 fetch auth.dgut.edu.cn（跨域会被 CORS 拦，得到 status 0，
  //    会造成"中央认证不可达"的误判）。
  //    这里判断的是"是否已经接触过中央认证"：
  //      - 已停在 CAS/门户域，或持有 CASTGC  => 已走通
  //      - 尚未访问 => 中性状态（不是故障，用户还没点登录而已）
  const cur = safePageUrl(page);
  const onAuthDomain = cur.includes('auth.dgut.edu.cn') || cur.includes('application.dgut.edu.cn');
  const castgc = cookies.find((c) => c.name === 'CASTGC');
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

  // ③ CAS 是否已完成认证 + token 是否**有效**（不只看 cookie 存在）
  const auth = cookies.find((c) => c.name === 'AUTHORIZATION');
  const tokenValid = auth?.value ? await probeTokenValid(page, auth.value) : false;
  steps.push({
    id: 'cas-authorized',
    label: '中央认证授权票据（AUTHORIZATION）',
    ok: Boolean(auth?.value) && tokenValid,
    detail: !auth?.value
      ? '未签发 —— 需在弹出窗口完成登录（含验证码/短信验证）'
      : tokenValid
        ? '已签发且经官方接口校验有效'
        : '已存在但**已失效**（需重新登录；这正是「网络错误」页的成因）',
  });

  // ④ LMS 是否认可该会话（用真实 API 判断，不依赖 document.cookie）
  const api = await probeLmsApi(page);
  steps.push({
    id: 'lms-session',
    label: '优学院会话校验（/courseapi/courses/students）',
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

  // 浏览器上下文已死：其余步骤的"异常"都不代表平台故障，必须明确说出来，
  // 否则用户会以为学校平台挂了。
  if (!browserAlive) {
    return {
      steps,
      blockedAt: 'portal-entry',
      summary:
        '受控浏览器已关闭或异常退出，无法探测优学院链路。' +
        '请点「登录」重新拉起浏览器窗口后再诊断。',
    };
  }

  const firstBad = steps.find((s) => !s.ok && !s.neutral);
  return {
    steps,
    blockedAt: firstBad?.id ?? null,
    summary: buildLmsDiagnosticSummary(steps, {
      tokenPresent: Boolean(auth?.value),
      tokenValid,
    }),
  };
}

/**
 * 由步骤推导面向用户的结论（纯函数，便于单测）。
 *
 * 设计原则（AGENTS.md 红线 3）：**不得把"失败"说成"没有"**，也不得把
 * 「登录失效」误报成「网络故障」——两种病的处方完全不同。
 */
export function buildLmsDiagnosticSummary(
  steps: LmsDiagnosticStep[],
  ctx: { tokenPresent?: boolean; tokenValid?: boolean } = {},
): string {
  const firstBad = steps.find((s) => !s.ok && !s.neutral);
  if (!firstBad) return '优学院链路全部正常。';

  switch (firstBad.id) {
    case 'portal-entry':
      return (
        '应用中心（application.dgut.edu.cn）不可达，请确认已连接校园网或学校 VPN。' +
        '（优学院自身登录页 /sld/pc.html 已永久 404，只能经应用中心接入。）'
      );
    case 'cas-reachable':
      return '无法访问莞工中央认证，请确认已连接校园网或学校 VPN。';
    case 'cas-authorized':
      return ctx.tokenPresent && ctx.tokenValid === false
        ? '本机的优学院登录票据已失效（页面出现「网络错误，点击重新加载」就是这个原因，不是断网）。' +
            '请点「登录」重新完成中央认证，然后点「立即同步」。'
        : '尚未完成中央认证。请点「登录」在弹出窗口登录（需验证码；新设备还需短信验证）。';
    case 'lms-session':
      return (
        '中央认证入口可达，但优学院未认可当前会话。' +
        '请点「登录」重新走一遍「应用中心 → 优学院」，再点「立即同步」。'
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
 * 安全读取全部 cookie。
 *
 * 返回 `null` 表示**浏览器上下文已不可用**（"Target closed" 等），
 * 与"读取成功但没有 cookie"（返回空数组）是不同语义，调用方必须区分：
 * 前者是环境问题，后者是未登录。
 */
async function readCookiesSafely(page: Page): Promise<{ name: string; value: string }[] | null> {
  try {
    const all = await page.context().cookies();
    return all.map((c) => ({ name: c.name, value: c.value }));
  } catch {
    return null;
  }
}

/**
 * 官方 token 探活（无副作用）。
 *
 * 实测：`GET /courseapi/users/isValidToken/<token>` 返回裸 `true` / `false`（HTTP 200）。
 * 依据 LMS 前端 `model/User.js` 的 `judgeToken()`，平台自己也是这么判的。
 * 只返回布尔，不读取/记录 token 值本身。
 */
async function probeTokenValid(page: Page, token: string): Promise<boolean> {
  try {
    const r = await page.evaluate(async (t: string) => {
      try {
        const res = await fetch(`/courseapi/users/isValidToken/${encodeURIComponent(t)}`, {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        const txt = (await res.text()).trim();
        return { status: res.status, txt: txt.slice(0, 80) };
      } catch {
        return { status: 0, txt: '' };
      }
    }, token);
    if (r.status !== 200) return false;
    return r.txt === 'true' || /"data"\s*:\s*true/.test(r.txt);
  } catch {
    return false;
  }
}

/**
 * 确保页面处在可探测的源下（诊断用）。
 * 只在页面既不在 LMS 也不在 CAS/门户时导航，避免打断用户正在进行的登录。
 *
 * ⚠️ 不再导航到 `/sld/pc.html`（已 404）；改用仍有效的 LMS 前端外壳。
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

/**
 * 探测某 URL 是否可达（只发 GET，follow 重定向，不发送任何凭证）。
 *
 * 【为什么用 Node 侧 fetch 而不是页面内 fetch】
 * 应用中心 / 认证中心与 lms 不同源，页面内 fetch 会被 CORS 拦成 status 0，
 * 会被误读成"平台不可达"。这里只是探"这台机器能不能连到学校站点"，
 * 用主进程的 fetch 最准确（且天然不带任何浏览器 cookie，绝无凭证泄露风险）。
 */
async function probeHttp(
  _page: Page,
  url: string,
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.status > 0 && res.status < 400, status: res.status };
  } catch {
    // 网络层不可达：交给调用方结合页面状态判断，不在此武断下结论
    return { ok: false, status: 0 };
  }
}

/**
 * 用真实业务接口校验会话（与适配器 checkSession 同一路径，避免"诊断通过但同步失败"）。
 *
 * 必须带 `Authorization: <AUTHORIZATION>` + `version: 1` 两个头 —— 只带 cookie 会 401
 * `{"code":2001,"message":"缺少访问token"}`（见 docs/PLATFORM_FINDINGS.md §3.2）。
 */
async function probeLmsApi(page: Page): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await page.evaluate(async (apiBase: string) => {
      try {
        // 跨域探测会被浏览器拦（CORS）得到 status 0 —— 那不是"平台不可达"，
        // 必须先判断当前页面是否在 LMS 源下，否则会给出误导性结论。
        const onLmsOrigin = location.hostname === 'lms.dgut.edu.cn';
        const m = document.cookie.match(/(?:^|;\s*)AUTHORIZATION=([^;]*)/);
        const auth = m ? decodeURIComponent(m[1]!) : '';
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (auth) {
          headers['Authorization'] = auth;
          headers['version'] = '1';
        }
        // 用**绝对地址**：诊断时页面可能停在应用中心/CAS 域，
        // 相对路径会打到那个源上得到 404，伪装成"会话无效"。
        // ps 必须 >= 页面实际使用值（ps=1 会让服务端抛 NPE 500）
        const res = await fetch(
          `${apiBase}/courseapi/courses/students?keyword=&publishStatus=1&type=1&pn=1&ps=15&lang=zh`,
          { headers, credentials: 'include' },
        );
        const t = await res.text();
        const total = /"total"\s*:\s*(\d+)/.exec(t)?.[1] ?? '';
        return {
          onLmsOrigin,
          status: res.status,
          code: /"code"\s*:\s*(\d+)/.exec(t)?.[1] ?? '',
          total,
          len: t.length,
        };
      } catch {
        return {
          onLmsOrigin: location.hostname === 'lms.dgut.edu.cn',
          status: 0,
          code: '',
          total: '',
          len: 0,
        };
      }
    }, LMS);
    if (r.status === 200 && r.len > 2 && !r.code) {
      return { ok: true, detail: `HTTP 200，课程数 ${r.total || '?'}，已登录` };
    }
    if (r.status === 0 && !r.onLmsOrigin) {
      return {
        ok: false,
        detail: '当前页面不在 lms.dgut.edu.cn 域（跨域探测被浏览器拦截），请先完成登录再诊断',
      };
    }
    return {
      ok: false,
      detail:
        r.status === 0
          ? '请求未发出（网络不可达）'
          : `HTTP ${r.status}${r.code ? `，业务码 ${r.code}` : ''}（未登录或 token 缺失）`,
    };
  } catch {
    return { ok: false, detail: '请求失败' };
  }
}
