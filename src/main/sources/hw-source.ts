/**
 * 莞工作业平台（hw.dgut.edu.cn）适配器。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 以下全部为 **2026-11-08 真机实测** 结果（学生账号），
 * 证据文件：investigation/evidence/real-plan.json、real-homework.json
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. 登录：中央认证 CAS OAuth2（wisedu），必须由用户手工完成，
 *    本适配器不代填密码、不触碰验证码。
 * 2. 会话：服务端 session cookie，浏览器进程关闭即失效
 *    → 需长驻浏览器 + storageState。
 * 3. 接口（均为页面自身发出的 GET）：
 *      GET /api/user/profile          → {code,msg,data:{id,userType,userProfile}}
 *      GET /api/config                → {startTime,xn,xq,isCourseSync}
 *      GET /api/student/term          → {startXn,endXn,endXq}
 *      GET /api/student/plan?size&page&sort=create_time,desc
 *      GET /api/student/homework?size&page&sort=uploadDate,desc
 * 4. 包络：{ code, msg, data }；未登录 code=-11 且 **HTTP 仍为 200**（必须判 code）。
 * 5. 分页容器：data = { total: number, data: Row[] }   ← 实测为 data.data
 *
 * ── 字段语义（实测确认，推翻了早期的错误假设）────────────────────────────
 *  deadline       → **boolean**，表示"是否设置了截止时间"（实测恒为 true）
 *  deadlineDate   → **string "YYYY-MM-DD HH:mm"**，这才是真实截止时间（含时间！）
 *  submitted      → **boolean**，仅 /student/plan 返回；true=已提交
 *  homeworkId     → 未提交为 null，已提交为数字（上传记录 ID）
 *  markedStatus   → "marked" | "unmarked" | null
 *  entityStatus   → "Enabled"
 *  checkStatus    → "Disable" | "Enabled"（查重开关，与提交状态无关）
 *  completeWay    → "single"（个人）/ 其它为分组
 *  /student/homework 的 planId/homeworkPlanId → 指向 /student/plan 的 id
 *  /student/homework 的 id → 该次上传记录 ID
 *
 * ── 去重键选择 ────────────────────────────────────────────────────────
 * 两个接口的"主键"不同：plan 用 `id`（作业计划 ID），homework 用
 * `homeworkPlanId`（= plan 的 id）。因此统一用 **plan 侧 id**
 * （homework 侧取 homeworkPlanId 回退 id）作为 stable key，两接口即可合流。
 *
 * ── 仍待人工核对 ──────────────────────────────────────────────────────
 *  · 分组作业（completeWay != 'single'）下 submitted 的语义
 *  · 是否所有作业都设了截止时间（deadline=false 时的表现）
 *  · 跨学期（xn/xq 过滤）是否需要显式参数
 */

import type { Assignment, SourceId, SessionStatus } from '@dgut-deadline/shared';
import {
  assignmentId,
  isAllowedDetailUrl,
  parseDueAt,
  type AssignmentSource,
  type ListOptions,
  type SubmissionStatus,
} from '@dgut-deadline/shared';
import { BrowserSession, detectEdge } from '../browser/session.js';
import { RateLimiter } from './rate-limit.js';

const SOURCE: SourceId = 'hw';
const BASE = 'https://hw.dgut.edu.cn';
const ORIGIN = BASE;
const HOST = 'hw.dgut.edu.cn';

/** 平台统一响应包络。 */
interface ApiEnvelope<T> {
  code: number;
  msg: string | null;
  data: T | null;
}

/** 实测分页容器：{ total, data }。 */
interface PageContainer<T> {
  total?: number;
  data?: T[];
  // 容错：不同版本可能用其它键
  content?: T[];
  list?: T[];
  records?: T[];
}

