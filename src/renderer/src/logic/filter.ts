/**
 * 作业列表的筛选与排序（纯逻辑，可单测）。
 *
 * 产品要求（用户明确指定）：
 *  - 可按「平台 / 课程 / 截止时间 / 剩余 / 状态」筛选
 *  - **默认只看未截止**，且**截止时间最近的排最前**
 */

import type { UiAssignment } from '../../../shared/ipc';
import { dueToMs } from '@dgut-deadline/shared';

/** 截止时间范围选项。 */
export type DueRange =
  | 'all' // 不限
  | 'overdue' // 已截止
  | 'today' // 今天内（24h）
  | '3d' // 3 天内
  | '7d' // 7 天内
  | '30d' // 30 天内
  | 'unknown'; // 截止时间未知

/** 提交状态筛选。 */
export type StatusFilter =
  | 'all'
  | 'not_submitted'
  | 'submitted'
  | 'unknown'
  | 'overdue';

/** 剩余时间范围（与 DueRange 语义相近，但站在"还剩多久"的角度）。 */
export type RemainRange = 'all' | '3h' | '24h' | '72h' | '7d' | 'none';

export interface FilterState {
  /** 平台：'all' 或具体 SourceId。 */
  source: 'all' | 'hw' | 'ulearning';
  /** 课程：'all' 或具体课程名。 */
  course: string;
  /** 截止时间范围。默认 'upcoming' 语义由 hideExpired 控制。 */
  dueRange: DueRange;
  /** 剩余时间范围。 */
  remainRange: RemainRange;
  /** 状态。 */
  status: StatusFilter;
  /** 是否隐藏已截止（默认 true —— 用户要求默认只看未截止）。 */
  hideExpired: boolean;
  /** 标题/课程关键字搜索。 */
  keyword: string;
  /** 排序方式。 */
  sort: 'dueAsc' | 'dueDesc' | 'remaining' | 'course';
}

export const DEFAULT_FILTER: FilterState = {
  source: 'all',
  course: 'all',
  dueRange: 'all',
  remainRange: 'all',
  status: 'all',
  hideExpired: true, // 用户要求：默认只看未截止
  keyword: '',
  sort: 'dueAsc', // 用户要求：截止时间最近的排最前
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** 判断是否已截止（无截止时间不算已截止）。 */
export function isExpired(a: UiAssignment, nowMs: number): boolean {
  const d = dueToMs(a.dueAt);
  return d !== null && d < nowMs;
}

/** 应用筛选。 */
export function applyFilter(
  list: readonly UiAssignment[],
  f: FilterState,
  nowMs: number,
): UiAssignment[] {
  const kw = f.keyword.trim().toLowerCase();

  const out = list.filter((a) => {
    // 平台
    if (f.source !== 'all' && a.source !== f.source) return false;

    // 课程
    if (f.course !== 'all' && (a.courseName ?? '') !== f.course) return false;

    // 默认隐藏已截止
    if (f.hideExpired && isExpired(a, nowMs)) return false;

    // 关键字（标题 + 课程）
    if (kw) {
      const hay = `${a.title} ${a.courseName ?? ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }

    // 状态
    if (f.status !== 'all') {
      if (f.status === 'overdue') {
        if (!isExpired(a, nowMs)) return false;
      } else if (a.submissionStatus !== f.status) {
        return false;
      }
    }

    const d = dueToMs(a.dueAt);

    // 截止时间范围
    if (f.dueRange !== 'all') {
      if (f.dueRange === 'unknown') {
        if (d !== null) return false;
      } else if (f.dueRange === 'overdue') {
        if (d === null || d >= nowMs) return false;
      } else {
        if (d === null) return false;
        const diff = d - nowMs;
        const limit =
          f.dueRange === 'today' ? DAY : f.dueRange === '3d' ? 3 * DAY : f.dueRange === '7d' ? 7 * DAY : 30 * DAY;
        if (diff < 0 || diff > limit) return false;
      }
    }

    // 剩余时间范围
    if (f.remainRange !== 'all') {
      if (f.remainRange === 'none') {
        if (d !== null) return false;
      } else {
        if (d === null) return false;
        const diff = d - nowMs;
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

/** 排序。 */
export function sortList(
  list: readonly UiAssignment[],
  sort: FilterState['sort'],
  nowMs: number,
): UiAssignment[] {
  void nowMs;
  const arr = [...list];
  const due = (a: UiAssignment): number => {
    const d = dueToMs(a.dueAt);
    return d === null ? Number.MAX_SAFE_INTEGER : d;
  };

  switch (sort) {
    case 'dueAsc':
      // 截止最近的在前；无截止时间的置底
      arr.sort((x, y) => {
        const dx = due(x);
        const dy = due(y);
        if (dx !== dy) return dx - dy;
        return x.title.localeCompare(y.title, 'zh-CN');
      });
      break;
    case 'dueDesc':
      arr.sort((x, y) => {
        const dx = due(x);
        const dy = due(y);
        if (dx !== dy) return dy - dx;
        return x.title.localeCompare(y.title, 'zh-CN');
      });
      break;
    case 'remaining':
      // 与 dueAsc 同向，但无截止时间的明确置底
      arr.sort((x, y) => due(x) - due(y));
      break;
    case 'course':
      arr.sort((x, y) => {
        const c = (x.courseName ?? '').localeCompare(y.courseName ?? '', 'zh-CN');
        if (c !== 0) return c;
        return due(x) - due(y);
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
  upcoming: number;
  overdue: number;
  submitted: number;
  notSubmitted: number;
}

export function countBy(list: readonly UiAssignment[], nowMs: number): FilterCounts {
  let upcoming = 0;
  let overdue = 0;
  let submitted = 0;
  let notSubmitted = 0;
  for (const a of list) {
    if (isExpired(a, nowMs)) overdue++;
    else upcoming++;
    if (a.submissionStatus === 'submitted') submitted++;
    if (a.submissionStatus === 'not_submitted') notSubmitted++;
  }
  return { all: list.length, upcoming, overdue, submitted, notSubmitted };
}
