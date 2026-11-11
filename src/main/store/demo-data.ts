/**
 * 演示数据。
 *
 * 需求硬约束：**演示数据必须明确标注「演示」**，绝不能与真实数据混淆。
 * 因此这些条目的标题前缀固定为「【演示】」，且 UI 会在顶部显示醒目横幅。
 *
 * 这些数据只在用户主动开启「演示模式」时显示，不会写入任何平台缓存，
 * 也不会触发真实的系统通知（ReminderScheduler 只读 store 里的真实数据）。
 *
 * 演示数据同时包含作业与考试，用于验证：
 *  - 类型徽标与 Tab 分流；
 *  - 考试的「进行中」不会被「隐藏已截止」误伤；
 *  - 考试状态列只出现「未开始/进行中/已结束/时间未知」，绝不出现「未参加」。
 */

import type { Assignment, ExamItem, ListItem, SourceId } from '@dgut-deadline/shared';
import { assignmentId, examSourceId } from '@dgut-deadline/shared';

const DEMO_PREFIX = '【演示】';
const DEMO_EVIDENCE = '演示数据（非真实平台数据）';

export const DEMO_SOURCE: SourceId = 'hw';

interface DemoHomeworkSeed {
  id: string;
  title: string;
  course: string;
  /** 相对当前时间的截止偏移（小时）。 */
  dueInHours: number | null;
  status: Assignment['submissionStatus'];
}

const HOMEWORK_SEEDS: DemoHomeworkSeed[] = [
  {
    id: 'demo-1',
    title: '3 小时内截止的未提交作业',
    course: '演示课程 A',
    dueInHours: 3,
    status: 'not_submitted',
  },
  {
    id: 'demo-2',
    title: '20 小时后截止的实验报告',
    course: '演示课程 B',
    dueInHours: 20,
    status: 'not_submitted',
  },
  {
    id: 'demo-3',
    title: '已提交的作业（不会提醒）',
    course: '演示课程 A',
    dueInHours: 48,
    status: 'submitted',
  },
  {
    id: 'demo-4',
    title: '提交状态未知的作业',
    course: '演示课程 C',
    dueInHours: 60,
    status: 'unknown',
  },
  {
    id: 'demo-5',
    title: '没有截止时间的作业',
    course: '演示课程 C',
    dueInHours: null,
    status: 'not_submitted',
  },
  {
    id: 'demo-6',
    title: '已过期未提交的作业',
    course: '演示课程 B',
    dueInHours: -24,
    status: 'not_submitted',
  },
];

interface DemoExamSeed {
  id: string;
  title: string;
  course: string;
  /** 相对当前时间的开考偏移（小时）。可正可负。 */
  startInHours: number;
  /** 考试时长（小时）；null = 结束时间未提供。 */
  durationHours: number | null;
  room?: string;
  seat?: string;
}

const EXAM_SEEDS: DemoExamSeed[] = [
  {
    id: 'dexam-1',
    title: '期末考试（30 分钟后开考）',
    course: '演示课程 A',
    startInHours: 0.5,
    durationHours: 2,
    room: '演示机房 301',
    seat: 'A-12',
  },
  {
    id: 'dexam-2',
    title: '期中测验（正在进行中）',
    course: '演示课程 B',
    startInHours: -0.5,
    durationHours: 1.5,
    room: '演示机房 202',
  },
  {
    id: 'dexam-3',
    title: '月考（明天开考，无结束时间）',
    course: '演示课程 C',
    startInHours: 24,
    durationHours: null,
  },
  {
    id: 'dexam-4',
    title: '已结束的考试（用来验证回看与隐藏）',
    course: '演示课程 A',
    startInHours: -30,
    durationHours: 2,
  },
];

/** 生成演示作业（时间基于当前时刻，保证"3 小时内截止"等场景可复现）。 */
export function buildDemoAssignments(nowMs: number): Assignment[] {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const nowIso = iso(nowMs);

  return HOMEWORK_SEEDS.map((s) => {
    const dueMs = s.dueInHours === null ? null : nowMs + s.dueInHours * 3600 * 1000;
    return {
      source: DEMO_SOURCE,
      sourceAssignmentId: s.id,
      id: assignmentId(DEMO_SOURCE, s.id),
      kind: 'homework',
      courseId: null,
      courseName: s.course,
      title: `${DEMO_PREFIX}${s.title}`,
      detailUrl: null, // 演示数据不跳转，避免误导用户
      dueAt: dueMs === null ? null : iso(dueMs),
      duePrecision: dueMs === null ? 'none' : 'datetime',
      submissionStatus: s.status,
      statusEvidence: DEMO_EVIDENCE,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      lastSyncAt: nowIso,
      sourceUpdatedAt: null,
    } satisfies Assignment;
  });
}

/** 生成演示考试场次。 */
export function buildDemoExams(nowMs: number): ExamItem[] {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const nowIso = iso(nowMs);

  return EXAM_SEEDS.map((s) => {
    const startMs = nowMs + s.startInHours * 3600 * 1000;
    const endMs = s.durationHours === null ? null : startMs + s.durationHours * 3600 * 1000;
    const examId = s.id.replace('dexam-', '');
    return {
      source: DEMO_SOURCE,
      sourceAssignmentId: examSourceId(examId, startMs),
      id: assignmentId(DEMO_SOURCE, examSourceId(examId, startMs)),
      kind: 'exam',
      courseId: null,
      courseName: s.course,
      title: `${DEMO_PREFIX}${s.title}`,
      detailUrl: null,
      examId,
      startsAt: iso(startMs),
      endsAt: endMs === null ? null : iso(endMs),
      timePrecision: 'datetime',
      venue: s.room
        ? { roomName: s.room, seatNo: s.seat ?? null }
        : null,
      // 演示数据也遵守红线：参加状态未知就是未知，不编造「未参加」
      attendance: 'unknown',
      attendanceEvidence: DEMO_EVIDENCE,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      lastSyncAt: nowIso,
      sourceUpdatedAt: null,
    } satisfies ExamItem;
  });
}

/** 生成演示数据（作业 + 考试）。 */
export function buildDemoItems(nowMs: number): ListItem[] {
  return [...buildDemoAssignments(nowMs), ...buildDemoExams(nowMs)];
}

/** 判断一条数据是否为演示数据。 */
export function isDemoAssignment(a: { title?: string | null; statusEvidence?: string | null }): boolean {
  return (
    (a.title ?? '').startsWith(DEMO_PREFIX) ||
    (a.statusEvidence ?? '').includes(DEMO_EVIDENCE)
  );
}

/** 判断一条考试是否为演示数据。 */
export function isDemoExam(x: { title?: string | null; attendanceEvidence?: string | null }): boolean {
  return (
    (x.title ?? '').startsWith(DEMO_PREFIX) ||
    (x.attendanceEvidence ?? '').includes(DEMO_EVIDENCE)
  );
}

/** 通用：判断任意列表项是否为演示数据。 */
export function isDemoItem(i: ListItem): boolean {
  return i.kind === 'exam' ? isDemoExam(i) : isDemoAssignment(i);
}
