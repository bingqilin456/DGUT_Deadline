<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { AppSnapshot, UiAssignment } from '../../shared/ipc';
import type { SourceId } from '@dgut-deadline/shared';
import { dueToMs } from '@dgut-deadline/shared';
import AssignmentTable from './components/AssignmentTable.vue';
import FilterBar from './components/FilterBar.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import SourceStatus from './components/SourceStatus.vue';
import { DEFAULT_FILTER, applyFilter, type FilterState } from './logic/filter';
import { examPhase } from './logic/item-view';

const snap = ref<AppSnapshot | null>(null);
const loading = ref(true);
const syncing = ref(false);
const tab = ref<'list' | 'settings'>('list');
const nowMs = ref(Date.now());
const errorMsg = ref<string | null>(null);
/** 筛选状态。默认：只看未截止 + 截止最近在前。 */
const filter = ref<FilterState>({ ...DEFAULT_FILTER });

/** 筛选后要显示的作业。 */
const visibleAssignments = computed(() =>
  applyFilter(snap.value?.assignments ?? [], filter.value, nowMs.value),
);

let unsubscribe: (() => void) | null = null;
let clock: number | undefined;

async function refresh(): Promise<void> {
  try {
    snap.value = await window.dgut.getSnapshot();
    applyTheme();
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function applyTheme(): void {
  const theme = snap.value?.settings.theme ?? 'system';
  document.documentElement.dataset['theme'] = theme;
}

async function doSync(): Promise<void> {
  if (syncing.value) return;
  syncing.value = true;
  errorMsg.value = null;
  try {
    snap.value = await window.dgut.syncNow();
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    syncing.value = false;
  }
}

async function doLogin(source: SourceId): Promise<void> {
  try {
    await window.dgut.login(source);
    await refresh();
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function openAssignment(a: UiAssignment): Promise<void> {
  const r = await window.dgut.openAssignment(a.id);
  if (!r.ok) errorMsg.value = r.reason ?? '无法打开链接';
}

async function updateSettings(patch: Parameters<typeof window.dgut.updateSettings>[0]): Promise<void> {
  snap.value = await window.dgut.updateSettings(patch);
  applyTheme();
}

async function exportDiag(): Promise<void> {
  const r = await window.dgut.exportDiagnostics();
  if (r.ok && r.path) errorMsg.value = `诊断信息已导出：${r.path}`;
  else errorMsg.value = r.reason ?? '导出失败';
}

async function testNotification(): Promise<void> {
  const r = await window.dgut.testNotification();
  if (r.shown) {
    const pending =
      r.pendingReminders > 0 ? `当前有 ${r.pendingReminders} 条待触发提醒。` : '当前没有到期的提醒。';
    errorMsg.value = `已发送测试通知。${pending}${r.hint ?? ''}`;
  } else {
    errorMsg.value = `通知不可用：${r.reason ?? '未知原因'}`;
  }
}

const stats = computed(() => {
  const list = snap.value?.assignments ?? [];
  const now = nowMs.value;

  // 作业卡：只统计 kind==='homework'（考试没有提交状态，混进来会误计）。
  const unsubmitted = list.filter(
    (a) => a.kind === 'homework' && (a.submissionStatus === 'not_submitted' || a.submissionStatus === 'unknown'),
  );
  const dueSoon = unsubmitted.filter((a) => {
    if (a.kind !== 'homework') return false;
    const d = dueToMs(a.dueAt);
    if (d === null) return false;
    const diff = d - now;
    return diff > 0 && diff <= 72 * 3600 * 1000;
  });
  const submitted = list.filter((a) => a.kind === 'homework' && a.submissionStatus === 'submitted');

  // 考试卡：7 天内开考 + 进行中（由本地时间推导，不依赖未验证的 examState）。
  const exams = list.filter((a) => a.kind === 'exam');
  const examsSoon = exams.filter((a) => {
    if (a.kind !== 'exam') return false;
    const phase = examPhase(a, now);
    if (phase === 'ongoing') return true;
    if (phase !== 'upcoming') return false;
    const s = dueToMs(a.startsAt);
    if (s === null) return false;
    return s - now <= 7 * 24 * 3600 * 1000;
  });
  const examsOngoing = exams.filter((a) => a.kind === 'exam' && examPhase(a, now) === 'ongoing');

  return {
    unsubmitted: unsubmitted.length,
    dueSoon: dueSoon.length,
    submitted: submitted.length,
    examCount: exams.length,
    examsSoon: examsSoon.length,
    examsOngoing: examsOngoing.length,
  };
});

const lastSyncText = computed(() => {
  const t = snap.value?.lastSyncAt;
  if (!t) return '尚未同步';
  const d = new Date(t);
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
});

const banners = computed(() => {
  const out: { kind: 'warn' | 'danger' | 'info'; text: string; action?: { label: string; fn: () => void } }[] = [];
  const s = snap.value;
  if (!s) return out;
  // 演示模式优先提示，避免任何误认
  if (s.demoMode) {
    out.push({
      kind: 'danger',
      text: '当前为「演示模式」：列表中全部是虚构的演示数据，不是你的真实作业。请在设置中关闭演示模式以查看真实数据。',
    });
    return out;
  }
  if (!s.browserReady) {
    out.push({ kind: 'danger', text: '未检测到 Microsoft Edge，无法连接学校平台。请先安装 Edge 稳定版。' });
  }
  if (s.allFailed) {
    out.push({ kind: 'danger', text: '所有平台同步失败。下方显示的是上次缓存的数据，可能已过期。' });
  } else if (s.partialFailure) {
    out.push({ kind: 'warn', text: '部分平台同步失败，失败平台显示的是缓存数据。' });
  }
  for (const src of s.sources) {
    const st = src.session;
    if (!st || st.state === 'connected') continue;
    if (st.state === 'needs_login') {
      out.push({
        kind: 'warn',
        text: `${src.label}：${st.message}`,
        action: { label: '去登录', fn: () => void doLogin(src.source) },
      });
    } else if (st.state === 'network_blocked') {
      out.push({ kind: 'warn', text: `${src.label}：${st.message}` });
    } else if (st.state === 'platform_maintenance') {
      out.push({ kind: 'info', text: `${src.label}：${st.message}` });
    }
  }
  return out;
});

onMounted(async () => {
  unsubscribe = window.dgut.onSnapshot((s) => {
    snap.value = s;
    applyTheme();
  });
  await refresh();
  clock = window.setInterval(() => (nowMs.value = Date.now()), 30_000);
});

onUnmounted(() => {
  unsubscribe?.();
  if (clock) window.clearInterval(clock);
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m-12 5 3 3 5-5"/></svg>
        </span>
        <span>莞工 <span class="brand-en">Deadline</span></span>
      </div>
      <nav v-if="snap && !loading" class="tabs" aria-label="主导航">
        <button class="tab" :class="{ active: tab === 'list' }" :aria-current="tab === 'list' ? 'page' : undefined" @click="tab = 'list'">作业列表</button>
        <button class="tab" :class="{ active: tab === 'settings' }" :aria-current="tab === 'settings' ? 'page' : undefined" @click="tab = 'settings'">设置</button>
      </nav>
      <span class="spacer" />
      <span class="sync-meta topbar-sync">上次同步：{{ lastSyncText }}</span>
      <button class="btn btn-primary" :disabled="syncing" :aria-busy="syncing" @click="doSync">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17"/></svg>
        {{ syncing ? '同步中…' : '立即同步' }}
      </button>
    </header>

    <main class="content">
      <div v-if="loading" class="empty">正在加载…</div>

      <template v-else-if="snap">
        <div v-for="(b, i) in banners" :key="i" class="banner" :class="b.kind" role="status">
          <svg class="icon banner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/></svg>
          <span>{{ b.text }}</span>
          <button v-if="b.action" class="btn" @click="b.action.fn()">{{ b.action.label }}</button>
        </div>

        <div v-if="errorMsg" class="banner info" role="status">
          <span>{{ errorMsg }}</span>
        </div>

        <template v-if="tab === 'list'">
          <div class="section-heading">
            <h1>任务概览</h1>
            <span>作业按截止时间、考试按开考时间统一排序</span>
          </div>
          <div class="stats stats-4">
            <div class="stat pending">
              <div class="label">未完成作业</div>
              <div class="num">{{ stats.unsubmitted }}</div>
              <span class="stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M9 10h6m-6 4h6m-6 4h3"/></svg></span>
            </div>
            <div class="stat warn">
              <div class="label">72 小时内截止</div>
              <div class="num">{{ stats.dueSoon }}</div>
              <span class="stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>
            </div>
            <div class="stat exam">
              <div class="label">7 天内开考 / 进行中</div>
              <div class="num">{{ stats.examsSoon }}</div>
              <span class="stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/><path d="m15 15 2 2 3-3"/></svg></span>
            </div>
            <div class="stat ok">
              <div class="label">已完成作业</div>
              <div class="num">{{ stats.submitted }}</div>
              <span class="stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg></span>
            </div>
          </div>

          <SourceStatus :sources="snap.sources" @login="doLogin" />

          <FilterBar
            v-if="snap.assignments.length"
            :filter="filter"
            :all="snap.assignments"
            :now-ms="nowMs"
            :visible-count="visibleAssignments.length"
            @update:filter="filter = $event"
          />

          <AssignmentTable
            v-if="visibleAssignments.length"
            :assignments="visibleAssignments"
            :now-ms="nowMs"
            @open="openAssignment"
          />
          <div v-else-if="snap.assignments.length" class="table-wrap">
            <div class="empty">
              <div class="big">当前筛选条件下没有作业或考试</div>
              <div>
                共 {{ snap.assignments.length }} 条（{{ stats.unsubmitted + stats.submitted }} 条作业、
                {{ stats.examCount }} 场考试），被筛选条件排除了。
                <br />
                点上方「重置筛选」可恢复默认视图（只看未过期）。
              </div>
            </div>
          </div>
          <div v-else class="table-wrap">
            <div class="empty">
              <div class="big">暂无作业数据</div>
              <div>
                请先在上方完成平台登录并点击「立即同步」。
                <br />
                若同步失败，本应用不会把失败显示成"没有作业/没有考试"。
                <br />
                考试同步默认关闭（接口未用真实响应验证），可在设置中开启。
              </div>
            </div>
          </div>
        </template>

        <SettingsPanel
          v-else
          :settings="snap.settings"
          @update="updateSettings"
          @export="exportDiag"
          @test-notification="testNotification"
        />
      </template>
    </main>
  </div>
</template>
