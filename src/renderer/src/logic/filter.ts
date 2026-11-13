/**
 * 列表的筛选与排序（纯逻辑，可单测）。
 *
 * 产品要求（用户明确指定）：
 *  - 可按「类型 / 平台 / 课程 / 时间 / 剩余 / 状态」筛选
 *  - **默认只看未过期**，且**时间最近的排最前**
 *
 * 类型（kind）维度（用户 2026-11-11 决策）：
 *  - 分类依据 = **接口来源模块**，不是标题内容。
 *    叫「期末考试」但来自作业接口的条目就是作业；叫「第 3 次作业」但来自考试接口的条目就是考试。
 *    ⇒ 本文件**不得**出现任何按标题关键词猜测性质的逻辑。
 *  - 「全部」= 混排（按统一锚点排序，带类型徽标）；「作业」「考试」= 仅作筛选。
 *
 * 两种实体的时间语义不同，统一用共享模型的助手收窄：
 *  - 锚点 anchorOf()：作业 = dueAt（截止），考试 = startsAt（开考）—— **筛选**用
 *  - 结束 endOf()：作业 = dueAt，考试 = endsAt ?? startsAt —— **排序**用
 *
 * 为什么筛选和排序用不同的时间（2026-11-12 用户反馈）：
 *  - 筛选（「今天内」「3 天内」「剩余」）问的是"什么时候开始/到期"，考试按开考时间合理；
 *  - 排序问的是"哪个先结束"，考试若按开考排，开考早但结束晚的会把真正临近结束的挤到后面。
 * 详见 packages/shared/src/model/assignment.ts。
 */

import type { UiAssignment } from '../../../shared/ipc';
import { anchorOf, dueToMs, endOf, isExamItem } from '@dgut-deadline/shared';

/** 类型筛选（用户 2026-11-11 决策 D2 = A+B 合并）。 */
export type KindFilter = 'all' | 'homework' | 'exam';

/** 时间范围选项。作业按「截止」，考试按「开考」（统一用锚点实现）。 */
export type DueRange =
  | 'all' // 不限
  | 'overdue' // 已过期（作业=已截止 / 考试=已结束）
  | 'today' // 今天内（24h）
  | '3d' // 3 天内
  | '7d' // 7 天内
  | '30d' // 30 天内
  | 'unknown'; // 时间未知

/**
 * 提交状态筛选。
 *
 * ⚠️ 这是**作业专有**语义。考试没有「提交状态」（`UiExam` 上物理不存在该字段），
 * 因此 `not_submitted` / `submitted` 对考试行**不匹配任何行**（不是"全部匹配"）。
 * 考试行只有 `unknown`（参加状态恒未知，平台未提供可信字段）与 `overdue`（已结束）有意义。
 */
export type StatusFilter =
  | 'all'
  | 'not_submitted'
  | 'submitted'
  | 'unknown'
  | 'overdue';

/** 剩余时间范围（与 DueRange 语义相近，但站在"还剩多久"的角度）。 */
export type RemainRange = 'all' | '3h' | '24h' | '72h' | '7d' | 'none';

export interface FilterState {
  /** 类型：全部 / 作业 / 考试。 */
  kind: KindFilter;
  /** 平台：'all' 或具体 SourceId。 */
  source: 'all' | 'hw' | 'ulearning';
  /** 课程：'all' 或具体课程名。 */
  course: string;
  /** 时间范围。默认由 hideExpired 控制。 */
  dueRange: DueRange;
  /** 剩余时间范围。 */
  remainRange: RemainRange;
  /** 状态（作业专有，考试只认 unknown/overdue）。 */
  status: StatusFilter;
  /** 是否隐藏已过期（默认 true —— 用户要求默认只看未过期）。 */
  hideExpired: boolean;
  /** 标题/课程关键字搜索。 */
  keyword: string;
  /** 排序方式。 */
  sort: 'dueAsc' | 'dueDesc' | 'remaining' | 'course';
}