/** /api/student/plan 行（字段名与类型均来自实测）。 */
export interface HwPlanRow {
  id: number;
  /** 是否设置了截止时间（boolean，不是时间字符串！）。 */
  deadline?: boolean | null;
  /** 真实截止时间字符串 "YYYY-MM-DD HH:mm"。 */
  deadlineDate?: string | null;
  homeworkName?: string;
  description?: string | null;
  courseName?: string | null;
  teacherName?: string | null;
  /** 是否已提交（仅 plan 接口返回）。 */
  submitted?: boolean | null;
  /** 未提交为 null，已提交为上传记录 ID。 */
  homeworkId?: number | null;
  markedStatus?: 'marked' | 'unmarked' | null | string;
  entityStatus?: string | null;
  checkStatus?: string | null;
  completeWay?: string | null;
  score?: string | number | null;
  scoreType?: string | null;
  homeworkType?: string | null;
  createTime?: string | null;
  xn?: number | null;
  xq?: number | null;
}

/** /api/student/homework 行。 */
export interface HwUploadRow {
  /** 上传记录 ID（不是作业计划 ID）。 */
  id: number;
  /** 作业计划 ID（= plan 的 id）。 */
  homeworkPlanId?: number | null;
  planId?: number | null;
  homeworkName?: string;
  courseName?: string | null;
  deadline?: boolean | null;
  deadlineDate?: string | null;
  uploadDate?: string | null;
  fileName?: string | null;
  markedStatus?: string | null;
  score?: string | number | null;
  completeWay?: string | null;
  xn?: number | null;
  xq?: number | null;
}

interface ProfileData {
  id?: number;
  userType?: string;
  userProfile?: { studentClass?: { className?: string } };
}

export class HwAssignmentSource implements AssignmentSource {
  readonly source = SOURCE;
  readonly displayName = '莞工作业平台';

  private readonly session: BrowserSession;
  private readonly limiter = new RateLimiter();
  private lastSuccessAt: string | null = null;

  constructor(opts: { userDataDir: string; headless?: boolean }) {
    this.session = new BrowserSession({
      userDataDir: opts.userDataDir,
      headless: opts.headless ?? false,
    });
  }

  async connect(): Promise<SessionStatus> {
    const edge = await detectEdge();
    const now = new Date().toISOString();
    if (!edge.available) {
      return {
        source: SOURCE,
        state: 'error',
        message: edge.reason,
        lastSuccessAt: this.lastSuccessAt,
        lastAttemptAt: now,
        requiresUserAction: true,
      };
    }
    // 优先复用已登录的页面，避免把用户登录好的标签页覆盖掉
    const page = await this.session.getPage(HOST);
    const current = safeUrl(page);
    if (!current.includes(HOST)) {
      await this.safeGoto(page, `${BASE}/home`);
    }
    return this.checkSession();
  }

