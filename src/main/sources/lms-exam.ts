/**
 * 优学院 LMS「考试」列表的**纯归一化层**（不碰网络、不碰 Playwright，可单测）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ 本文件全部字段**未验证**（unverified）
 * ═══════════════════════════════════════════════════════════════════════
 * 证据来源：investigation/lms/exam-evidence.md §B（**代码证据，未实测**）。
 * 真实考试列表响应**从未拿到**：2026-11-10 复核 LMS 会话为 needs_login，
 * `/courseapi|utestapi/exams/student` 均返回 401 `{code:2001}`。
 * 因此：
 *   1. 每个字段访问都标「未验证」，不得当作事实；
 *   2. 容器识别不了 ⇒ 抛 `LmsExamParseError`（`parse_error`），**绝不返回空数组**
 *      （把"读不懂"渲染成"没有考试"直接违反 AGENTS.md 红线 3）；
 *   3. 时间解析用 `parseExamTime()` 双格式探测，解析失败 ⇒ `startsAt=null` + warning，
 *      不猜、不用考试级时间兜底、不补 00:00（docs/LMS-EXAM-PLAN.md §4.5、§5.9）。
 *
 * 身份规则（§4.3）：
 *   场次唯一标识字段名**未验证**（`batchId`/`roomId` 在全部已下载 bundle 中 grep 命中 0 次），
 *   故 `sourceAssignmentId = exam:<examId>@<场次开始毫秒>`；开始时间未知时为 `exam:<examId>@nostart`，
 *   且**每场考试至多一条** `@nostart`（否则多条未知场次会撞同一个 id）。
 */

import type { ExamItem, SourceId } from '@dgut-deadline/shared';
import { assignmentId, examSourceId, isAllowedDetailUrl, parseExamTime } from '@dgut-deadline/shared';

const SOURCE: SourceId = 'ulearning';
const BASE = 'https://lms.dgut.edu.cn';

/** 容器/响应无法识别。必须映射为 `failed / parse_error`，绝不能变成 empty。 */
export class LmsExamParseError extends Error {
  constructor(message: string) {
    super(`parse_error: ${message}`);
    this.name = 'LmsExamParseError';
  }
}

/** 会话失效（HTTP 401/403 或业务码 2001/2101/2201）。整次同步必须失败，不得逐课程重试。 */
export class LmsExamSessionExpiredError extends Error {
  constructor(message: string) {
    super(`401 unauthorized: ${message}`);
    this.name = 'LmsExamSessionExpiredError';
  }
}

/**
 * 考试行（`examList[]` 每项）。
 *
 * 未验证（证据表 B.2）：字段名来自前端 bundle 静态阅读
 * （`module_course_exam_examController.js:83-234`），类型与取值域**没有真实响应**。
 * 因此全部字段声明为 `unknown`，由归一化函数逐项探测。
 */
export interface LmsExamRow {
  /** 未验证：考试 ID，代码里作为 `Exam.id`（bundle `:116`/`:139`）。类型可能是数字或字符串。 */
  examId?: unknown;
  /** 未验证：标题（`:117`/`:140`）。 */
  title?: unknown;
  /**
   * 未验证：考试级开始时间（`:111` 空则置 `""`）。
   * **刻意不用于提醒锚点**：学生端模板从不读它（证据表 B.5），且允许为空。
   */
  startTime?: unknown;
  /** 未验证：考试级结束时间（`:112`）。同上，不用于锚点。 */
  endTime?: unknown;
  /** 2026-11-13 实测验证：已用提交次数（0=未交卷，>=1=已交卷）。 */
  answerTimes?: unknown;
  /** 2026-11-13 实测验证：允许提交次数（配合 isLimitTimes）。 */
  limitTimes?: unknown;
  /** 2026-11-13 实测验证："0"=不限次数，"1"=限制次数。 */
  isLimitTimes?: unknown;
  /** 2026-11-13 实测验证：主观题得分（未交卷时为 null）。 */
  subjective?: unknown;
  /** 2026-11-13 实测验证：客观题得分（未交卷时为 null）。 */
  objective?: unknown;
  /** 未验证：场次列表（`:172-178` 整项透传给 `exam.batchList`）。 */
  examRelationTimeList?: unknown;
  [key: string]: unknown;
}

