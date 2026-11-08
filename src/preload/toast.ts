/**
 * 提醒弹窗的 preload：只暴露最小接口。
 */

import { contextBridge, ipcRenderer } from 'electron';

interface ToastItem {
  key: string;
  title: string;
  body: string;
  urgent: boolean;
  detailUrl: string | null;
  courseName: string | null;
  assignmentTitle: string;
  thresholdHours: number;
}

contextBridge.exposeInMainWorld('toastApi', {
  onItems: (cb: (items: ToastItem[]) => void) => {
    ipcRenderer.on('toast:items', (_e, items: ToastItem[]) => cb(items));
  },
  acknowledge: (keys: string[]) => {
    ipcRenderer.send('toast:acknowledge', keys);
  },
  open: (key: string) => {
    ipcRenderer.send('toast:open', key);
  },
  notifyReady: () => {
    ipcRenderer.send('toast:ready');
  },
});
