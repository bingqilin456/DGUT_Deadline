/**
 * 提醒弹窗的 preload：只暴露最小接口。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { ToastApi, ToastItem } from '../shared/toast.js';

// 类型单一来源：src/shared/toast.ts（主进程、preload、渲染进程三方共用）。
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
} satisfies ToastApi);
