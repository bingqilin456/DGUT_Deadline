/**
 * 列表行的**表现层纯逻辑**（可单测）：类型徽标、时间文案、剩余文案、状态文案、行样式。
 *
 * 为什么单独抽一层：
 *  - 模板里直接做 `a.kind === 'exam' ? a.startsAt : a.dueAt` 这类判别联合收窄在
 *    Vue 模板类型检查里不可靠，容易退化成 any 或漏判；
 *  - 状态文案是**红线**（考试绝不能出现「未参加/未提交/已提交」），
 *    必须能被单测逐个断言，而不是埋在模板字符串里。
 *
 * ⚠️ 分类依据是**接口来源模块**（`kind` 字段），本文件不按标题文字判断条目性质。
 *    用户 2026-11-11 原话：「在作业模块出现的不管叫什么都算作作业 tab，
 *    在考试模块出现的不管叫什么都算作考试 tab。」
 */

import type { UiAssignment } from '../../../shared/ipc';
import {
  dueToMs as toMs,
  examPhase as sharedExamPhase,
  formatRemaining,
  type ExamPhase as SharedExamPhase,
} from '@dgut-deadline/shared';

/**
 * 考试阶段：**复用 packages/shared 的单一实现**。
 *
 * 此前渲染层与主进程各写一份语义等价的函数、靠注释约定同步 —— 会漂移
 * （列表说"进行中"、提醒说"已结束"）。现在统一从 `@dgut-deadline/shared` 取，
 * 渲染产物只带这一个纯函数，不污染打包边界（packages/shared 是纯 TS、无 Node/Electron 依赖）。
 */
export const examPhase = sharedExamPhase;
export type ExamPhase = SharedExamPhase;
export const dueToMs = toMs;

/** 统一格式化为 Asia/Shanghai 本地时间文本。 */
export function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const ms = dueToMs(iso);
  if (ms === null) return '';
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

/** 时长的人类可读描述（用于「距开考」「进行中剩」）。 */
export function spanText(ms: number): string {
  const day = 24 * 3600 * 1000;
  const hour = 3600 * 1000;
  const min = 60 * 1000;
  const abs = Math.abs(ms);
  if (abs >= day) {
    const d = Math.floor(abs / day);
    const h = Math.floor((abs % day) / hour);
    return `${d} 天 ${h} 小时`;
  }
  if (abs >= hour) {
    const h = Math.floor(abs / hour);
    const m = Math.floor((abs % hour) / min);
    return `${h} 小时 ${m} 分`;
  }
  return `${Math.max(1, Math.floor(abs / min))} 分钟`;
}

export interface Badge {
  text: string;
  cls: 'ok' | 'warn' | 'bad' | 'muted' | 'exam';
  /** 悬停说明，用于解释「为什么这里是未知」。 */
  title?: string;
}

/** 类型徽标：作业（灰）/ 考试（强调色）。 */
export function kindBadge(a: UiAssignment): Badge {
  return a.kind === 'exam'
    ? { text: '考试', cls: 'exam', title: '来自平台的「考试」模块' }
    : { text: '作业', cls: 'muted', title: '来自平台的「作业」模块' };
}

/** 时间列：作业一行（截止），考试两行（开考 + 结束）。 */
export interface TimeCell {
  primary: string;
  secondary: string | null;
  /** 时间未知/不确定（UI 必须显式表达，不能伪装成确定）。 */
  ambiguous: boolean;
}

export function timeCell(a: UiAssignment): TimeCell {
  if (a.kind !== 'exam') {
    if (!a.dueAt) return { primary: '待确认', secondary: null, ambiguous: true };
    const s = formatWhen(a.dueAt);
    return {
      primary: a.duePrecision === 'date' ? `${s.slice(0, 10)}（时间待确认）` : s,
      secondary: null,
      ambiguous: a.duePrecision !== 'datetime',
    };
  }

  // 考试时间来自**未验证**字段（见 investigation/lms/exam-evidence.md §C），
  // 因此未知时必须写明「未提供」，绝不补一个猜测时间。
  const start = formatWhen(a.startsAt);
  const end = formatWhen(a.endsAt);
  const ambiguous = a.timePrecision !== 'datetime';
  return {
    primary: start ? `开考 ${start}` : '开考时间未提供',
    secondary: end ? `结束 ${end}` : '结束时间未提供',
    ambiguous,
  };
}