export const DEFAULT_FILTER: FilterState = {
  kind: 'all', // 默认混排：一个列表看全「今天要做什么」
  source: 'all',
  course: 'all',
  dueRange: 'all',
  remainRange: 'all',
  status: 'all',
  hideExpired: true, // 用户要求：默认只看未过期
  keyword: '',
  sort: 'dueAsc', // 用户要求：时间最近的排最前
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * 判断是否已过期。
 *
 * 作业：`dueAt < now`（与改造前完全一致）。
 * 考试：用 `endsAt`（缺失时退化用 `startsAt`）判定 —— **已开考未结束的考试不算过期**。
 *   这是产品级红线（docs/LMS-EXAM-PLAN.md §5.1/§8.5）：把开考时间当截止时间会让
 *   「正在考试」的条目被默认的「隐藏已过期」过滤掉，用户正在考试列表里反而没了。
 *   时间未知（两者都 null）不算过期 —— 不能假装它已结束。
 */
export function isExpired(item: UiAssignment, nowMs: number): boolean {
  const end = dueToMs(endOf(item));
  return end !== null && end < nowMs;
}

/** 应用筛选。 */
export function applyFilter(
  list: readonly UiAssignment[],
  f: FilterState,
  nowMs: number,
): UiAssignment[] {
  const kw = f.keyword.trim().toLowerCase();

  const out = list.filter((a) => {
    // 类型（先判，最省）
    if (f.kind !== 'all' && a.kind !== f.kind) return false;

    // 平台
    if (f.source !== 'all' && a.source !== f.source) return false;

    // 课程
    if (f.course !== 'all' && (a.courseName ?? '') !== f.course) return false;

    // 默认隐藏已过期
    if (f.hideExpired && isExpired(a, nowMs)) return false;

    // 关键字（标题 + 课程）
    if (kw) {
      const hay = `${a.title} ${a.courseName ?? ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }

    // 状态（作业看 submissionStatus，考试看 attendance）
    if (f.status !== 'all') {
      if (f.status === 'overdue') {
        if (!isExpired(a, nowMs)) return false;
      } else if (isExamItem(a)) {
        if (a.attendance !== f.status) return false;
      } else if (a.submissionStatus !== f.status) {
        return false;
      }
    }

    // 统一锚点：作业 = 截止时间；考试 = 开考时间。
    const anchor = dueToMs(anchorOf(a));

    // 时间范围
    if (f.dueRange !== 'all') {
      if (f.dueRange === 'unknown') {
        if (anchor !== null) return false;
      } else if (f.dueRange === 'overdue') {
        if (!isExpired(a, nowMs)) return false;
      } else {
        if (anchor === null) return false;
        const diff = anchor - nowMs;
        const limit =
          f.dueRange === 'today' ? DAY : f.dueRange === '3d' ? 3 * DAY : f.dueRange === '7d' ? 7 * DAY : 30 * DAY;
        if (diff < 0 || diff > limit) return false;
      }
    }

    // 剩余时间范围（相对锚点）
    if (f.remainRange !== 'all') {
      if (f.remainRange === 'none') {
        if (anchor !== null) return false;
      } else {
        if (anchor === null) return false;
        const diff = anchor - nowMs;
        if (diff < 0) return false;
        const limit =
          f.remainRange === '3h'
            ? 3 * HOUR
            : f.remainRange === '24h'
              ? DAY
              : f.remainRange === '72h'
                ? 3 * DAY
                : 7 * DAY;
        if (diff > limit) return false;
      }
    }

    return true;
  });

  return sortList(out, f.sort, nowMs);
}

/** 排序。按「结束时刻」endOf()（作业=dueAt / 考试=endsAt，缺失退化 startsAt），无值置底。 */
export function sortList(
  list: readonly UiAssignment[],
  sort: FilterState['sort'],
  nowMs: number,
): UiAssignment[] {
  void nowMs;
  const arr = [...list];
  /**
   * 排序键 = 结束时刻，不是 anchorOf()。
   *
   * 考试的锚点是「开考」，但用户关心的是**哪个先结束**：开考早、结束晚的考试
   * 不该把开考晚、结束早的挤到后面（2026-11-12 用户反馈）。
   * 作业的结束就是截止时间，因此作业排序行为与此前逐字相同。
   */
  const end = (a: UiAssignment): number => {
    const d = dueToMs(endOf(a));
    return d === null ? Number.MAX_SAFE_INTEGER : d;
  };

  switch (sort) {
    case 'dueAsc':
      // 结束时间最近的在前；无结束时间的置底
      arr.sort((x, y) => {
        const dx = end(x);
        const dy = end(y);
        if (dx !== dy) return dx - dy;
        return x.title.localeCompare(y.title, 'zh-CN');
      });
      break;
    case 'dueDesc':
      arr.sort((x, y) => {
        const dx = end(x);
        const dy = end(y);
        if (dx !== dy) return dy - dx;
        return x.title.localeCompare(y.title, 'zh-CN');
      });
      break;
    case 'remaining':
      // 与 dueAsc 同向，但无结束时间的明确置底
      arr.sort((x, y) => end(x) - end(y));
      break;
    case 'course':
      arr.sort((x, y) => {
        const c = (x.courseName ?? '').localeCompare(y.courseName ?? '', 'zh-CN');
        if (c !== 0) return c;
        return end(x) - end(y);
      });
      break;
  }
  return arr;
}

/** 从列表中提取可选的课程清单（去重并排序），用于筛选下拉框。 */
export function collectCourses(list: readonly UiAssignment[]): string[] {
  const set = new Set<string>();
  for (const a of list) {
    const c = (a.courseName ?? '').trim();
    if (c) set.add(c);
  }
  return [...set].sort((x, y) => x.localeCompare(y, 'zh-CN'));
}

/** 统计各筛选项的数量，用于在 UI 上显示计数。 */
export interface FilterCounts {
  all: number;
  /** 未过期条数（作业=未截止 / 考试=未结束）。 */
  upcoming: number;
  /** 已过期条数。 */
  overdue: number;
  /** 已提交作业数（考试无此概念，不计入）。 */
  submitted: number;
  /** 未提交作业数（考试无此概念，不计入）。 */
  notSubmitted: number;
  /** 按类型的计数（类型 Tab 上的数字）。 */
  homework: number;
  exam: number;
}

export function countBy(list: readonly UiAssignment[], nowMs: number): FilterCounts {
  let upcoming = 0;
  let overdue = 0;
  let submitted = 0;
  let notSubmitted = 0;
  let homework = 0;
  let exam = 0;
  for (const a of list) {
    if (isExpired(a, nowMs)) overdue++;
    else upcoming++;
    if (isExamItem(a)) {
      exam++;
      // 考试没有提交状态：不参与 submitted / notSubmitted 统计。
      continue;
    }
    homework++;
    if (a.submissionStatus === 'submitted') submitted++;
    if (a.submissionStatus === 'not_submitted') notSubmitted++;
  }
  return { all: list.length, upcoming, overdue, submitted, notSubmitted, homework, exam };
}
