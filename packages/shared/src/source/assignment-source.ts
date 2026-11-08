/**
 * AssignmentSource —— 每个学校平台实现这个接口。
 *
 * 契约（必须遵守，否则视为实现错误）：
 *  - connect() 只在"用户已完成人工登录"后返回 connected，绝不返回伪造的成功。
 *  - listAssignments() 抛错时，调用方必须保留上一次缓存，不得清空。
 *  - 所有方法只读：不得 POST/PUT/PATCH/DELETE 任何学校业务数据。
 *  - close() 必须真正关闭浏览器/会话句柄，避免残留进程。
 */

import type { Assignment, SourceId } from '../model/assignment.js';
import type { SessionStatus } from '../model/sync.js';

export interface ListOptions {
  /** 单次同步超时（毫秒）。 */
  timeoutMs?: number;
  /** 最多读取多少个课程；用于限流与快速失败。 */
  maxCourses?: number;
}

export interface AssignmentSource {
  readonly source: SourceId;
  readonly displayName: string;

  /** 打开受控浏览器，让用户手工登录；返回是否已具备可用会话。 */
  connect(): Promise<SessionStatus>;

  /** 只检查会话是否有效，不触发新的导航（尽量轻量）。 */
  checkSession(): Promise<SessionStatus>;

  /** 读取全部作业；失败时抛错，由调用方分类并保留缓存。 */
  listAssignments(options?: ListOptions): Promise<Assignment[]>;

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
