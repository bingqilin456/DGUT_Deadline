/**
 * 右下角提醒弹窗的数据契约。
 *
 * 放在 src/shared 的原因：主进程（产出方 toast-manager.ts）、preload（转发方
 * preload/toast.ts）、渲染进程（消费方 toast-main.ts）三方都要用这个类型，
 * 而 tsconfig.node.json 与 tsconfig.web.json 都 include 了 src/shared。
 *
 * 历史缺陷：此前 preload 与 renderer 各自手抄了一份结构相同的 interface，
 * 互不引用 —— 加字段时若漏改一处，运行时静默不一致且编译器不报错。
 */

export interface ToastItem {
  /** 幂等键，用于确认后回调。 */
  key: string;
  title: string;
  body: string;
  /** 是否强制提醒（红色样式 + 不自动消失）。 */
  urgent: boolean;
  /** 该提醒对应的源站链接（可为空）。 */
  detailUrl: string | null;
  courseName: string | null;
  assignmentTitle: string;
  thresholdHours: number;
  /** 实体类型：作业 / 考试（决定徽标与措辞）。 */
  kind: 'homework' | 'exam';
}

/** preload 通过 contextBridge 暴露给弹窗页面的 API。 */
export interface ToastApi {
  onItems(cb: (items: ToastItem[]) => void): void;
  acknowledge(keys: string[]): void;
  open(key: string): void;
  notifyReady(): void;
}
