/**
 * 优学院 LMS「考试」接口只读探针。
 *
 * 目的：为「把考试纳入提醒」提供真实响应结构（字段名 + 类型 + 值域），
 *      而不是把前端代码推断当成实测事实。
 *
 * 红线（本脚本强制遵守）：
 *  - 只发 GET。脚本里没有任何 POST/PUT/DELETE/PATCH。
 *  - 不读取、不打印、不落盘任何 Cookie / Token / Authorization 值。
 *    鉴权头由**受控浏览器页面自身**在 fetch 时带上（同源 + credentials:'include'），
 *    值从不经过 Node 进程；本脚本也从不把 header 内容读出。
 *  - 不登录、不解验证码、不读用户日常浏览器 Cookie。若会话已过期，本脚本
 *    只会输出「未登录」分类，绝不伪造数据。
 *  - 默认使用**临时 profile**（%TEMP%），不碰应用的真实 profile，
 *    以免与正在运行的 Electron 争抢 Edge 用户目录。
 *
 * 用法：
 *   node scripts/probe-lms-exam.mjs                  # 临时 profile，无登录态 → 只验证路由存活
 *   node scripts/probe-lms-exam.mjs --profile <dir>  # 指定已登录的 profile 目录（只读，不写凭证）
 *   node scripts/probe-lms-exam.mjs --oc-id 141568    # 指定课程 ocId（默认用课程列表第一门）
 *   node scripts/probe-lms-exam.mjs --json            # 只输出机器可读 JSON
 *
 * 输出：结构摘要打印到 stdout；原始响应（脱敏后）写入 investigation/lms/exam-probe-result.json
 * 退出码：0=至少一个接口拿到 200 业务响应；2=全部未登录/失败（属预期，见 docs）
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 本机 shell 有 NODE_OPTIONS=--require worker-events.cjs 污染，先自清一次
process.env['NODE_OPTIONS'] = '';

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'investigation', 'lms');
const OUT_FILE = join(OUT_DIR, 'exam-probe-result.json');
const BASE = 'https://lms.dgut.edu.cn';

// 只读接口清单（全部来自 investigation/lms/Exam.js 的 GET 调用）
const ENDPOINTS = [
  {
    id: 'courses',
    label: '学生课程列表（拿 ocId）',
    path: '/courseapi/courses/students?keyword=&publishStatus=1&type=1&pn=1&ps=15&lang=zh',
  },
  {
    id: 'examListLegacy',
    label: '考试列表·旧分支 (API_SERVER_HOST=/courseapi)',
    path: (ocId) => `/courseapi/exams/student?ocId=${ocId}&keyword=&pn=1&ps=20&lang=zh`,
  },
  {
    id: 'examListNew',
    label: '考试列表·新分支 (UTEST_API_HOST=/utestapi)',
    path: (ocId) => `/utestapi/exams/student?ocId=${ocId}&pn=1&ps=20&lang=zh`,
  },
  {
    id: 'calendar',
    label: '活动日历（activityType=5 即考试）',
    path: () => {
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 864e5);
      const f = (d) => d.toISOString().slice(0, 10);
      return `/courseapi/activitycalendar?startDate=${f(start)}&endDate=${f(end)}`;
    },
  },
  {
    id: 'hasMenu54',
    label: '权限探针：menuId=54（决定学生端走新旧分支）；userId 为占位，仅验路由',
    path: () => '/courseapi/users/menu/hasMenu?menuId=54&userId=1',
  },
];

/** 解析 CLI 参数（最小实现，避免额外依赖）。 */
function parseArgs(argv) {
  const out = { profile: '', ocId: 0, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') out.profile = argv[++i] ?? '';
    else if (a === '--oc-id') out.ocId = Number(argv[++i] ?? 0);
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/**
 * 把未知 JSON 递归压成「字段名 → 类型(+值域样本)」。
 * 只保留结构，不保留任何字符串值（避免姓名 / 教师名 / token 泄漏）。
 */
function shapeOf(value, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return { $type: 'truncated' };
  if (value === null) return { $type: 'null' };
  if (Array.isArray(value)) {
    const sample = value.length ? shapeOf(value[0], depth + 1, maxDepth) : { $type: 'empty' };
    return { $type: 'array', $len: value.length, $item: sample };
  }
  switch (typeof value) {
    case 'number':
      // 时间戳与普通数字都只报「number + 是否像毫秒时间戳」，不报具体值
      return {
        $type: 'number',
        $looksLikeMsEpoch: value > 1e12 && value < 4e12,
        $isInteger: Number.isInteger(value),
      };
    case 'boolean':
      return { $type: 'boolean', $value: value };
    case 'string':
      return { $type: 'string', $len: value.length };
    case 'object': {
      const obj = {};
      for (const k of Object.keys(value)) obj[k] = shapeOf(value[k], depth + 1, maxDepth);
      return { $type: 'object', $fields: obj };
    }
    default:
      return { $type: typeof value };
  }
}

/**
 * 收集「字符串字段的候选值域」——只保留短枚举风格的取值，
 * 且对疑似人名/标题的值只报长度不报内容。
 */
const ENUM_SAFE_KEYS = new Set([
  'examState',
  'state',
  'status',
  'publishStatus',
  'examType',
  'paperType',
  'isLate',
  'isLimitTimes',
  'isInExam',
  'isTooLate',
  'showExamRecord',
  'allExamBatchEnd',
  'notEnoughTime',
  'examFinish',
  'limitTimes',
  'answerTimes',
  'activityType',
]);

function collectEnums(value, bag, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 20)) collectEnums(v, bag, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (ENUM_SAFE_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      (bag[k] ??= new Set()).add(String(v));
    } else {
      collectEnums(v, bag, depth + 1);
    }
  }
}