/** 剩余列。作业沿用 formatRemaining（行为与改造前逐字相同）；考试按阶段分支。 */
export function remainingCell(a: UiAssignment, nowMs: number): { text: string; cls: Badge['cls']; title?: string } {
  if (a.kind !== 'exam') {
    const d = dueToMs(a.dueAt);
    return {
      text: formatRemaining(nowMs, d, a.duePrecision),
      cls: d === null ? 'muted' : d - nowMs < 0 ? 'bad' : d - nowMs <= 24 * 3600 * 1000 ? 'warn' : 'muted',
    };
  }

  const phase = examPhase(a, nowMs);
  const s = dueToMs(a.startsAt);
  const e = dueToMs(a.endsAt);

  if (phase === 'unknown' || s === null) {
    return { text: '时间未知', cls: 'muted', title: '平台未提供可用的考试时间，无法计算倒计时' };
  }
  if (phase === 'upcoming') {
    const diff = s - nowMs;
    return {
      text: `距开考 ${spanText(diff)}`,
      cls: diff <= 24 * 3600 * 1000 ? 'warn' : 'muted',
    };
  }
  if (phase === 'ongoing') {
    if (e === null) {
      return { text: '进行中（结束时间未知）', cls: 'exam', title: '平台未提供结束时间，无法计算剩余时长' };
    }
    return { text: `进行中（剩 ${spanText(e - nowMs)}）`, cls: 'exam' };
  }
  return { text: '已结束', cls: 'muted' };
}

/**
 * 状态列。
 *
 * 红线（AGENTS.md 红线 3 的可见化）：考试行**只允许**
 * 「未知 / 未开始 / 进行中 / 已结束 / 时间未知」。
 * 绝对不能出现「未参加」「未提交」「已提交」—— 平台没有提供可信的参加状态字段，
 * 写了就是伪造。
 */
export function statusCell(a: UiAssignment, nowMs: number): Badge {
  if (a.kind !== 'exam') {
    // 作业：与改造前完全一致
    if (a.submissionStatus === 'submitted') return { text: '已提交', cls: 'ok' };
    if (a.submissionStatus === 'not_submitted') {
      const d = dueToMs(a.dueAt);
      if (d !== null && d < nowMs) return { text: '已截止·未提交', cls: 'bad' };
      return { text: '未提交', cls: 'warn' };
    }
    if (a.submissionStatus === 'overdue') return { text: '已逾期', cls: 'bad' };
    return { text: '状态待确认', cls: 'muted' };
  }

  const phase = examPhase(a, nowMs);
  if (phase === 'unknown') {
    return {
      text: '时间未知',
      cls: 'muted',
      title: '平台未提供可用的考试时间，无法判断阶段',
    };
  }
  if (phase === 'upcoming') return { text: '未开始', cls: 'muted', title: '由本地时间推导，未开始' };
  if (phase === 'ongoing') return { text: '进行中', cls: 'exam', title: '由本地时间推导，正在考试时段内' };
  return { text: '已结束', cls: 'muted', title: '由本地时间推导，考试时段已过' };
}

/**
 * 参加/交卷状态徽标（仅考试）。
 *
 * 2026-11-13 基于 `/utestapi/exams/student` 实测响应接入：
 *  - `submitted`（`answerTimes >= 1`）：显示「已交卷 X/Y」（不限次数显示「已交卷 X次」），悬停显示得分；
 *  - `not_submitted`（`answerTimes === 0`）：显示「未交卷 0/Y」（不限次数显示「未交卷」）；
 *  - `unknown`（字段缺失）：保守显示「参加状态未知」，不做推断。
 */
export function attendanceBadge(a: UiAssignment): Badge | null {
  if (a.kind !== 'exam') return null;

  const ans = typeof a.answerTimes === 'number' && Number.isFinite(a.answerTimes) ? a.answerTimes : null;
  const lim =
    typeof a.limitTimes === 'number' && Number.isFinite(a.limitTimes) && a.limitTimes > 0
      ? a.limitTimes
      : null;

  if (a.attendance === 'submitted') {
    const text =
      ans !== null && lim !== null
        ? `已交卷 ${ans}/${lim}`
        : ans !== null
          ? `已交卷 ${ans}次`
          : '已交卷';
    const title =
      typeof a.score === 'number' && Number.isFinite(a.score)
        ? `得分：${a.score} 分（${a.attendanceEvidence}）`
        : `已交卷（${a.attendanceEvidence}）`;
    return { text, cls: 'ok', title };
  }

  if (a.attendance === 'not_submitted') {
    const text = ans !== null && lim !== null ? `未交卷 ${ans}/${lim}` : '未交卷';
    return {
      text,
      cls: 'warn',
      title: `尚未交卷（${a.attendanceEvidence}）`,
    };
  }

  return {
    text: '参加状态未知',
    cls: 'muted',
    title: '平台未提供可靠的参加状态字段，本应用不做推断。请以优学院页面为准。',
  };
}

/** 行样式：考试行不复用作业的 row-pending/row-submitted（那依赖 submissionStatus）。 */
export function rowClass(a: UiAssignment, nowMs: number): string {
  if (a.kind !== 'exam') {
    const rem = remainingCell(a, nowMs);
    return [
      a.submissionStatus === 'not_submitted' ? 'row-pending' : '',
      a.submissionStatus === 'submitted' ? 'row-submitted' : '',
      a.submissionStatus !== 'submitted' && rem.cls === 'warn' ? 'row-urgent' : '',
      a.submissionStatus !== 'submitted' && rem.cls === 'bad' ? 'row-overdue' : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  const phase = examPhase(a, nowMs);
  return phase === 'ongoing' ? 'row-exam-ongoing' : phase === 'ended' ? 'row-exam-ended' : 'row-exam-upcoming';
}
