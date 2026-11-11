/**
 * AssignmentSource —— 每个学校平台实现这个接口。
 *
 * 契约（必须遵守，否则视为实现错误）：
 *  - connect() 只在"用户已完成人工登录"后返回 connected，绝不返回伪造的成功。
 *  - listAssignments()/listExams() 抛错时，调用方必须保留上一次缓存，不得清空。
 *  - 任何"读不全"都必须通过 `complete=false` + `warnings` 表达，**不得**用空数组冒充。
 *    容器结构识别不了 ⇒ 抛错（parse_error 类），绝不返回 []。
 *  - supportedKinds 声明本平台**具备**的列表能力。不具备的 kind 不返回、不伪造空结果
 *    （hw 平台没有考试功能，返回"考试 0 条"会把"不具备能力"伪装成"没有数据"）。
 *  - 所有方法只读：不得 POST/PUT/PATCH/DELETE 任何学校业务数据。
 *  - close() 必须真正关闭浏览器/会话句柄，避免残留进程。
 */

import type {
  Assignment,
  ExamItem,
  ListItem,
  ListItemKind,
  SourceId,
} from '../model/assignment.js';
import type { SessionStatus } from '../model/sync.js';

export interface ListOptions {
  /** 单次同步超时（毫秒）。 */
  timeoutMs?: number;
  /** 最多读取多少个课程；用于限流与快速失败。 */
  maxCourses?: number;
}

/**
 * 列表读取结果。
 *
 * 相对改造前 `Promise<Assignment[]>` 的**故意**变化：
 *  - `complete=false` 让「读了 25 门课，其中 3 门失败」可表达；
 *  - `warnings` 让非致命问题一路透传到 UI 诊断（改造前 `sync-engine.ts:150` 把 warnings 写死成 `[]`）；
 *  - 0 条 + `complete=true` 才是「确认没有」；0 条 + `complete=false` 必须是"没说清"。
 */
export interface ListItemsResult<T extends ListItem = ListItem> {
  items: T[];
  /** 是否覆盖了全部课程/分页。 */
  complete: boolean;
  /** 非致命告警（单课程失败、字段缺失跳过、容器降级等）。必须透传到 UI 诊断。 */
  warnings: string[];
}

export interface AssignmentSource {
  readonly source: SourceId;
  readonly displayName: string;
  /** 本平台支持的列表类型。hw = ['homework']；ulearning = ['homework', 'exam']。 */
  readonly supportedKinds: readonly ListItemKind[];

  /** 打开受控浏览器，让用户手工登录；返回是否已具备可用会话。 */
  connect(): Promise<SessionStatus>;

  /** 只检查会话是否有效，不触发新的导航（尽量轻量）。 */
  checkSession(): Promise<SessionStatus>;

  /** 读取全部作业；失败时抛错，由调用方分类并保留缓存。 */
  listAssignments(options?: ListOptions): Promise<ListItemsResult<Assignment>>;

  /**
   * 读取考试**场次**列表。仅 supportedKinds 含 'exam' 的平台实现。
   *
   * 未验证（docs/LMS-EXAM-PLAN.md §3 C.1/C.5/C.6）：真实响应形状、场次字段名、时间类型
   * 均未拿到实测响应，实现按证据表的「代码证据（未验证）」形状编写，调用方默认关闭。
   */
  listExams?(options?: ListOptions): Promise<ListItemsResult<ExamItem>>;

  /** 释放资源。 */
  close(): Promise<void>;
}

/**
 * 适配器可用性：某些平台在特定环境（无校园网/VPN、平台维护）下无法使用，
 * UI 必须据此显示人工操作指引，而不是显示"0 个作业"。
 */
export interface SourceAvailability {
  source: SourceId;
  /** 是否可以尝试连接。 */
  attemptable: boolean;
  /** 阻塞原因（中文）。 */
  blockedReason: string | null;
  /** 需要用户执行的具体步骤。 */
  userSteps: string[];
}
