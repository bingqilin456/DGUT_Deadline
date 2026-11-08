<script setup lang="ts">
import type { UiAssignment } from '../../../shared/ipc';
import { formatRemaining, dueToMs } from '@dgut-deadline/shared';

const props = defineProps<{ assignments: UiAssignment[]; nowMs: number }>();
const emit = defineEmits<{ open: [a: UiAssignment] }>();

function remaining(a: UiAssignment): string {
  return formatRemaining(props.nowMs, dueToMs(a.dueAt), a.duePrecision);
}

function dueText(a: UiAssignment): string {
  if (!a.dueAt) return '待确认';
  const d = new Date(a.dueAt);
  const s = d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return a.duePrecision === 'date' ? `${s.slice(0, 10)}（时间待确认）` : s;
}

function statusBadge(a: UiAssignment): { cls: string; text: string } {
  if (a.submissionStatus === 'submitted') return { cls: 'ok', text: '已提交' };
  if (a.submissionStatus === 'not_submitted') {
    const d = dueToMs(a.dueAt);
    if (d !== null && d < props.nowMs) return { cls: 'bad', text: '已截止·未提交' };
    return { cls: 'warn', text: '未提交' };
  }
  if (a.submissionStatus === 'overdue') return { cls: 'bad', text: '已逾期' };
  return { cls: 'muted', text: '状态待确认' };
}

function remainingClass(a: UiAssignment): string {
  const d = dueToMs(a.dueAt);
  if (d === null) return 'muted';
  const diff = d - props.nowMs;
  if (diff < 0) return 'bad';
  if (diff <= 24 * 3600 * 1000) return 'warn';
  return 'muted';
}
</script>

<template>
  <div class="table-wrap assignment-scroll" role="region" aria-label="作业列表，可横向滚动查看所有列" tabindex="0">
    <table class="assignment-table" aria-label="作业及截止状态">
      <colgroup>
        <col class="col-source" />
        <col class="col-title" />
        <col class="col-course" />
        <col class="col-due" />
        <col class="col-remaining" />
        <col class="col-status" />
        <col class="col-action" />
      </colgroup>
      <thead>
        <tr>
          <th>平台</th>
          <th>作业</th>
          <th>课程</th>
          <th>截止时间</th>
          <th>剩余</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="a in assignments" :key="a.id" :class="{
          'row-pending': a.submissionStatus === 'not_submitted',
          'row-submitted': a.submissionStatus === 'submitted',
          'row-urgent': a.submissionStatus !== 'submitted' && remainingClass(a) === 'warn',
          'row-overdue': a.submissionStatus !== 'submitted' && remainingClass(a) === 'bad',
        }">
          <td>
            <span v-if="a.isDemo" class="badge bad">演示</span>
            <span v-else class="badge muted">{{ a.source === 'hw' ? '作业平台' : '优学院' }}</span>
          </td>
          <td class="title-cell">
            <div class="title" :title="a.title">{{ a.title }}</div>
            <div v-if="a.overridden" class="sub">已手动修正</div>
          </td>
          <td class="title-cell" :title="a.courseName ?? ''">{{ a.courseName ?? '—' }}</td>
          <td class="due-cell" :title="dueText(a)">{{ dueText(a) }}</td>
          <td class="remaining-cell">
            <span class="badge" :class="remainingClass(a)">{{ remaining(a) }}</span>
          </td>
          <td>
            <span class="badge" :class="statusBadge(a).cls">{{ statusBadge(a).text }}</span>
          </td>
          <td>
            <button class="link open-link" :disabled="!a.detailUrl" :title="a.detailUrl ? `打开：${a.title}` : '暂无可打开的作业链接'" @click="emit('open', a)">打开</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