/** 场次行（`examRelationTimeList[]` 每项）。全部字段未验证（证据表 B.4）。 */
export interface LmsExamBatchRow {
  /** 未验证：场次开始（模板 `exam.html:262`）。类型未知（毫秒 / 字符串）。 */
  startTime?: unknown;
  /** 未验证：场次结束（模板 `:264`）。 */
  endTime?: unknown;
  /** 未验证：考场名（模板 `:267`/`:269-272`）。仅展示。 */
  examRoomName?: unknown;
  /** 未验证：座位号（模板 `:267`/`:273-275`）。仅展示。 */
  seatNo?: unknown;
  /**
   * 未验证（证据表 C.5）：`examRelationId` 只确认出现在**成绩/结果**接口的
   * `examRelationList[]` 里（`exam_gradeController.js:168-175`），是否也出现在
   * 列表接口的 `examRelationTimeList[]` 里**没有任何证据**。
   * 因此字段仅声明、**不参与身份键** —— 身份键保持 `examId + 场次开始毫秒`（§4.3）。
   */
  examRelationId?: unknown;
  [key: string]: unknown;
}

export interface NormalizeExamResult {
  items: ExamItem[];
  warnings: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 安全字符串化（只用于 warning 文案，截断且不打印任何凭证 —— 这里只有业务字段）。 */
function preview(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v.length > 24 ? `${v.slice(0, 24)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `Array(${v.length})`;
  return typeof v;
}

/**
 * 从列表响应体里提取 `examList[]`。
 *
 * 未验证：容器名 `examList` 来自 bundle（`manageResult` 读 `result.examList`），
 * 真实响应可能不同。**识别不了必须抛错**（C.1 的红线对齐要求）。
 */
export function extractExamRows(body: unknown): LmsExamRow[] {
  if (!isRecord(body)) {
    throw new LmsExamParseError('考试列表响应不是 JSON 对象（可能命中 HTML 错误页或网关页）');
  }
  const list = body['examList'];
  if (list === undefined || list === null) {
    throw new LmsExamParseError(
      `考试列表响应中不存在 examList 容器（实际键：${Object.keys(body).slice(0, 8).join(',') || '无'}）；` +
        '字段形状与代码证据不符，需按 investigation/lms/exam-evidence.md §C.1 回填',
    );
  }
  if (!Array.isArray(list)) {
    throw new LmsExamParseError(`examList 不是数组（实际类型 ${typeof list}）`);
  }
  const rows: LmsExamRow[] = [];
  for (const raw of list) {
    if (isRecord(raw)) rows.push(raw as LmsExamRow);
  }
  return rows;
}

/**
 * 解析考试个人交卷状态（2026-11-13 基于 /utestapi/exams/student 实测响应验证）。
 *
 * 实测字段：
 *  - `answerTimes`: number（0 = 未交卷；>=1 = 已交卷次数；优学院词表 `usedTimesNew: "已用提交次数"`）
 *  - `limitTimes`: number（允许提交次数；`isLimitTimes === "0"` 或 `limitTimes <= 0` 表示不限次数）
 *  - `subjective` / `objective`: number | null（主观题/客观题得分；未交卷时均为 null）
 *
 * 保守原则（红线 3）：
 *  - 只有 `answerTimes` 为合法非负数值时才判定 `submitted`（>=1）或 `not_submitted`（===0）；
 *  - 缺失或类型异常时一律 `unknown`，绝不用 `examState`（考试级状态）推断个人是否交卷。
 */
export function resolveExamAttendance(row: LmsExamRow): {
  attendance: ExamItem['attendance'];
  answerTimes: number | null;
  limitTimes: number | null;
  score: number | null;
  evidence: string;
} {
  const rawAns = row.answerTimes;
  if (typeof rawAns !== 'number' || !Number.isFinite(rawAns) || rawAns < 0) {
    return {
      attendance: 'unknown',
      answerTimes: null,
      limitTimes: null,
      score: null,
      evidence: `answerTimes=${preview(rawAns)}（缺失或非有效数值，保守置 unknown）`,
    };
  }

  const answerTimes = Math.floor(rawAns);
  const unlimited =
    row.isLimitTimes === '0' ||
    row.isLimitTimes === 0 ||
    typeof row.limitTimes !== 'number' ||
    !Number.isFinite(row.limitTimes) ||
    row.limitTimes <= 0;
  const limitTimes = unlimited ? null : Math.floor(row.limitTimes as number);

  const hasSub = typeof row.subjective === 'number' && Number.isFinite(row.subjective);
  const hasObj = typeof row.objective === 'number' && Number.isFinite(row.objective);
  const score =
    answerTimes >= 1 && (hasSub || hasObj)
      ? Math.round(
          ((hasSub ? (row.subjective as number) : 0) + (hasObj ? (row.objective as number) : 0)) * 10,
        ) / 10
      : null;

  const attendance: ExamItem['attendance'] = answerTimes >= 1 ? 'submitted' : 'not_submitted';
  const parts = [
    `answerTimes=${answerTimes}`,
    `limitTimes=${limitTimes === null ? 'unlimited' : limitTimes}`,
  ];
  if (score !== null) parts.push(`score=${score}`);

  return {
    attendance,
    answerTimes,
    limitTimes,
    score,
    evidence: parts.join(' '),
  };
}

/**
 * 把一场考试的 `examList[]` 行 + 其 `examRelationTimeList[]` 展开成 **N 条场次项**。
 *
 * 粒度 = 场次（不是考试），理由见证据表 B.5：学生端模板永远 `ko foreach: batchList`，
 * 考试级 `startTime/endTime` 允许为空且从不被学生端读取。
 */
export function normalizeExamItems(
  course: { id: number | string; name?: string | null },
  rows: readonly LmsExamRow[],
  lastSyncAt: string,
): NormalizeExamResult {
  const items: ExamItem[] = [];
  const warnings: string[] = [];
  const courseId = String(course.id);
  const courseName = (course.name ?? null) || null;
  /** 已出现的身份键，用于同 examId + 同场次开始时间的去重。 */
  const seenIds = new Set<string>();

  for (const row of rows) {
    // 未验证：examId 类型（数字/字符串）与是否必填。
    const rawExamId = row.examId;
    const examId =
      typeof rawExamId === 'number' || typeof rawExamId === 'string'
        ? String(rawExamId).trim()
        : '';
    if (!examId) {
      // 没有 examId 就没有稳定身份；不用「课程+标题+时间」兜底（§4.6：兜底键会随标题漂移）。
      warnings.push(`课程「${courseName ?? courseId}」有一条考试缺少 examId（${preview(rawExamId)}），已跳过`);
      continue;
    }

    // 未验证：title 是否必填、空值形态（null / "" / 缺字段）。
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    if (!title) {
      warnings.push(`考试 ${examId} 标题为空，已跳过（不生成空标题条目）`);
      continue;
    }

    const rawBatches = row.examRelationTimeList;
    let batches: LmsExamBatchRow[] = [];
    if (Array.isArray(rawBatches)) {
      batches = rawBatches.filter(isRecord) as LmsExamBatchRow[];
      if (batches.length !== rawBatches.length) {
        warnings.push(`考试 ${examId} 的 examRelationTimeList 有非对象元素，已忽略`);
      }
    } else if (rawBatches !== undefined && rawBatches !== null) {
      warnings.push(
        `考试 ${examId} 的 examRelationTimeList 不是数组（${preview(rawBatches)}），按无场次处理`,
      );
    }

    // 未验证：detailUrl 的 hash 路由是否对学生可直接进入（证据表 §2.7）。
    // 只做 allowlist 校验（协议 + 主机），可达性未验证 ⇒ UI 必须容忍链接失效。
    const detailUrlRaw = `${BASE}/utest/#/exam/${encodeURIComponent(examId)}`;
    const detailUrl = isAllowedDetailUrl(SOURCE, detailUrlRaw) ? detailUrlRaw : null;
    const att = resolveExamAttendance(row);

    let emitted = 0;
    /** 时间未知的场次数（用于 warning）。 */
    let unknownStartBatches = 0;

    for (const batch of batches) {
      // 未验证：场次时间类型（毫秒 / ISO 字符串 / "" / null）。见证据表 C.6/C.7。
      const start = parseExamTime(batch.startTime);
      const end = parseExamTime(batch.endTime);

      // 未验证：考场/座位字段名与类型（证据表 B.4，仅确认 examRoomName / seatNo）。
      const roomName = typeof batch.examRoomName === 'string' ? batch.examRoomName.trim() : null;
      const seatNo =
        typeof batch.seatNo === 'string' || typeof batch.seatNo === 'number'
          ? String(batch.seatNo).trim() || null
          : null;
      const venue =
        roomName || seatNo ? { roomName: roomName || null, seatNo: seatNo || null } : null;

      if (start === null) {
        // 不猜开始时间；先累计，最后统一生成一条 @nostart 兜底项。
        unknownStartBatches++;
        continue;
      }

      const startMs = Date.parse(start.iso);
      const sourceAssignmentId = examSourceId(examId, Number.isNaN(startMs) ? null : startMs);
      const id = assignmentId(SOURCE, sourceAssignmentId);
      if (seenIds.has(id)) {
        warnings.push(`考试 ${examId} 存在重复场次（同一开始时间），已去重`);
        continue;
      }
      seenIds.add(id);

      if (end === null) {
        warnings.push(`考试 ${examId} 的场次结束时间无法解析，endsAt=null（不猜）`);
      }

      items.push({
        kind: 'exam',
        source: SOURCE,
        sourceAssignmentId,
        id,
        courseId,
        courseName,
        title,
        detailUrl,
        examId,
        startsAt: start.iso,
        endsAt: end?.iso ?? null,
        timePrecision: 'datetime',
        venue,
        attendance: att.attendance,
        attendanceEvidence: att.evidence,
        answerTimes: att.answerTimes,
        limitTimes: att.limitTimes,
        score: att.score,
        firstSeenAt: lastSyncAt,
        lastSeenAt: lastSyncAt,
        lastSyncAt,
        sourceUpdatedAt: null,
      });
      emitted++;
    }

    // 一个场次都没能定出锚点（场次列表为空，或所有场次时间都解析失败）：
    // 生成**一条** @nostart 兜底项 —— 仅用于"让用户看见有这场考试"，不参与任何阈值提醒
    // （§5.2：无锚点不得推算提醒时刻）。每场考试至多一条（§4.3 规则 3），
    // 否则 N 个未知场次会撞同一个 id。
    //
    // 注意：只有"完全看不见这场考试"时才兜底。若已有部分场次可展示，
    // 再补一条 @nostart 会在列表里制造同名的重复行，反而误导用户；
    // 这些被跳过的场次改为 warning 明示（不静默丢弃）。
    const noBatchAtAll = batches.length === 0;
    if (emitted === 0) {
      const sourceAssignmentId = examSourceId(examId, null);
      const id = assignmentId(SOURCE, sourceAssignmentId);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        items.push({
          kind: 'exam',
          source: SOURCE,
          sourceAssignmentId,
          id,
          courseId,
          courseName,
          title,
          detailUrl,
          examId,
          startsAt: null,
          endsAt: null,
          timePrecision: 'none',
          venue: null,
          attendance: att.attendance,
          attendanceEvidence: att.evidence,
          answerTimes: att.answerTimes,
          limitTimes: att.limitTimes,
          score: att.score,
          firstSeenAt: lastSyncAt,
          lastSeenAt: lastSyncAt,
          lastSyncAt,
          sourceUpdatedAt: null,
        });
      }
    }

