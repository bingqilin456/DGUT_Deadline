/**
 * 演示数据。
 *
 * 需求硬约束：**演示数据必须明确标注「演示」**，绝不能与真实数据混淆。
 * 因此这些作业的标题前缀固定为「【演示】」，且 UI 会在顶部显示醒目横幅。
 *
 * 这些数据只在用户主动开启「演示模式」时显示，不会写入任何平台缓存，
 * 也不会触发真实的系统通知（ReminderScheduler 只读 store 里的真实作业）。
 */

import type { Assignment, SourceId } from '@dgut-deadline/shared';
import { assignmentId } from '@dgut-deadline/shared';

const DEMO_PREFIX = '【演示】';

export const DEMO_SOURCE: SourceId = 'hw';

interface DemoSeed {
  id: string;
  title: string;
  course: string;
  /** 相对当前时间的截止偏移（小时）。 */
  dueInHours: number | null;
  status: Assignment['submissionStatus'];
}

const SEEDS: DemoSeed[] = [
  {
    id: 'demo-1',
    title: '演示：3 小时内截止的未提交作业',
    course: '演示课程 A',
    dueInHours: 3,
    status: 'not_submitted',
  },
  {
    id: 'demo-2',
    title: '演示：20 小时后截止的实验报告',
    course: '演示课程 B',
    dueInHours: 20,
    status: 'not_submitted',
  },
  {
    id: 'demo-3',
    title: '演示：已提交的作业（不会提醒）',
    course: '演示课程 A',
    dueInHours: 48,
    status: 'submitted',
  },
  {
    id: 'demo-4',
    title: '演示：提交状态未知的作业',
    course: '演示课程 C',
    dueInHours: 60,
    status: 'unknown',
  },
  {
    id: 'demo-5',
    title: '演示：没有截止时间的作业',
    course: '演示课程 C',
    dueInHours: null,
    status: 'not_submitted',
  },
  {
    id: 'demo-6',
    title: '演示：已过期未提交的作业',
    course: '演示课程 B',
    dueInHours: -24,
    status: 'not_submitted',
  },
];

/** 生成演示作业（时间基于当前时刻，保证"3 小时内截止"等场景可复现）。 */
export function buildDemoAssignments(nowMs: number): Assignment[] {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const nowIso = iso(nowMs);

  return SEEDS.map((s) => {
    const dueMs = s.dueInHours === null ? null : nowMs + s.dueInHours * 3600 * 1000;
    return {
      source: DEMO_SOURCE,
      sourceAssignmentId: s.id,
      id: assignmentId(DEMO_SOURCE, s.id),
      courseId: null,
      courseName: s.course,
      title: `${DEMO_PREFIX}${s.title.replace(/^演示：/, '')}`,
      detailUrl: null, // 演示数据不跳转，避免误导用户
      dueAt: dueMs === null ? null : iso(dueMs),
      duePrecision: dueMs === null ? 'none' : 'datetime',
      submissionStatus: s.status,
      statusEvidence: '演示数据（非真实平台数据）',
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      lastSyncAt: nowIso,
      sourceUpdatedAt: null,
    } satisfies Assignment;
  });
}

/** 判断一条作业是否为演示数据。 */
export function isDemoAssignment(a: { title?: string | null; statusEvidence?: string | null }): boolean {
  return (
    (a.title ?? '').startsWith(DEMO_PREFIX) ||
    (a.statusEvidence ?? '').includes('演示数据（非真实平台数据）')
  );
}