/** 失败分类：把「未登录/无凭证」与「真的出错」区分开。 */
function classify(status, body) {
  if (status === 0) return 'network_error';
  const code = body && typeof body === 'object' ? body.code : undefined;
  if (status === 401) {
    if (code === 2001) return 'unauthenticated:401/2001(缺少访问token)';
    return `unauthenticated:401${code ? '/' + code : ''}`;
  }
  if (status === 403) return `forbidden:403${code ? '/' + code : ''}`;
  if (status === 404) return 'route_missing:404';
  if (status === 405) return 'route_exists:405(方法不匹配)';
  if (status >= 500) return `server_error:${status}`;
  if (status !== 200) return `http_${status}`;
  if (code === 2001 || code === 2101 || code === 2201) return `unauthenticated:200/${code}`;
  return 'ok:200';
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node scripts/probe-lms-exam.mjs [--profile <dir>] [--oc-id N] [--json]');
    return 0;
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (e) {
    console.log(
      JSON.stringify({ tool: 'unavailable', reason: 'playwright-core 未安装: ' + String(e).slice(0, 120) }),
    );
    return 2;
  }

  // 默认用临时 profile：绝不读写应用的真实 profile，也不碰用户日常浏览器
  const profileDir = args.profile
    ? args.profile
    : join(tmpdir(), 'dgut-lms-exam-probe-profile');
  if (args.profile && !existsSync(profileDir)) {
    console.log(JSON.stringify({ tool: 'bad_profile', reason: '指定的 profile 目录不存在', profileDir }));
    return 2;
  }
  mkdirSync(profileDir, { recursive: true });

  const env = { ...process.env, NODE_OPTIONS: '' };
  let context;
  const result = {
    probedAt: new Date().toISOString(),
    profileMode: args.profile ? 'explicit(只读复用)' : 'temp(无登录态预期)',
    note: '本文件不含任何 cookie/token/authorization；字符串值一律只记长度，不记内容。',
    loginState: 'unknown',
    ocId: args.ocId || null,
    endpoints: [],
    enums: {},
  };

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'msedge',
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeSidebarV2'],
      env,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(30_000);

    // 只打开学生端首页（GET），不使用任何凭证
    await page.goto(`${BASE}/courseweb/ulearning/index.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    /** 在页面上下文里发同源 GET；鉴权头由页面自身逻辑/cookie 提供，不读出值。 */
    const getInPage = async (path) => {
      return page.evaluate(async (p) => {
        const readCookie = (name) => {
          const m = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
          return m ? decodeURIComponent(m[2]) : null;
        };
        const headers = { Accept: 'application/json' };
        // 与 init.js 一致：Authorization 头取自同名 cookie；这里只判断"有没有"，
        // 值不回传 Node，也不打印。
        const hasAuth = !!readCookie('AUTHORIZATION');
        if (hasAuth) {
          headers['Authorization'] = readCookie('AUTHORIZATION');
          headers['version'] = '1';
        }
        try {
          const res = await fetch(p, { method: 'GET', headers, credentials: 'include' });
          const text = await res.text();
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = { $nonJson: true, $len: text.length };
          }
          return { status: res.status, hasAuthHeader: hasAuth, body };
        } catch (err) {
          return { status: 0, hasAuthHeader: hasAuth, body: { $error: String(err).slice(0, 160) } };
        }
      }, path);
    };

    // 1) 课程列表：既判登录态，也拿 ocId
    const coursesEp = ENDPOINTS.find((e) => e.id === 'courses');
    const coursesRaw = await getInPage(coursesEp.path);
    const coursesCls = classify(coursesRaw.status, coursesRaw.body);
    result.endpoints.push({
      id: coursesEp.id,
      label: coursesEp.label,
      url: BASE + coursesEp.path,
      status: coursesRaw.status,
      classification: coursesCls,
      shape: shapeOf(coursesRaw.body),
    });

    let ocId = args.ocId || null;
    if (coursesCls === 'ok:200') {
      result.loginState = 'authenticated';
      const list = coursesRaw.body?.courseList ?? coursesRaw.body?.list ?? [];
      if (!ocId && Array.isArray(list) && list.length > 0) {
        const first = list[0];
        ocId = first?.id ?? first?.ocId ?? first?.courseId ?? null;
      }
    } else if (coursesCls.startsWith('unauthenticated')) {
      result.loginState = 'needs_login';
    } else {
      result.loginState = 'error';
    }
    result.ocId = ocId;

    // 2) 其余接口
    // 未登录时 ocId 拿不到：仍用占位值探「路由是否存活」，并把结果标记为
    // route-only（不能当数据用）。占位值不来自任何真实账号。
    const PLACEHOLDER_OC_ID = 1;
    const usedOcId = ocId ?? PLACEHOLDER_OC_ID;
    for (const ep of ENDPOINTS) {
      if (ep.id === 'courses') continue;
      const path = typeof ep.path === 'function' ? ep.path(usedOcId) : ep.path;
      const routeOnly = ocId === null;
      const raw = await getInPage(path);
      const entry = {
        id: ep.id,
        label: ep.label,
        url: BASE + path,
        status: raw.status,
        classification: classify(raw.status, raw.body),
        routeOnly,
        shape: shapeOf(raw.body),
      };
      result.endpoints.push(entry);

      // 只对 200 的响应收集枚举值域
      if (entry.classification === 'ok:200') {
        const bag = {};
        collectEnums(raw.body, bag);
        for (const [k, set] of Object.entries(bag)) {
          (result.enums[k] ??= new Set());
          for (const v of set) result.enums[k].add(v);
        }
      }
    }
  } catch (err) {
    result.error = String(err).slice(0, 300);
  } finally {
    if (context) await context.close().catch(() => {});
  }

  // Set → 排序数组，便于阅读
  result.enums = Object.fromEntries(
    Object.entries(result.enums).map(([k, v]) => [k, [...v].sort()]),
  );

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[probe-lms-exam] profileMode=${result.profileMode} loginState=${result.loginState} ocId=${result.ocId}`);
    for (const e of result.endpoints) {
      const tag = e.routeOnly ? ' [route-only:无 ocId,仅验路由]' : '';
      console.log(`  ${e.id.padEnd(14)} ${String(e.status).padStart(4)}  ${e.classification}${tag}`);
      console.log(`      ${e.url}`);
    }
    if (Object.keys(result.enums).length) {
      console.log('  值域（仅 200 响应）:');
      for (const [k, v] of Object.entries(result.enums)) console.log(`    ${k} = ${JSON.stringify(v)}`);
    }
    if (result.error) console.log('  异常: ' + result.error);
    console.log(`  结构已写入 ${OUT_FILE}`);
  }

  const anyOk = result.endpoints.some((e) => e.classification === 'ok:200');
  return anyOk ? 0 : 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.log('FATAL ' + String(err).slice(0, 300));
    process.exit(2);
  });
