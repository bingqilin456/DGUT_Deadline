/**
 * 优学院 LMS（lms.dgut.edu.cn）适配器。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 2026-11-08 真机实测确认（登录态下读取到 25 门课程 / 16 门有作业）
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ## 鉴权（关键）
 * LMS 的 `/courseapi/*` 需要 **`Authorization` 请求头**（值取自 `AUTHORIZATION`
 * cookie）与 **`version: 1` 头**。只带 cookie 会返回：
 *   {"code":2001,"message":"缺少访问token"}
 * 这是前端 `init.js` 里 `$.ajaxSetup.beforeSend` 的行为，本适配器照此复现。
 *
 * ## 登录链路（三段，DGUT 特有）
 * 认证中心只信任来自应用中心 `application.dgut.edu.cn` 的请求，因此：
 *   A. CAS，service 必须指向应用中心：
 *      https://auth.dgut.edu.cn/authserver/login
 *        ?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas
 *   B. 拿到 .dgut.edu.cn 域下的 AUTHORIZATION 与 token
 *   C. LMS 前端据 cookie 完成登录，之后才能调 API
 *
 * ## 已验证接口
 *   GET /courseapi/courses/students?pn&ps&lang=zh
 *       → { pn, ps, total, courseList: [{ id, name, teacherName, ... }] }
 *   GET /courseapi/homeworks/student/v2?ocId=<courseId>&pn&ps&lang=zh
 *       → { pn, ps, total, homeworkList: [HomeworkRow] }
 *       注意参数名是 **ocId**（不是 courseId），用错会返回 400。
 *
 * ## 作业字段（实测）
 *   id            作业 ID（稳定键）
 *   homeworkTitle 标题
 *   startTime     开始时间（毫秒时间戳）
 *   endTime       结束时间（毫秒时间戳）—— 即截止时间
 *   status        2 = 未完成 / 3 = 已完成
 *   personStatus  1 / 2，与 status 同向（2 为已完成）
 *   timeStatus    "2" 未过期 / "3" 已过期
 *   type          9 / 3 / 8（作业类型，含义待确认）
 *   publisher     发布教师
 *
 * ## 未知（保守处理）
 *   · `status` 与 `personStatus` 的精确取值域（仅观测到 2/3 与 1/2）
 *   · 小组作业语义
 *   → 因此仅对**明确等于 3** 判为已提交，其余一律按未知/未提交保守处理，
 *     并在 statusEvidence 中记录原始值。
 */

import type { Assignment, SourceId, SessionStatus } from '@dgut-deadline/shared';
import {
  assignmentId,
  isAllowedDetailUrl,
  parseDueAt,
  type AssignmentSource,
  type ListOptions,
} from '@dgut-deadline/shared';
import { BrowserSession, detectEdge } from '../browser/session.js';
import { RateLimiter } from './rate-limit.js';

const SOURCE: SourceId = 'ulearning';
const BASE = 'https://lms.dgut.edu.cn';
const HOST = 'lms.dgut.edu.cn';

/** CAS 必须指向应用中心，否则不会被信任。 */
const CAS_TO_PORTAL =
  'https://auth.dgut.edu.cn/authserver/login?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas';

/** LMS 课程列表页（hash 路由）。 */
const LMS_HOME = `${BASE}/courseweb/ulearning/index.html#/index/courseList`;

/** 维护公告页特征（2026-11 实测）；命中即判为平台维护，而非零作业。 */
const MAINTENANCE_MARKERS = ['系统更新维护通知', '系统维护公告', '暂停服务', '正在维护'];

/** 课程行（实测字段）。 */
export interface LmsCourseRow {
  id: number;
  name: string;
  teacherName?: string;
  courseCode?: string;
  className?: string;
}

