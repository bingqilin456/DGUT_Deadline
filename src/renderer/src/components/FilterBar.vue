<script setup lang="ts">
import { computed } from 'vue';
import type { UiAssignment } from '../../../shared/ipc';
import {
  DEFAULT_FILTER,
  collectCourses,
  countBy,
  type FilterState,
} from '../logic/filter';

const props = defineProps<{
  filter: FilterState;
  /** 全部作业（未筛选），用于生成课程下拉与计数。 */
  all: UiAssignment[];
  nowMs: number;
  /** 筛选后可见数量。 */
  visibleCount: number;
}>();

const emit = defineEmits<{ 'update:filter': [f: FilterState] }>();

const courses = computed(() => collectCourses(props.all));
const counts = computed(() => countBy(props.all, props.nowMs));

function patch(p: Partial<FilterState>): void {
  emit('update:filter', { ...props.filter, ...p });
}

function reset(): void {
  emit('update:filter', { ...DEFAULT_FILTER });
}

/** 截止时间范围选项：选中"已截止"时自动关闭 hideExpired，避免互相矛盾。 */
function setDueRange(v: string): void {
  const r = v as FilterState['dueRange'];
  patch({ dueRange: r, ...(r === 'overdue' ? { hideExpired: false } : {}) });
}

const activeCount = computed(() => {
  const f = props.filter;
  let n = 0;
  if (f.kind !== 'all') n++;
  if (f.source !== 'all') n++;
  if (f.course !== 'all') n++;
  if (f.dueRange !== 'all') n++;
  if (f.remainRange !== 'all') n++;
  if (f.status !== 'all') n++;
  if (f.keyword.trim()) n++;
  return n;
});

const isDefault = computed(
  () => props.filter.hideExpired === true && activeCount.value === 0 && props.filter.sort === 'dueAsc',
);

/**
 * 类型 Tab（用户 2026-11-11 决策 D2 = A+B 合并）。
 * 分类依据是接口来源模块（kind 字段），与标题文字无关。
 */
const KIND_TABS = [
  { value: 'all', label: '全部' },
  { value: 'homework', label: '作业' },
  { value: 'exam', label: '考试' },
] as const;

function setKind(v: FilterState['kind']): void {
  patch({ kind: v });
}

const examTabActive = computed(() => props.filter.kind === 'exam');
</script>

