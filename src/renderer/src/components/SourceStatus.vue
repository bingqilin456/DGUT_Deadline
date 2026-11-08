<script setup lang="ts">
import { computed } from 'vue';
import type { SourceId } from '@dgut-deadline/shared';
import type { SourceStateDto } from '../../../shared/ipc';

const props = defineProps<{ sources: SourceStateDto[] }>();
const emit = defineEmits<{ login: [source: SourceId] }>();

function chipClass(s: SourceStateDto): 'ok' | 'warn' | 'bad' {
  const st = s.session?.state;
  if (st === 'connected') return 'ok';
  if (st === 'needs_login' || st === 'platform_maintenance' || st === 'network_blocked') return 'warn';
  if (st === 'error') return 'bad';
  return 'warn';
}

function chipText(s: SourceStateDto): string {
  const st = s.session?.state;
  const map: Record<string, string> = {
    connected: '已连接',
    needs_login: '需要登录',
    network_blocked: '网络不可达',
    platform_maintenance: '平台维护中',
    error: '连接异常',
    unknown: '未连接',
  };
  return map[st ?? 'unknown'] ?? '未连接';
}

function lastText(s: SourceStateDto): string {
  if (!s.lastSuccessAt) return '从未成功同步';
  const d = new Date(s.lastSuccessAt);
  return `上次成功 ${d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`;
}

const visible = computed(() => props.sources);
</script>

<template>
  <div class="source-chips" aria-label="平台连接状态">
    <div v-for="s in visible" :key="s.source" class="chip">
      <div class="source-info">
        <div class="source-heading">
          <i class="dot" :class="chipClass(s)" aria-hidden="true" />
          <strong>{{ s.label }}</strong>
          <span class="source-state" :class="chipClass(s)">{{ chipText(s) }}</span>
          <span v-if="s.stale" class="badge warn">可能过期</span>
        </div>
        <div class="source-detail">
          <span>{{ s.count }} 条缓存作业</span>
          <span class="sync-meta">{{ lastText(s) }}</span>
        </div>
      </div>
      <button
        v-if="s.session?.state === 'needs_login' || s.session?.state === 'error' || !s.session"
        class="btn btn-sm source-login"
        @click="emit('login', s.source)"
      >
        登录
      </button>
    </div>
  </div>
</template>