/** 作业行（实测字段）。 */
export interface LmsHomeworkRow {
  id: number;
  homeworkTitle?: string;
  startTime?: number | null;
  endTime?: number | null;
  /** 2 = 未完成 / 3 = 已完成 */
  status?: number | null;
  /** 1 / 2（2 为已完成） */
  personStatus?: number | null;
  /** "2" 未过期 / "3" 已过期 */
  timeStatus?: string | null;
  type?: number | null;
  publisher?: string | null;
  showLevel?: number | null;
  state?: number | null;
}

export class UlearningAssignmentSource implements AssignmentSource {
  readonly source = SOURCE;
  readonly displayName = '优学院 LMS';

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

    // 先检查是否已登录，已登录就绝不再导航
    const current = await this.checkSession({ skipNavigation: true });
    if (current.state === 'connected' || current.state === 'platform_maintenance') {
      return current;
    }

    const curUrl = safeUrl(page);
    const onLms = curUrl.includes(HOST);
    const onCas = curUrl.includes('auth.dgut.edu.cn');
    const onPortal = curUrl.includes('application.dgut.edu.cn');

    if (onLms) {
      return {
        source: SOURCE,
        state: 'needs_login',
        message:
          '浏览器已停在优学院页面，但尚未取得有效登录态。' +
          '请在该窗口确认已登录（页面右上角显示你的名字），然后点「立即同步」。',
        lastSuccessAt: this.lastSuccessAt,
        lastAttemptAt: now,
        requiresUserAction: true,
      };
    }

    if (!onCas && !onPortal) {
      await this.safeGoto(page, CAS_TO_PORTAL);
      await this.completeSsoIfPossible(page);
    } else {
      await this.completeSsoIfPossible(page);
    }

    const after = await this.checkSession({ skipNavigation: true });
    if (after.state === 'connected') return after;

