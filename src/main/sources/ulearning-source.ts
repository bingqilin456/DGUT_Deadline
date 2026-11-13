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
 * ## 登录链路（四段，DGUT 特有）
 * 认证中心只信任来自应用中心 `application.dgut.edu.cn` 的请求，因此：
 *   A. CAS，service 必须指向应用中心：
 *      https://auth.dgut.edu.cn/authserver/login
 *        ?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas
 *   B. 拿到 .dgut.edu.cn 域下的 AUTHORIZATION 与 token
 *   C. 应用中心**前端必须真正渲染一次**才会把 AUTHORIZATION / USER_INFO 写进
 *      `Domain=.dgut.edu.cn` 的 cookie（2026-11-11 实测：CAS 回到 fromcas 后不停留
 *      在应用中心就跳 LMS，cookie 不会出现 → LMS 一直显示「登录 / 注册」）
 *   D. 域级 cookie 自动带到 lms.dgut.edu.cn，LMS 前端据 cookie 完成登录，之后才能调 API
 *
 * ## 2026-11-11 实测纠正（本文件曾经的错误假设）
 *   · `/sld/pc.html#/login`（优学院自身登录页）**整目录 404**，不能再作为登录入口；
 *     LMS 自己的失效跳转是 `/courseweb/ulearning/tip/timeout.html`（实测 200）。
 *   · 免密 URL 参数名是 **`token`**（不是 `AUTHORIZATION`），且**必须在 hash 段**：
 *       https://lms.dgut.edu.cn/courseweb/ulearning/index.html#/index/courseList?token=<AUTHORIZATION>
 *     依据 `init.js`: `var token = getHashParam("token"); if (token) setCookie("AUTHORIZATION", token, ...)`
 *     桩验证：hash 里的 `?token=` 生效；查询串 `?token=` 与 hash 里的 `?AUTHORIZATION=` 均不生效。
 *   · 「网络错误，点击重新加载」不是断网，是 `/courseapi/*` 拿不到有效 token 时的兜底 UI。
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

import type { Assignment, ExamItem, SourceId, SessionStatus } from '@dgut-deadline/shared';
import {
  assignmentId,
  isAllowedDetailUrl,
  parseDueAt,
  type AssignmentSource,
  type ListItemsResult,
  type ListOptions,
} from '@dgut-deadline/shared';
import { BrowserSession, detectEdge } from '../browser/session.js';
import { RateLimiter } from './rate-limit.js';
import {
  LmsExamParseError,
  LmsExamSessionExpiredError,
  extractExamRows,
  normalizeExamItems,
  type LmsExamRow,
} from './lms-exam.js';

const SOURCE: SourceId = 'ulearning';
const BASE = 'https://lms.dgut.edu.cn';
const HOST = 'lms.dgut.edu.cn';

/** CAS 必须指向应用中心，否则不会被信任。 */
const CAS_TO_PORTAL =
  'https://auth.dgut.edu.cn/authserver/login?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas';

/** 应用中心（融合门户）根地址。用户登录的唯一可用入口，见文件头 §登录链路。 */
const PORTAL_HOME = 'https://application.dgut.edu.cn/';

/** 应用中心登录页（实测含「校园统一身份认证登录」按钮）。 */
const PORTAL_LOGIN = 'https://application.dgut.edu.cn/#/login';

/** LMS 课程列表页（hash 路由）。 */
const LMS_HOME = `${BASE}/courseweb/ulearning/index.html#/index/courseList`;

/** LMS 官方会话失效页（实测 200；`/sld/pc.html` 已 404）。 */
const LMS_TIMEOUT = `${BASE}/ulearning/tip/timeout.html`;