<template>
  <div class="filters">
    <div class="kind-tabs" role="tablist" aria-label="按类型筛选">
      <!-- 计数用 CSS ::after + attr() 渲染，而不是嵌套 span：
           嵌套文本会进入按钮的 textContent，让按文字定位按钮的脚本（如
           scripts/exam-e2e.mjs 按 '考试' 精确匹配）失配。 -->
      <button
        v-for="t in KIND_TABS"
        :key="t.value"
        class="kind-tab"
        role="tab"
        :class="{ active: filter.kind === t.value }"
        :aria-selected="filter.kind === t.value"
        :data-count="t.value === 'all' ? counts.all : t.value === 'homework' ? counts.homework : counts.exam"
        :aria-label="`${t.label}（${t.value === 'all' ? counts.all : t.value === 'homework' ? counts.homework : counts.exam} 条）`"
        @click="setKind(t.value)"
      >{{ t.label }}</button>
      <span class="kind-hint">类型由数据来源模块决定，与标题文字无关</span>
    </div>

    <div class="filter-row filter-grid">
      <label class="filter-item">
        <span>平台</span>
        <select :value="filter.source" @change="patch({ source: ($event.target as HTMLSelectElement).value as FilterState['source'] })">
          <option value="all">全部（{{ counts.all }}）</option>
          <option value="hw">作业平台</option>
          <option value="ulearning">优学院</option>
        </select>
      </label>

      <label class="filter-item">
        <span>课程</span>
        <select :value="filter.course" @change="patch({ course: ($event.target as HTMLSelectElement).value })">
          <option value="all">全部课程（{{ courses.length }}）</option>
          <option v-for="c in courses" :key="c" :value="c">{{ c }}</option>
        </select>
      </label>

      <label class="filter-item">
        <span>时间</span>
        <select :value="filter.dueRange" @change="setDueRange(($event.target as HTMLSelectElement).value)">
          <option value="all">不限</option>
          <option value="today">今天内（24h）</option>
          <option value="3d">3 天内</option>
          <option value="7d">7 天内</option>
          <option value="30d">30 天内</option>
          <option value="overdue">{{ examTabActive ? '已结束' : '已过期' }}</option>
          <option value="unknown">时间待确认</option>
        </select>
      </label>

      <label class="filter-item">
        <span>剩余</span>
        <select :value="filter.remainRange" @change="patch({ remainRange: ($event.target as HTMLSelectElement).value as FilterState['remainRange'] })">
          <option value="all">不限</option>
          <option value="3h">3 小时内</option>
          <option value="24h">24 小时内</option>
          <option value="72h">72 小时内</option>
          <option value="7d">7 天内</option>
          <option value="none">时间未知</option>
        </select>
      </label>

      <label class="filter-item">
        <span>状态</span>
        <select :value="filter.status" @change="patch({ status: ($event.target as HTMLSelectElement).value as FilterState['status'] })">
          <option value="all">全部</option>
          <option value="not_submitted">{{ examTabActive ? '未交卷' : '未提交' }}</option>
          <option value="submitted">{{ examTabActive ? '已交卷' : '已提交' }}</option>
          <option value="unknown">状态待确认 / 参加状态未知</option>
          <option value="overdue">{{ examTabActive ? '已结束' : '已过期' }}</option>
        </select>
      </label>

      <label class="filter-item">
        <span>排序</span>
        <select :value="filter.sort" @change="patch({ sort: ($event.target as HTMLSelectElement).value as FilterState['sort'] })">
          <option value="dueAsc">时间最近优先</option>
          <option value="dueDesc">时间最远优先</option>
          <option value="course">按课程</option>
        </select>
      </label>
    </div>

    <div class="filter-row filter-actions">
      <label class="filter-item grow">
        <span>搜索</span>
        <input
          type="text"
          placeholder="搜索标题或课程…"
          :value="filter.keyword"
          @input="patch({ keyword: ($event.target as HTMLInputElement).value })"
        />
      </label>

      <label class="filter-item checkbox">
        <input
          type="checkbox"
          :checked="filter.hideExpired"
          @change="patch({ hideExpired: ($event.target as HTMLInputElement).checked })"
        />
        <span>隐藏已过期</span>
      </label>

      <span class="filter-summary">
        显示 <strong>{{ visibleCount }}</strong> / {{ counts.all }} 条
        <span v-if="counts.overdue > 0 && filter.hideExpired" class="muted">
          （已隐藏 {{ counts.overdue }} 条已过期）
        </span>
      </span>

      <button class="btn btn-sm" :disabled="isDefault" @click="reset">重置筛选</button>
    </div>
  </div>
</template>

<style scoped>
.filters {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  margin-bottom: 12px;
  box-shadow: var(--shadow);
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* 类型 Tab：全部 / 作业 / 考试（来源模块决定类型，非标题） */
.kind-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

.kind-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border: 1px solid var(--border-control);
  border-radius: 999px;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  white-space: nowrap;
}

.kind-tab:hover { background: var(--panel-raised); border-color: var(--brand); }

.kind-tab.active {
  background: var(--brand-soft);
  border-color: var(--brand);
  color: var(--brand);
  font-weight: 600;
}

/* 计数用伪元素渲染：既不影响按钮 textContent（脚本按文字定位更稳），也保持视觉一致。 */
.kind-tab::after {
  content: attr(data-count);
  margin-left: 6px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}

.kind-hint {
  font-size: 12px;
  color: var(--text-3);
  margin-left: 4px;
}

.filter-row + .filter-row {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.filter-grid {
  display: grid;
  grid-template-columns: 1fr 1.45fr 1fr 1fr 1fr 1.45fr;
  align-items: end;
}

.filter-grid .filter-item {
  display: flex;
  align-items: stretch;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.filter-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}

.filter-item.grow {
  flex: 1;
  min-width: 220px;
}

.filter-item.grow input {
  flex: 1;
  min-width: 0;
}

.filter-item.checkbox {
  gap: 4px;
  cursor: pointer;
}

.filter-item select,
.filter-item input[type='text'] {
  font-size: 13px;
  width: 100%;
  min-width: 0;
  max-width: none;
}

.filter-summary {
  font-size: 12px;
  color: var(--text-3);
  margin-left: auto;
}

.filter-summary .muted {
  color: var(--text-3);
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.filter-summary strong { color: var(--text); font-variant-numeric: tabular-nums; }

@media (max-width: 880px) {
  .filter-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .filter-summary { margin-left: 0; }
}

@media (max-width: 640px) {
  .filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .filter-item.grow { flex-basis: 100%; }
}
</style>