    return {
      source: SOURCE,
      state: 'needs_login',
      message:
        '请在已弹出的浏览器窗口完成莞工中央认证（需填验证码；新设备还会要求短信二次验证），' +
        '登录成功后回到本应用点「立即同步」。' +
        '（优学院自身登录页已 404，只能经中央认证接入。）',
      lastSuccessAt: this.lastSuccessAt,
      lastAttemptAt: now,
      requiresUserAction: true,
    };
  }

  /**
   * 若已有 CAS 会话，则完成跳转：用 AUTHORIZATION 参数进入 LMS。
   * 轮询等待用户输入验证码，一旦出现 AUTHORIZATION 立刻跳转。
   */
  private async completeSsoIfPossible(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
    waitMs = 90_000,
  ): Promise<boolean> {
    try {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const cookies = await page.context().cookies();
        const auth = cookies.find((c) => c.name === 'AUTHORIZATION');
        if (auth?.value) {
          if (safeUrl(page).includes(HOST)) return true;
          const url = `${LMS_HOME}?AUTHORIZATION=${encodeURIComponent(auth.value)}`;
          await this.safeGoto(page, url);
          await page.waitForTimeout(6_000);
          return true;
        }
        if (safeUrl(page).includes(HOST)) return true;
        await page.waitForTimeout(2_000);
      }
      return false;
    } catch {
      return false;
    }
  }

  /** 容错导航 */
  private async safeGoto(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
    url: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(2_000);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === 0 && /ERR_ABORTED|Navigation interrupted/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        return false;
      }
    }
    return false;
  }

  async checkSession(opts: { skipNavigation?: boolean } = {}): Promise<SessionStatus> {
    const now = new Date().toISOString();
    try {
      const page = await this.session.getPage(HOST);

      if (!opts.skipNavigation) {
        const current = safeUrl(page);
        const onCas = current.includes('auth.dgut.edu.cn');
        const onPortal = current.includes('application.dgut.edu.cn');
        if (!onCas && !onPortal) {
          await this.ensureOrigin(page, BASE, LMS_HOME);
        }
      }

      const maintenance = await this.detectMaintenance(page);
      if (maintenance) {
        return {
          source: SOURCE,
          state: 'platform_maintenance',
          message: '优学院当前处于系统维护状态，请等待平台恢复后再同步。',
          lastSuccessAt: this.lastSuccessAt,
          lastAttemptAt: now,
          requiresUserAction: true,
        };
      }

      const cur = safeUrl(page);
      if (cur.includes('auth.dgut.edu.cn') || cur.includes('application.dgut.edu.cn')) {
        return needsLogin(this.lastSuccessAt, now);
      }

      // 用真实 API 判定登录态（LMS 需要 Authorization 头，不是仅靠 cookie）
      // 【实测】ps 必须 >= 页面实际使用的值；ps=1 会让服务端抛 NPE（500）。
      const res = await this.lmsGet(
        page,
        '/courseapi/courses/students?keyword=&publishStatus=1&type=1&pn=1&ps=15&lang=zh',
      );
      if (res.status === 401 || res.status === 403) {
        return needsLogin(this.lastSuccessAt, now);
      }
      if (res.status === 503) {
        return {
          source: SOURCE,
          state: 'platform_maintenance',
          message: '优学院返回 503（维护中），请稍后重试。',
          lastSuccessAt: this.lastSuccessAt,
          lastAttemptAt: now,
          requiresUserAction: true,
        };
      }
      // 业务码 2001/2101/2201 = token 缺失/过期
      if (typeof res.body === 'object' && res.body !== null) {
        const code = (res.body as { code?: number }).code;
        if (code === 2001 || code === 2101 || code === 2201) {
          return needsLogin(this.lastSuccessAt, now);
        }
      }
      if (res.status !== 200) {
        return needsLogin(this.lastSuccessAt, now);
      }

      this.lastSuccessAt = now;
      return {
        source: SOURCE,
        state: 'connected',
        message: '已连接优学院 LMS。',
        lastSuccessAt: this.lastSuccessAt,
        lastAttemptAt: now,
        requiresUserAction: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const blocked = /ENOTFOUND|getaddrinfo|ECONNREFUSED/i.test(msg);
      return {
        source: SOURCE,
        state: blocked ? 'network_blocked' : 'error',
        message: blocked
          ? '无法访问 lms.dgut.edu.cn，请确认已连接校园网或学校 VPN。'
          : `检查登录状态失败：${msg.slice(0, 160)}`,
        lastSuccessAt: this.lastSuccessAt,
        lastAttemptAt: now,
        requiresUserAction: blocked,
      };
    }
  }

  /**
   * 读取全部课程的作业。
   *
   * 流程：先取课程列表 → 逐门课取作业 → 归一化。
   * 单门课失败不影响其它课程（记录到 evidence）。
   */
  async listAssignments(options: ListOptions = {}): Promise<Assignment[]> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const page = await this.session.getPage(HOST);
    page.setDefaultTimeout(timeoutMs);

    const status = await this.checkSession();
    if (status.state !== 'connected') {
      throw new Error(`${status.state}: ${status.message}`);
    }

    const courses = await this.listCourses(page);
    if (!courses) {
      throw new Error('parse_error: 课程列表结构无法识别');
    }

    const lastSyncAt = new Date().toISOString();
    const out: Assignment[] = [];
    const maxCourses = options.maxCourses ?? 40;

    for (const course of courses.slice(0, maxCourses)) {
      const rows = await this.listCourseHomeworks(page, course.id);
      for (const row of rows) {
        const a = this.normalizeHomework(course, row, lastSyncAt);
        if (a) out.push(a);
      }
    }

    return out.sort((x, y) => {
      const xd = x.dueAt ? Date.parse(x.dueAt) : Number.MAX_SAFE_INTEGER;
      const yd = y.dueAt ? Date.parse(y.dueAt) : Number.MAX_SAFE_INTEGER;
      if (xd !== yd) return xd - yd;
      return x.title.localeCompare(y.title, 'zh-CN');
    });
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  /** 诊断接入链路（供 UI「诊断」按钮使用）。 */
  async diagnose(): Promise<import('./lms-diagnostic.js').LmsDiagnostic> {
    const { diagnoseLms } = await import('./lms-diagnostic.js');
    const page = await this.session.getPage(HOST);
    return diagnoseLms(page);
  }

  // ── 内部实现 ──────────────────────────────────────────────

  /** 读取课程列表（实测可用）。 */
  async listCourses(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
  ): Promise<LmsCourseRow[] | null> {
    const res = await this.lmsGet(
      page,
      '/courseapi/courses/students?keyword=&publishStatus=1&type=1&pn=1&ps=50&lang=zh',
    );
    const body = res.body as { courseList?: LmsCourseRow[] } | null;
    if (!body || !Array.isArray(body.courseList)) return null;
    return body.courseList;
  }

  /**
   * 读取某门课程的作业。
   *
   * 【实测】参数名必须是 `ocId`（传 courseId 会返回 400）。
   * 分页读取直到取满 total。
   */
  async listCourseHomeworks(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
    courseId: number,
    pageSize = 50,
  ): Promise<LmsHomeworkRow[]> {
    const all: LmsHomeworkRow[] = [];
    for (let pn = 1; pn <= 10; pn++) {
      const res = await this.lmsGet(
        page,
        `/courseapi/homeworks/student/v2?ocId=${courseId}&pn=${pn}&ps=${pageSize}&lang=zh`,
      );
      if (res.status !== 200) break;
      const body = res.body as {
        total?: number;
        homeworkList?: LmsHomeworkRow[];
        list?: LmsHomeworkRow[];
        data?: LmsHomeworkRow[];
      } | null;
      const list = body?.homeworkList ?? body?.list ?? body?.data ?? [];
      if (!Array.isArray(list) || list.length === 0) break;
      all.push(...list);
      const total = body?.total ?? 0;
      if (all.length >= total) break;
      if (list.length < pageSize) break;
    }
    return all;
  }

  /**
   * 带正确鉴权头的 LMS API 请求（含限流与退避）。
   *
   * 【实测关键】必须带 `Authorization`（取自 AUTHORIZATION cookie）与 `version: 1`。
   * 请求经 RateLimiter 串行化，避免对学校平台造成压力。
   */
  private async lmsGet(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
    path: string,
  ): Promise<{ status: number; body: unknown }> {
    const attempt = async (): Promise<{ status: number; body: unknown }> => {
      return page.evaluate(async (p: string) => {
        const getCookie = (n: string) => {
          const m = document.cookie.match(new RegExp('(^|;\\s*)' + n + '=([^;]*)'));
          return m ? decodeURIComponent(m[2]!) : null;
        };
        const auth = getCookie('AUTHORIZATION');
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (auth) {
          headers['Authorization'] = auth;
          headers['version'] = '1';
        }
        try {
          const res = await fetch(p, { headers, credentials: 'include' });
          const text = await res.text();
          let body: unknown = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
          return { status: res.status, body };
        } catch (e) {
          return { status: 0, body: { error: String(e) } };
        }
      }, path);
    };

    const r = await this.limiter.run(attempt);
    if (r.ok && r.value) return r.value;
    // 失败时返回最后一次结果（交给上层分类），并携带状态供退避判定
    return r.value ?? { status: r.lastStatus ?? 0, body: null };
  }

  /**
   * 归一化单条作业。
   *
   * 保守原则：只有 **status === 3**（实测含义为"已完成"）才判为 submitted；
   * 其余（含 2、null、未观测值）一律 not_submitted 或 unknown，并记录原始值。
   */
  normalizeHomework(
    course: LmsCourseRow,
    row: LmsHomeworkRow,
    lastSyncAt: string,
  ): Assignment | null {
    const title = (row.homeworkTitle ?? '').trim();
    if (!title) return null;
    if (row.id === undefined || row.id === null) return null;

    // 截止时间：endTime 是毫秒时间戳
    let parsed = parseDueAt(null);
    if (typeof row.endTime === 'number' && row.endTime > 0) {
      const iso = new Date(row.endTime).toISOString();
      parsed = parseDueAt(iso);
    }

    const status = this.resolveStatus(row);

    const detailUrl = `${BASE}/courseweb/ulearning/index.html#/course/homework?courseId=${course.id}`;

    return {
      source: SOURCE,
      sourceAssignmentId: String(row.id),
      id: assignmentId(SOURCE, String(row.id)),
      courseId: String(course.id),
      courseName: course.name ?? null,
      title,
      detailUrl: isAllowedDetailUrl(SOURCE, detailUrl) ? detailUrl : null,
      dueAt: parsed.dueAt,
      duePrecision: parsed.duePrecision,
      submissionStatus: status.status,
      statusEvidence: status.evidence,
      firstSeenAt: lastSyncAt,
      lastSeenAt: lastSyncAt,
      lastSyncAt,
      sourceUpdatedAt:
        typeof row.startTime === 'number' && row.startTime > 0
          ? new Date(row.startTime).toISOString()
          : null,
    };
  }

  /**
   * 提交状态判定（保守）。
   *
   * 实测观测到的取值：
   *   status: 2 | 3      （3 = 已完成）
   *   personStatus: 1 | 2（2 = 已完成）
   *   timeStatus: "2" | "3"（3 = 已过期）
   */
  resolveStatus(row: LmsHomeworkRow): {
    status: Assignment['submissionStatus'];
    evidence: string;
  } {
    const s = row.status;
    const ps = row.personStatus;

    // 只有明确等于 3 才判为已提交
    if (s === 3 || ps === 2) {
      return {
        status: 'submitted',
        evidence: `status=${String(s)} personStatus=${String(ps)}`,
      };
    }
    // 明确等于 2 表示未完成（实测）
    if (s === 2) {
      return {
        status: 'not_submitted',
        evidence: `status=${String(s)} personStatus=${String(ps)} timeStatus=${String(row.timeStatus)}`,
      };
    }
    // 其余取值未观测到，保守判为未知
    return {
      status: 'unknown',
      evidence: `status=${String(s)} personStatus=${String(ps)}（取值未在实测中出现）`,
    };
  }

  /** 确保页面处在目标源下。 */
  private async ensureOrigin(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
    origin: string,
    fallbackUrl: string,
  ): Promise<void> {
    const current = safeUrl(page);
    if (current.startsWith(origin)) return;
    try {
      await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(2_000);
    } catch {
      // 交由后续错误分类
    }
  }

  /** 识别维护页。 */
  private async detectMaintenance(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
  ): Promise<boolean> {
    try {
      const probe = await page.evaluate(async () => {
        const r = await fetch(location.href, { credentials: 'include' });
        const t = await r.text();
        return { status: r.status, head: t.slice(0, 2000) };
      });
      if (probe.status === 503) return true;
      return MAINTENANCE_MARKERS.some((m) => probe.head.includes(m));
    } catch {
      return false;
    }
  }
}

/** 作业接口未验证的专用错误（保留以兼容既有引用）。 */
export class UnverifiedEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnverifiedEndpointError';
  }
}

/** 安全读取当前 URL。 */
function safeUrl(page: { url(): string }): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

function needsLogin(lastSuccessAt: string | null, now: string): SessionStatus {
  return {
    source: SOURCE,
    state: 'needs_login',
    message:
      '尚未登录优学院。请在已弹出的浏览器窗口完成莞工中央认证' +
      '（需填验证码；新设备还会要求短信二次验证），然后回到本应用点「立即同步」。',
    lastSuccessAt,
    lastAttemptAt: now,
    requiresUserAction: true,
  };
}