    if (noBatchAtAll) {
      // 未验证：考试级 startTime/endTime 可能存在，但按 §5.9 明确**不用它兜底场次时间**。
      const hasExamLevelTime =
        parseExamTime(row.startTime) !== null || parseExamTime(row.endTime) !== null;
      warnings.push(
        `考试 ${examId} 无场次信息（examRelationTimeList 为空/缺失）` +
          (hasExamLevelTime
            ? '；考试级时间存在但按设计不使用（学生端模板亦不读取），故不生成提醒'
            : '；也没有可用的考试级时间，故不生成提醒'),
      );
    } else if (unknownStartBatches > 0) {
      warnings.push(
        `考试 ${examId} 有 ${unknownStartBatches} 个场次的开始时间无法解析，已跳过这些场次` +
          (emitted === 0
            ? '（全部场次都不可用，已折成一条「时间未知」条目，不提醒）'
            : '（其余场次已正常列出）'),
      );
    }
  }

  // 排序：有开始时间的按时间升序；时间未知的置底（与作业侧一致）。
  items.sort((x, y) => {
    const xs = x.startsAt ? Date.parse(x.startsAt) : Number.MAX_SAFE_INTEGER;
    const ys = y.startsAt ? Date.parse(y.startsAt) : Number.MAX_SAFE_INTEGER;
    if (xs !== ys) return xs - ys;
    return x.title.localeCompare(y.title, 'zh-CN');
  });

  return { items, warnings };
}