/** 「网络错误，点击重新加载」= 无效 token 兜底 UI 的文案（courseweb/common/nls/public.js）。 */
const NETWORK_ERROR_MARKERS = ['网络错误', '重新加载'];

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
  /** 作业来自「作业」模块，考试来自「考试」模块（两个独立菜单，见 docs/LMS-EXAM-PLAN.md §4.7）。 */
  readonly supportedKinds = ['homework', 'exam'] as const;

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

    // ① 先探活：已登录就绝不再导航（也不去碰任何登录页）。
    //    【关键】必须用 isValidToken 判有效，不能只看「cookie 是否存在」——
    //    陈旧/失效的 AUTHORIZATION 会让 LMS 渲染「网络错误」，但状态栏可能还显示已登录。
    const current = await this.checkSession({ skipNavigation: true });
    if (current.state === 'connected' || current.state === 'platform_maintenance') {
      return current;
    }

    const curUrl = safeUrl(page);
    const loc = classifyLmsLocation(curUrl);

    // ② 导航到「唯一可用入口」：应用中心。
    //    决策抽在 resolveLmsLoginTarget 里并加单测，防止后人改回坏 URL。
    //    ⚠️ 绝不能导航到 /sld/pc.html#/login —— 该目录已 404（图2「404 Not Found」正是它）。
    //    这一步同时覆盖「用户停在图1 的 LMS 坏页面上」的情形：
    //    平台自身登录入口已 404，把用户留在原页等于让他无路可走。
    const target = resolveLmsLoginTarget(curUrl);
    if (target) {
      await this.safeGoto(page, target);
    }

    // ②b 原本停在 LMS 页面上但会话无效（含图1「网络错误」页）：
    //     给出针对性说明，告诉用户这不是断网。
    if (loc === 'lms') {
      return {
        source: SOURCE,
        state: 'needs_login',
        message:
          '优学院登录态已失效（页面显示「网络错误，点击重新加载」即为登录失效，不是断网）。' +
          '已为你打开应用中心登录页，请点「校园统一身份认证登录」完成认证，' +
          '成功后回到本应用点「立即同步」。',
        lastSuccessAt: this.lastSuccessAt,
        lastAttemptAt: now,
        requiresUserAction: true,
      };
    }

    // ④ 若已有 CAS 会话（CASTGC / 已有 AUTHORIZATION）则自动完成换票。
    //    【不阻塞 UI】没有可复用会话时**立即返回**，把"等用户手工登录"交给用户自己节奏，
    //    而不是让「登录」按钮转 90 秒（旧行为，用户以为卡死了）。
    const canAutoSso =
      (await this.readAuthCookie(page)) !== null ||
      (await this.hasCasTicket(page));
    if (canAutoSso) {
      await this.completeSsoIfPossible(page, 15_000);
    }

    const after = await this.checkSession({ skipNavigation: true });
    if (after.state === 'connected') return after;

    // ⑤ 仍不可用：确保用户眼前是**能登录的页面**，而不是 404 或「网络错误」页。
    if (!safeUrl(page).includes('application.dgut.edu.cn')) {
      await this.safeGoto(page, PORTAL_LOGIN);
    }
    return {
      source: SOURCE,
      state: 'needs_login',
      message:
        '请在已弹出的浏览器窗口中完成莞工中央认证（需填验证码；新设备还会要求短信二次验证）。' +
        '认证成功后窗口会自动停在应用中心 / 优学院，' +
        '确认页面右上角显示你的名字，然后回到本应用点「立即同步」。' +
        '（优学院自身登录页 /sld/pc.html 已 404，只能经应用中心接入。）',
      lastSuccessAt: this.lastSuccessAt,
      lastAttemptAt: now,
      requiresUserAction: true,
    };
  }

  /**
   * 若已有 CAS 会话，则完成「应用中心 → LMS」的换票；否则轮询等待用户手工登录。
   *
   * ═══════════════════════════════════════════════════════════════════
   * 2026-11-11 实测两处关键纠正：
   *  1. **必须让应用中心前端真正渲染一次**。CAS 回跳 `appapi/cas/fromcas` 后
   *     cookie 由应用中心前端以 `Domain=.dgut.edu.cn` 写入；不等它渲染就直接跳 LMS，
   *     AUTHORIZATION 尚未落地 → LMS 右上角仍「登录 / 注册」。
   *  2. **URL 参数是 hash 里的 `token`**，不是 `AUTHORIZATION`，也不在查询串。
   *     用错写法时 init.js 不认，等于没传 token。
   * ═══════════════════════════════════════════════════════════════════
   */
  private async completeSsoIfPossible(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
    waitMs = 90_000,
  ): Promise<boolean> {
    try {
      const deadline = Date.now() + waitMs;
      /**
       * 只尝试换票一次。
       *
       * 为什么必须限制：应用中心可能残留**上次的过期 AUTHORIZATION**。
       * 若每轮都拿它去跳 LMS，LMS 的 judgeToken() 判无效后会 logout 并弹回应用中心，
       * 于是形成「跳 LMS → 被弹回 → 再跳 LMS」的空转，把 90 秒等待窗全部耗光。
       * 跳过一次失败后改为**只等用户手工登录**（cookie 值变化即视为新票）。
       */
      let attemptedWith: string | null = null;
      while (Date.now() < deadline) {
        const auth = await this.readAuthCookie(page);
        if (auth && attemptedWith !== auth) {
          attemptedWith = auth;
          await this.enterLmsWithToken(page, auth);
        }
        if (safeUrl(page).includes(HOST)) return true;
        await page.waitForTimeout(2_000);
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 用 hash 里的 `token` 进入 LMS 课程列表（前端会把 token 落成 AUTHORIZATION cookie）。
   * 已在该 hash 路由上时不做多余导航，避免打断用户。
   */
  private async enterLmsWithToken(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
    token: string,
  ): Promise<void> {
    const target = buildLmsTokenUrl(token);
    const cur = safeUrl(page);
    if (cur.startsWith(`${BASE}/courseweb/ulearning/index.html`) && /[#?&]token=/.test(cur)) return;
    await this.safeGoto(page, target);
    // init.js 在 DOM ready 后写 cookie，并立刻用 /courseapi 校验；留出落地时间。
    await page.waitForTimeout(3_000);
  }

  /** 是否持有中央认证票据（CASTGC）。用于决定能否自动换票，避免让用户白等。 */
  private async hasCasTicket(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
  ): Promise<boolean> {
    try {
      const cookies = await page.context().cookies();
      return cookies.some((c) => c.name === 'CASTGC' && Boolean(c.value));
    } catch {
      return false;
    }
  }

  /** 读取 AUTHORIZATION cookie（只读取值，不落盘、不打日志）。 */
  private async readAuthCookie(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
  ): Promise<string | null> {
    try {
      const cookies = await page.context().cookies();
      const c = cookies.find((x) => x.name === 'AUTHORIZATION');
      return c?.value ? c.value : null;
    } catch {
      return null;
    }
  }

  /**
   * 用 LMS 官方探活接口校验 token 是否有效（无副作用）。
   *
   * 实测：`GET /courseapi/users/isValidToken/<token>` 返回裸 `true` / `false`（HTTP 200）。
   * 依据 `model/User.js` 的 `judgeToken()`，LMS 前端自己也是这么判的。
   */
  private async isTokenValid(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
    token: string,
  ): Promise<boolean> {
    const r = await this.lmsGet(page, `/courseapi/users/isValidToken/${encodeURIComponent(token)}`);
    if (r.status !== 200) return false;
    // 响应可能是裸布尔，也可能是被包装过的 JSON；两种都认。
    if (r.body === true) return true;
    if (typeof r.body === 'object' && r.body !== null) {
      const v = (r.body as { data?: unknown }).data;
      return v === true;
    }
    return false;
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
        // 页面被 LMS 弹去非 LMS 源（401 → timeout.html → 应用中心）时，
        // 同源 fetch 会打到别的源上得到 404/0，这同样是「未登录」而非「接口坏了」。
        return needsLogin(this.lastSuccessAt, now);
      }

      // 【关键】HTTP 200 但页面渲染的是「网络错误，点击重新加载」= token 无效的兜底 UI。
      // 若不识别，就会把「登录已失效」当成「已连接」，然后在同步时才莫名失败。
      if (await this.detectNetworkError(page)) {
        return needsLogin(this.lastSuccessAt, now, {
          stale: true,
        });
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
   * 单门课失败不影响其它课程，但**必须**通过 `complete=false` + `warnings` 表达，
   * 不能把"没读到"当成"没有作业"。
   */
  async listAssignments(options: ListOptions = {}): Promise<ListItemsResult<Assignment>> {
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
    const warnings: string[] = [];
    const maxCourses = options.maxCourses ?? 40;
    let complete = true;

    for (const course of courses.slice(0, maxCourses)) {
      let rows: LmsHomeworkRow[];
      try {
        rows = await this.listCourseHomeworks(page, course.id);
      } catch (err) {
        // 单门课失败 ⇒ 降级但不整体失败（保留其它课程结果），同时如实标记 complete=false。
        complete = false;
        warnings.push(
          `课程「${course.name ?? course.id}」作业读取失败：${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
        );
        continue;
      }
      for (const row of rows) {
        const a = this.normalizeHomework(course, row, lastSyncAt);
        if (a) out.push(a);
        else warnings.push(`课程「${course.name ?? course.id}」有作业标题为空，已跳过`);
      }
    }

    if (courses.length > maxCourses) {
      complete = false;
      warnings.push(`课程数量 ${courses.length} 超过单次上限 ${maxCourses}，已截断`);
    }

    out.sort((x, y) => {
      const xd = x.dueAt ? Date.parse(x.dueAt) : Number.MAX_SAFE_INTEGER;
      const yd = y.dueAt ? Date.parse(y.dueAt) : Number.MAX_SAFE_INTEGER;
      if (xd !== yd) return xd - yd;
      return x.title.localeCompare(y.title, 'zh-CN');
    });

    return { items: out, complete, warnings };
  }

  /**
   * 读取考试**场次**列表（docs/LMS-EXAM-PLAN.md §6.4）。
   *
   * ═══════════════════════════════════════════════════════════════════
   * ⚠️ 整段未验证：真实考试列表响应从未拿到（2026-11-10 复核 LMS 会话 needs_login，
   * 两条候选接口均 401 `{code:2001}`）。字段名全部来自前端 bundle 静态阅读
   * （investigation/lms/exam-evidence.md §B）。调用方默认关闭（examSyncEnabled=false）。
   * ═══════════════════════════════════════════════════════════════════
   *
   * 策略（对齐 §6.4，刻意不先判 `hasMenu(54)` —— 其响应形状未验证 C.4）：
   *   1. 先打新分支 `/utestapi/exams/student`；
   *   2. 404 / 非 JSON / 业务码表明"无此接口" ⇒ 回退旧分支 `/courseapi/exams/student`；
   *   3. 401/403 或业务码 2001/2101/2201 ⇒ **抛错**（会话失效，不逐课程重试）；
   *   4. 两条都失败 ⇒ 该课程计 warning；全部课程都失败 ⇒ 抛 `parse_error`；
   *   5. 容器识别不了 `examList` ⇒ 抛 `parse_error`（**绝不能**返回空数组）。
   *
   * 只读：全部为 GET（经 `lmsGet`，它只做 fetch，无 method 覆写）。
   */
  async listExams(options: ListOptions = {}): Promise<ListItemsResult<ExamItem>> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const page = await this.session.getPage(HOST);
    page.setDefaultTimeout(timeoutMs);

    // 会话前置检查（复用现有实现，已实测可用）。
    const status = await this.checkSession();
    if (status.state !== 'connected') {
      throw new LmsExamSessionExpiredError(`${status.state}: ${status.message}`);
    }

    // 课程列表必须走 /courseapi（实测：/utestapi 下没有课程列表，证据表 A.5）。
    const courses = await this.listCourses(page);
    if (!courses) {
      throw new LmsExamParseError('课程列表结构无法识别');
    }

    const lastSyncAt = new Date().toISOString();
    const items: ExamItem[] = [];
    const warnings: string[] = [];
    const maxCourses = options.maxCourses ?? 40;
    const courseList = courses.slice(0, Math.max(0, maxCourses));
    let complete = courses.length <= courseList.length;
    if (!complete) {
      warnings.push(`课程数量 ${courses.length} 超过单次上限 ${maxCourses}，考试只读取了前 ${courseList.length} 门`);
    }

    /** 至少有一个课程成功解析出合法容器，才允许返回 0 条 = "确认没有考试"。 */
    let anyCourseParsed = false;
    /** 每个课程最后一次失败原因（用于全失败时汇总报错）。 */
    const failures: string[] = [];

    for (const course of courseList) {
      const label = course.name ?? String(course.id);
      try {
        const rows = await this.listCourseExamRows(page, course.id);
        // 容器解析成功（哪怕 examList 为空）⇒ 该课程这侧可信。
        anyCourseParsed = true;
        const normalized = normalizeExamItems(
          { id: course.id, name: course.name ?? null },
          rows,
          lastSyncAt,
        );
        items.push(...normalized.items);
        warnings.push(...normalized.warnings.map((w) => `[${label}] ${w}`));
      } catch (err) {
        if (err instanceof LmsExamSessionExpiredError) throw err; // 会话失效：整次失败
        complete = false;
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${label}: ${msg.slice(0, 140)}`);
        warnings.push(`课程「${label}」考试读取失败：${msg.slice(0, 140)}`);
      }
    }

    // 所有课程都没能解析出容器 ⇒ 这是"读不懂"，不是"没有考试"。
    if (!anyCourseParsed && courseList.length > 0) {
      throw new LmsExamParseError(
        `全部 ${courseList.length} 门课程的考试列表都无法解析（可能两条候选接口都不存在或响应形状改变）：` +
          failures.slice(0, 3).join('；'),
      );
    }

    items.sort((x, y) => {
      const xs = x.startsAt ? Date.parse(x.startsAt) : Number.MAX_SAFE_INTEGER;
      const ys = y.startsAt ? Date.parse(y.startsAt) : Number.MAX_SAFE_INTEGER;
      if (xs !== ys) return xs - ys;
      return x.title.localeCompare(y.title, 'zh-CN');
    });

    return { items, complete, warnings };
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
   * 读取某门课程的考试行（先新分支、后旧分支）。
   *
   * ═══════════════════════════════════════════════════════════════════
   * ⚠️ 未验证：两条候选接口的**存在性与响应形状**都未拿到真实响应。
   *    - 新分支 `/utestapi/exams/student?ocId=&pn=&ps=`（`Exam.js:1786`，代码证据）
   *    - 旧分支 `/courseapi/exams/student?ocId=&keyword=&pn=&ps=&lang=zh`（`Exam.js:150`，代码证据）
   *    未登录直连实测两者均 401 `{code:2001}`（只证明 `exams/**` handler 组存在，
   *    不证明 `/exams/student` 这个具体 handler 存在 —— 证据表 A.3/A.4）。
   * ═══════════════════════════════════════════════════════════════════
   *
   * @throws LmsExamSessionExpiredError 401/403 或业务码 2001/2101/2201（必须整次失败）
   * @throws LmsExamParseError 两条分支都拿不到可解析容器
   */
  async listCourseExamRows(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
    courseId: number,
    pageSize = 20,
  ): Promise<LmsExamRow[]> {
    return fetchExamRowsWithFallback(
      (path) => this.lmsGet(page, path),
      courseId,
      pageSize,
    );
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
      kind: 'homework',
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

  /**
   * 识别 LMS 的「网络错误，点击重新加载」兜底页。
   *
   * 这不是断网：该文案来自 `courseweb/common/nls/public.js` 的 `netError`，
   * 是 `/courseapi/*` 拿不到有效 token 时课程列表请求失败渲染的 UI。
   * 把它识别为「登录失效」而不是「网络不可达」，用户才知道该去重新登录。
   */
  private async detectNetworkError(
    page: Awaited<ReturnType<BrowserSession['getPage']>>,
  ): Promise<boolean> {
    try {
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? '');
      return NETWORK_ERROR_MARKERS.every((m) => text.includes(m));
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

/**
 * 考试列表的「先新后旧」双分支拉取（docs/LMS-EXAM-PLAN.md §6.4）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ 未验证：两条候选接口的**存在性与响应形状**都未拿到真实响应。
 *    - 新分支 `/utestapi/exams/student?ocId=&pn=&ps=`（`Exam.js:1786`，代码证据）
 *    - 旧分支 `/courseapi/exams/student?ocId=&keyword=&pn=&ps=&lang=zh`（`Exam.js:150`，代码证据）
 *    未登录直连实测两者均 401 `{code:2001}`（只证明 `exams/**` handler 组存在，
 *    不证明 `/exams/student` 这个具体 handler 存在 —— 证据表 A.3/A.4）。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 为什么是「先新后旧、失败回退」而不是「先判 `hasMenu(54)` 再选分支」：
 * 判分支要多一次 GET，且 `hasMenu` 的响应形状未验证（C.4）；回退策略不需要理解它的语义。
 *
 * 抽成独立函数（而非私有方法）以便注入请求函数做单测 —— 分支回退是 §6.4 的核心逻辑，
 * 不能因为没有真实登录态就完全不测。
 *
 * @param get 发 GET 并返回 `{status, body}`（生产环境是 `lmsGet`）
 * @throws LmsExamSessionExpiredError 401/403 或业务码 2001/2101/2201 ⇒ 必须整次同步失败
 * @throws LmsExamParseError 两条分支都拿不到可解析容器（**绝不**退化为空数组）
 */
export async function fetchExamRowsWithFallback(
  get: (path: string) => Promise<{ status: number; body: unknown }>,
  courseId: number,
  pageSize = 20,
): Promise<LmsExamRow[]> {
  const candidates = [
    // 新分支：UTEST_API_HOST + '/exams/student'
    // （不是 /utest/ —— 证据表 B.8 已明确 /utest/ 是答题 SPA，不是列表页）
    `/utestapi/exams/student?ocId=${courseId}&pn=1&ps=${pageSize}`,
    // 旧分支：API_SERVER_HOST + '/exams/student'
    `/courseapi/exams/student?ocId=${courseId}&keyword=&pn=1&ps=${pageSize}&lang=zh`,
  ] as const;

  const errors: string[] = [];

  for (const [index, path] of candidates.entries()) {
    const res = await get(path);

    // 会话失效：立即抛错，不逐课程重试（§6.4 c）。
    const bizCode = bizCodeOf(res.body);
    if (res.status === 401 || res.status === 403) {
      throw new LmsExamSessionExpiredError(`HTTP ${res.status}`);
    }
    if (bizCode === 2001 || bizCode === 2101 || bizCode === 2201) {
      throw new LmsExamSessionExpiredError(`业务码 ${bizCode}（token 缺失/过期）`);
    }

    const label = index === 0 ? 'utestapi' : 'courseapi';

    // 404 / 非 JSON 明确表示"这条分支没有此接口" ⇒ 回退下一条。
    if (res.status === 404 || (res.status === 200 && res.body === null)) {
      errors.push(`${label} 分支 HTTP ${res.status}${res.body === null ? ' 且响应非 JSON' : ''}`);
      continue;
    }
    if (res.status !== 200) {
      errors.push(`${label} 分支 HTTP ${res.status}`);
      continue;
    }

    // 容器识别不了会抛 LmsExamParseError：新分支继续回退，旧分支是最后一条 ⇒ 直接抛。
    try {
      return extractExamRows(res.body);
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      if (index === 0) continue;
      throw err;
    }
  }

  throw new LmsExamParseError(
    `课程 ${courseId} 的两条候选考试接口均不可用：${errors.join('；').slice(0, 240)}`,
  );
}

/** 安全读取当前 URL。 */
function safeUrl(page: { url(): string }): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

/**
 * 从响应体里取业务码（未验证：LMS 的业务码字段名 —— 实测 401 响应体为 `{code:2001}`，
 * 沿用该字段名；其它错误形态可能不带 code）。
 */
function bizCodeOf(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

function needsLogin(
  lastSuccessAt: string | null,
  now: string,
  opts: { stale?: boolean } = {},
): SessionStatus {
  return {
    source: SOURCE,
    state: 'needs_login',
    message: opts.stale
      ? '优学院登录态已失效（页面显示「网络错误，点击重新加载」即为登录失效，不是断网）。' +
        '请点「登录」重新完成莞工中央认证，然后点「立即同步」。'
      : '尚未登录优学院。请点「登录」打开应用中心完成莞工中央认证' +
        '（需填验证码；新设备还会要求短信二次验证），然后回到本应用点「立即同步」。',
    lastSuccessAt,
    lastAttemptAt: now,
    requiresUserAction: true,
  };
}

/** 当前页面所处站点（用 URL 判断，纯函数以便单测）。 */
export type LmsPageLocation = 'lms' | 'cas' | 'portal' | 'other';

export function classifyLmsLocation(url: string): LmsPageLocation {
  if (url.includes('lms.dgut.edu.cn')) return 'lms';
  if (url.includes('auth.dgut.edu.cn')) return 'cas';
  if (url.includes('application.dgut.edu.cn')) return 'portal';
  return 'other';
}

/**
 * 决定「点登录」时该把窗口导航到哪里。
 *
 * 这是本文件最容易被改错的一处，故抽成纯函数并加单测保护：
 *  · `lms`    → 应用中心登录页（用户已停在坏页面，必须主动带走；
 *               旧实现把它留在原页并提示"点右上角登录"，而那个入口正是 404 的 /sld/pc.html）
 *  · `cas`    → 不导航（用户正在填验证码，打断会丢状态）
 *  · `portal` → 不导航（已在唯一可用入口）
 *  · `other`  → 应用中心登录页（首次使用 / about:blank）
 *
 * **任何情况下都不返回 /sld/pc.html**（该目录已 404，见 docs/PLATFORM_FINDINGS.md）。
 */
export function resolveLmsLoginTarget(url: string): string | null {
  const loc = classifyLmsLocation(url);
  if (loc === 'cas' || loc === 'portal') return null;
  return PORTAL_LOGIN;
}

/**
 * 构造「带 token 免密进入 LMS」的 URL。
 *
 * 【实测关键】参数名是 `token` 且**必须在 hash 段**（`init.js` 用 `getHashParam("token")`）；
 * 写成 `?AUTHORIZATION=` 或在查询串里都不生效 —— 这正是旧版「点立即同步 → 网络错误」的成因。
 * 桩验证见 docs/TESTING.md「2026-11-11 LMS 登录跳转修复」。
 */
export function buildLmsTokenUrl(token: string): string {
  return `${LMS_HOME}?token=${encodeURIComponent(token)}`;
}