  async checkSession(): Promise<SessionStatus> {
    const now = new Date().toISOString();
    try {
      const page = await this.session.getPage(HOST);

      // 关键：页面可能还停在 about:blank（应用刚启动 / 浏览器刚拉起）。
      // 相对路径 fetch 在非目标源上会抛 "Failed to parse URL"，
      // 必须先导航到平台源，否则会把"尚未导航"误判成连接错误。
      await ensureOrigin(page, BASE, `${BASE}/home`);

      const env = await this.getJson<ProfileData>(page, '/api/user/profile');

      // 实测：未登录时 code = -11, msg = "unauthorized"（HTTP 200）
      if (env.code === -11 || !env.data) {
        return {
          source: SOURCE,
          state: 'needs_login',
          message: '尚未登录莞工作业平台。请点击「登录」，在弹出的 Edge 窗口用中央认证完成登录。',
          lastSuccessAt: this.lastSuccessAt,
          lastAttemptAt: now,
          requiresUserAction: true,
        };
      }

      const userType = String(env.data.userType ?? '');
      if (userType && !userType.includes('student')) {
        return {
          source: SOURCE,
          state: 'error',
          message: `当前账号角色为「${userType}」，本应用只读取学生作业数据。`,
          lastSuccessAt: this.lastSuccessAt,
          lastAttemptAt: now,
          requiresUserAction: false,
        };
      }

      this.lastSuccessAt = now;
      return {
        source: SOURCE,
        state: 'connected',
        message: '已连接莞工作业平台。',
        lastSuccessAt: this.lastSuccessAt,
        lastAttemptAt: now,
        requiresUserAction: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const blocked = /ENOTFOUND|getaddrinfo|ECONNREFUSED/i.test(msg);
      // 未登录会以 401 / code -11 抛出，应归类为 needs_login 而不是 error
      const unauthorized = /401|unauthorized|code -11/i.test(msg);
      return {
        source: SOURCE,
        state: blocked ? 'network_blocked' : unauthorized ? 'needs_login' : 'error',
        message: blocked
          ? '无法访问 hw.dgut.edu.cn，请确认已连接校园网或学校 VPN。'
          : unauthorized
            ? '尚未登录莞工作业平台。请点击「登录」，在弹出的 Edge 窗口用中央认证完成登录。'
            : `检查登录状态失败：${msg.slice(0, 160)}`,
        lastSuccessAt: this.lastSuccessAt,
        lastAttemptAt: now,
        requiresUserAction: blocked || unauthorized,
      };
    }
  }

  async listAssignments(options: ListOptions = {}): Promise<Assignment[]> {
    const timeoutMs = options.timeoutMs ?? 90_000;
    const page = await this.session.getPage(HOST);
    page.setDefaultTimeout(timeoutMs);

    const status = await this.checkSession();
    if (status.state !== 'connected') {
      throw new Error(
        status.state === 'needs_login'
          ? '401 unauthorized: 需要重新登录'
          : `${status.state}: ${status.message}`,
      );
    }

    const lastSyncAt = new Date().toISOString();
    const pageSize = 100;

    // ── 1. 读取作业计划（含未提交项 + submitted 标记）──────────────────
    const plans = await this.fetchAllPages<HwPlanRow>(
      page,
      '/api/student/plan',
      'create_time,desc',
      pageSize,
    );

    // ── 2. 读取上传记录（补充上传时间/文件名/批阅状态）────────────────
    let uploads: HwUploadRow[] = [];
    const warnings: string[] = [];
    try {
      uploads = await this.fetchAllPages<HwUploadRow>(
        page,
        '/api/student/homework',
        'uploadDate,desc',
        pageSize,
      );
    } catch (err) {
      // 上传列表失败不应让整体失败：plan 已足够给出作业与提交状态
      warnings.push(
        `已上传作业列表读取失败：${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
      );
    }

    // 以 plan 为主表；若 plan 为空但 uploads 有数据，用 uploads 兜底（避免漏作业）
    const byPlanId = new Map<number, { plan?: HwPlanRow; upload?: HwUploadRow }>();
    for (const p of plans) {
      byPlanId.set(Number(p.id), { plan: p });
    }
    for (const u of uploads) {
      const key = Number(u.homeworkPlanId ?? u.planId ?? u.id);
      const cur = byPlanId.get(key);
      if (cur) cur.upload = u;
      else byPlanId.set(key, { upload: u });
    }

    if (byPlanId.size === 0) {
      // 两个接口都返回空：这是"确认没有作业"，交由上层处理为 empty
      return [];
    }

    const result: Assignment[] = [];
    for (const [planId, pair] of byPlanId) {
      const a = this.normalize(planId, pair.plan, pair.upload, lastSyncAt);
      if (a) result.push(a);
    }

    return result.sort((x, y) => {
      const xd = x.dueAt ? Date.parse(x.dueAt) : Number.MAX_SAFE_INTEGER;
      const yd = y.dueAt ? Date.parse(y.dueAt) : Number.MAX_SAFE_INTEGER;
      if (xd !== yd) return xd - yd;
      return x.title.localeCompare(y.title, 'zh-CN');
    });
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  // ── 内部实现 ──────────────────────────────────────────────

  /** 容错导航：失败不抛错，交由后续 checkSession 判定。 */
  private async safeGoto(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
    url: string,
  ): Promise<boolean> {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await waitForStableUrl(page, 1200, 8000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 在页面上下文内用同源 fetch 调用只读接口（自动带上登录 Cookie）。
   *
   * hw 是 Vue SPA，页面在 /home 与 /login 之间可能发生跳转，
   * 导致 "Execution context was destroyed" 竞态。
   * 这里做有限次重试：重新等页面稳定后再次读取，而不是直接判为失败。
   */
  private async getJson<T>(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
    path: string,
    attempt = 0,
  ): Promise<ApiEnvelope<T>> {
    try {
      // 限流：同一平台请求串行且保持最小间隔，避免给学校平台造成压力
      const limited = await this.limiter.run(async () => {
        const res = await page.evaluate(
          async (p: string) => {
            const r = await fetch(p, {
              method: 'GET',
              headers: { Accept: 'application/json' },
              credentials: 'include',
            });
            const text = await r.text();
            try {
              return { status: r.status, json: JSON.parse(text) as unknown };
            } catch {
              return { status: r.status, json: { code: -1, msg: text.slice(0, 200), data: null } };
            }
          },
          path,
        );
        return res;
      });

      if (!limited.ok || !limited.value) {
        // 退避耗尽：抛出可分类的错误
        throw new Error(
          `请求失败（已重试 ${limited.attempts} 次）status=${limited.lastStatus ?? 'unknown'}`,
        );
      }

      const res = limited.value;
      if (res.status === 401 || res.status === 403) {
        throw new Error(`401 unauthorized: HTTP ${res.status}`);
      }
      const json = res.json as ApiEnvelope<T>;
      if (json?.code === -11) throw new Error('401 unauthorized: code -11');
      return json;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isContextRace =
        /Execution context was destroyed|most likely because of a navigation|Cannot find context/i.test(
          msg,
        );
      if (isContextRace && attempt < 3) {
        await waitForStableUrl(page, 900, 6000);
        return this.getJson<T>(page, path, attempt + 1);
      }
      throw err;
    }
  }

  /** 逐页读取直到取满 total 或返回空页（防止无限循环）。 */
  private async fetchAllPages<T>(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
    path: string,
    sort: string,
    pageSize: number,
    maxPages = 20,
  ): Promise<T[]> {
    const out: T[] = [];
    let total = Infinity;

    for (let pageNo = 0; pageNo < maxPages; pageNo++) {
      const params = new URLSearchParams({ size: String(pageSize), page: String(pageNo), sort });
      const env = await this.getJson<PageContainer<T>>(page, `${path}?${params.toString()}`);
      if (env.code !== 0 && env.code !== 200) {
        throw new Error(`平台返回 code=${env.code} msg=${env.msg ?? ''}`);
      }
      const rows = extractRows(env.data);
      if (rows.length === 0) break;
      out.push(...rows);
      if (typeof env.data?.total === 'number') total = env.data.total;
      if (out.length >= total) break;
      if (rows.length < pageSize) break;
    }
    return out;
  }

  /**
   * 归一化。
   *
   * 数据来源优先级：
   *  - 截止时间：plan.deadlineDate > upload.deadlineDate（**不是 deadline，那是布尔**）
   *  - 提交状态：plan.submitted（布尔，最可靠）；缺失时用 upload 是否存在推断，
   *    并在 evidence 中标明依据来源。
   */
  normalize(
    planId: number,
    plan: HwPlanRow | undefined,
    upload: HwUploadRow | undefined,
    lastSyncAt: string,
  ): Assignment | null {
    const title = (plan?.homeworkName ?? upload?.homeworkName ?? '').trim();
    if (!title) return null;

    const courseName = (plan?.courseName ?? upload?.courseName ?? null)?.trim() || null;

    // ── 截止时间：deadlineDate 才是真实时间 ──────────────────────
    const dueRaw = plan?.deadlineDate ?? upload?.deadlineDate ?? null;
    const parsed = parseDueAt(dueRaw);
    // deadline=false 表示平台明确未设置截止时间
    const explicitlyNoDue = plan?.deadline === false && !dueRaw;

    const statusResult = this.resolveStatus(plan, upload);

    // 详情跳转：plan 列表页（已确认存在的路由）
    const detailUrl = `${ORIGIN}/student/homeworkPlan`;

    return {
      source: SOURCE,
      sourceAssignmentId: String(planId),
      id: assignmentId(SOURCE, String(planId)),
      // 实测 plan 行未返回独立 courseId，但 courseName 稳定，可用于分组
      courseId: null,
      courseName,
      title,
      detailUrl: isAllowedDetailUrl(SOURCE, detailUrl) ? detailUrl : null,
      dueAt: parsed.dueAt,
      duePrecision: explicitlyNoDue ? 'none' : parsed.duePrecision,
      submissionStatus: statusResult.status,
      statusEvidence:
        statusResult.evidence + (explicitlyNoDue ? '；平台标记 deadline=false（未设截止）' : ''),
      firstSeenAt: lastSyncAt,
      lastSeenAt: lastSyncAt,
      lastSyncAt,
      sourceUpdatedAt: plan?.createTime ?? upload?.uploadDate ?? null,
    };
  }

  /**
   * 提交状态判定。
   *
   * 实测：plan.submitted 为布尔且可靠（true 时 homeworkId 有值且 homeworkFileName 存在）。
   * 仅有 upload 记录（plan 缺失）时，用"存在上传记录"推断为已提交，
   * 但明确降级为低置信 evidence，因为 uploads 接口可能分页不全。
   */
  resolveStatus(
    plan: HwPlanRow | undefined,
    upload: HwUploadRow | undefined,
  ): { status: SubmissionStatus; evidence: string } {
    if (plan && typeof plan.submitted === 'boolean') {
      return {
        status: plan.submitted ? 'submitted' : 'not_submitted',
        evidence: `plan.submitted=${plan.submitted}`,
      };
    }
    if (!plan && upload) {
      // 只在"已上传列表"里出现、plan 列表里没有：
      // 说明该作业计划已不在当前 plan 列表（可能是历史学期或已归档）。
      // 有上传记录**确实是已提交的证据**，但不能等同于平台明确声明，
      // 因此保留 submitted 但 evidence 明确标注为"依据上传记录"。
      return {
        status: 'submitted',
        evidence: `依据上传记录（upload.id=${upload.id}，uploadDate=${upload.uploadDate ?? '未知'}）`,
      };
    }
    if (plan && plan.submitted === null) {
      return { status: 'unknown', evidence: 'plan.submitted=null' };
    }
    return { status: 'unknown', evidence: '平台未返回 submitted 字段' };
  }
}

function extractRows<T>(data: PageContainer<T> | T[] | null | undefined): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.data ?? data.content ?? data.list ?? data.records ?? [];
}

/** 安全读取当前 URL（导航中可能抛错）。 */
function safeUrl(page: { url(): string }): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

/**
 * 确保页面处在目标源下。
 *
 * 同源相对路径 fetch 要求 `location.origin` 与目标一致；
 * 应用刚启动时页面是 about:blank，必须导航过去。
 * 已经在目标站点（含任意子路径）时不做多余导航，避免打断用户正在进行的登录。
 */
async function ensureOrigin(
  page: Awaited<ReturnType<BrowserSession['getPage']>>,
  origin: string,
  fallbackUrl: string,
): Promise<void> {
  const current = safeUrl(page);
  if (current.startsWith(origin)) return;
  try {
    await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // hw 是 Vue SPA：domcontentloaded 之后前端还会做一次路由跳转/重定向
    // （例如 /home -> /login）。此时立刻 evaluate 会命中
    // "Execution context was destroyed" 竞态，必须等页面稳定。
    await waitForStableUrl(page, 1200, 8000);
  } catch {
    // 导航失败交由后续 fetch 的错误分类处理
  }
}

/** 等待页面 URL 在一段时间内不再变化（应对 SPA 重定向竞态）。 */
async function waitForStableUrl(
  page: Awaited<ReturnType<BrowserSession['getPage']>>,
  quietMs: number,
  maxMs: number,
): Promise<void> {
  const start = Date.now();
  let last = safeUrl(page);
  let lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 150));
    let cur = last;
    try {
      cur = page.url();
    } catch {
      // 导航中，忽略
      continue;
    }
    if (cur !== last) {
      last = cur;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return;
    }
  }
}
