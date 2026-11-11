/**
 * 右下角提醒弹窗的渲染逻辑（原生 DOM，不依赖 Vue，启动更快）。
 */

import type { ToastItem } from '../../shared/toast';

// 类型单一来源：src/shared/toast.ts，不再手抄一份影子结构。
interface ToastApi {
  onItems(cb: (items: ToastItem[]) => void): void;
  acknowledge(keys: string[]): void;
  open(key: string): void;
  notifyReady(): void;
}

declare global {
  interface Window {
    toastApi: ToastApi;
  }
}

const list = document.getElementById('list');

function render(items: ToastItem[]): void {
  if (!list) return;
  if (items.length === 0) {
    list.innerHTML = '';
    return;
  }

  const frag = document.createDocumentFragment();

  for (const it of items) {
    const card = document.createElement('div');
    card.className = `card${it.urgent ? ' urgent' : ''}`;
    card.dataset['key'] = it.key;

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = it.title;

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = it.body;
    body.title = it.body;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const ackBtn = document.createElement('button');
    ackBtn.className = 'primary';
    ackBtn.textContent = '我已知晓';
    ackBtn.addEventListener('click', () => {
      window.toastApi.acknowledge([it.key]);
    });

    actions.appendChild(ackBtn);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(actions);
    frag.appendChild(card);
  }

  if (items.length > 1) {
    const row = document.createElement('div');
    row.className = 'all-row';
    const allBtn = document.createElement('button');
    allBtn.textContent = `全部已知晓（${items.length} 条）`;
    allBtn.addEventListener('click', () => {
      window.toastApi.acknowledge(items.map((i) => i.key));
    });
    row.appendChild(allBtn);
    frag.appendChild(row);
  }

  list.innerHTML = '';
  list.appendChild(frag);
}

window.toastApi.onItems((items: ToastItem[]) => render(items));
window.toastApi.notifyReady();

export {};
