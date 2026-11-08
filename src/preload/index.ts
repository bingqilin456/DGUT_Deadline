/**
 * Preload：只暴露白名单 API，不泄漏 ipcRenderer / node / process。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { SourceId } from '@dgut-deadline/shared';
import type { AppSnapshot, IpcApi, SettingsDto } from '../shared/ipc.js';

const api: IpcApi = {
  getSnapshot: () => ipcRenderer.invoke('app:getSnapshot'),
  syncNow: () => ipcRenderer.invoke('app:syncNow'),
  login: (source: SourceId) => ipcRenderer.invoke('app:login', source),
  openAssignment: (id: string) => ipcRenderer.invoke('app:openAssignment', id),
  updateSettings: (patch: Partial<SettingsDto>) => ipcRenderer.invoke('app:updateSettings', patch),
  exportDiagnostics: () => ipcRenderer.invoke('app:exportDiagnostics'),
  testNotification: () => ipcRenderer.invoke('app:testNotification'),
  diagnoseSource: (source: SourceId) => ipcRenderer.invoke('app:diagnoseSource', source),
  onSnapshot: (cb: (snap: AppSnapshot) => void) => {
    const listener = (_e: unknown, snap: AppSnapshot): void => cb(snap);
    ipcRenderer.on('app:snapshot', listener);
    return () => ipcRenderer.removeListener('app:snapshot', listener);
  },
};

contextBridge.exposeInMainWorld('dgut', api);
