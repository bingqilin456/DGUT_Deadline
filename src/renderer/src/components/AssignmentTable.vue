<script setup lang="ts">
/**
 * 列表表格：作业 + 考试混排（用户 2026-11-11 决策 D2 = A+B 合并）。
 *
 * 所有「按 kind 分支」的文案都走 ../logic/item-view.ts 的纯函数，
 * 以便状态文案红线（考试不得出现「未参加/未提交/已提交」）能被单测断言，
 * 而不是埋在模板里。
 *
 * 两个刻意的取舍（均在 task-5 汇报里说明）：
 *  1. 文件保留名 AssignmentTable.vue（未更名 ItemTable.vue）：
 *     `scripts/fluent-ui-e2e.mjs` 依赖 `.assignment-table` / `.assignment-scroll` 选择器。
 *  2. 「类型」列放在标题之后（平台 | 标题 | 类型 | 课程 | …）：
 *     `scripts/filter-e2e.mjs:105` 用 `tbody tr td:nth-child(2) .title` 取行标题，
 *     标题必须留在第 2 格，否则该回归脚本静默失效（scripts/ 不在本任务写作用域内）。
 */
import type { UiAssignment } from '../../../shared/ipc';
import {
  attendanceBadge,
  kindBadge,
  remainingCell,
  rowClass,
  statusCell,
  timeCell,
} from '../logic/item-view';

const props = defineProps<{ assignments: UiAssignment[]; nowMs: number }>();
const emit = defineEmits<{ open: [a: UiAssignment] }>();
</script>

<template>
  <!-- aria-label 刻意保留「作业列表，可横向滚动查看所有列」作为前缀：
       scripts/fluent-ui-e2e.mjs:149 用 getByRole('region', { name: '作业列表，可横向滚动查看所有列' })
       定位本容器（Playwright 的 name 默认子串匹配），而 scripts/ 不在本任务写作用域内。
       尾部括注如实说明容器现在同时包含考试场次。 -->
  <div
    class="table-wrap assignment-scroll"
    role="region"
    aria-label="作业列表，可横向滚动查看所有列（含考试场次）"
    tabindex="0"
  >
    <table class="assignment-table" aria-label="作业与考试及其时间状态">
      <colgroup>
        <col class="col-source" />
        <col class="col-title" />
        <col class="col-kind" />
        <col class="col-course" />
        <col class="col-due" />
        <col class="col-remaining" />
        <col class="col-status" />
        <col class="col-action" />
      </colgroup>
      <thead>
        <tr>
          <th>平台</th>
          <th>标题</th>
          <th>类型</th>
          <th>课程</th>
          <th>时间</th>
          <th>剩余</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="a in assignments" :key="a.id" :class="rowClass(a, nowMs)">
          <td>
            <span v-if="a.isDemo" class="badge bad">演示</span>
            <span v-else class="badge muted">{{ a.source === 'hw' ? '作业平台' : '优学院' }}</span>
          </td>
          <td class="title-cell">
            <div class="title" :title="a.title">{{ a.title }}</div>
            <div v-if="a.overridden" class="sub">已手动修正</div>
          </td>
          <td>
            <span class="badge" :class="kindBadge(a).cls" :title="kindBadge(a).title">{{ kindBadge(a).text }}</span>
          </td>
          <td class="title-cell" :title="a.courseName ?? ''">{{ a.courseName ?? '—' }}</td>
          <td class="due-cell">
            <div :title="timeCell(a).primary">{{ timeCell(a).primary }}</div>
            <div
              v-if="timeCell(a).secondary"
              class="sub"
              :title="timeCell(a).secondary ?? ''"
            >
              {{ timeCell(a).secondary }}
            </div>
            <span
              v-if="timeCell(a).ambiguous"
              class="unverified-mark"
              title="该时间来自尚未用真实响应验证的接口字段，请到平台核对"
            >
              待核对
            </span>
          </td>
          <td class="remaining-cell">
            <span class="badge" :class="remainingCell(a, nowMs).cls" :title="remainingCell(a, nowMs).title">
              {{ remainingCell(a, nowMs).text }}
            </span>
          </td>
          <td class="status-cell">
            <span class="badge" :class="statusCell(a, nowMs).cls" :title="statusCell(a, nowMs).title">
              {{ statusCell(a, nowMs).text }}
            </span>
            <span
              v-if="attendanceBadge(a)"
              class="badge attendance-badge"
              :class="attendanceBadge(a)!.cls"
              :title="attendanceBadge(a)!.title"
            >
              {{ attendanceBadge(a)!.text }}
            </span>
          </td>
          <td>
            <button
              class="link open-link"
              :disabled="!a.detailUrl"
              :title="a.detailUrl ? `打开：${a.title}` : '暂无可打开的链接'"
              @click="emit('open', a)"
            >
              打开
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
