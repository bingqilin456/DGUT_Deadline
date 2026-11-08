<script setup lang="ts">
import { ref } from 'vue';
import type { SourceId } from '@dgut-deadline/shared';
import type { SourceDiagnostic } from '../../../shared/ipc';

const diag = ref<SourceDiagnostic | null>(null);
const running = ref(false);
const error = ref<string | null>(null);

async function run(source: SourceId): Promise<void> {
  running.value = true;
  error.value = null;
  try {
    diag.value = await window.dgut.diagnoseSource(source);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <div class="field" style="display: block">
    <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
      <span class="label" style="width: auto">平台诊断</span>
      <button class="btn" :disabled="running" @click="run('hw')">
        {{ running ? '诊断中…' : '诊断莞工作业平台' }}
      </button>
      <button class="btn" :disabled="running" @click="run('ulearning')">
        {{ running ? '诊断中…' : '诊断优学院' }}
      </button>
    </div>
    <span class="hint" style="padding-left: 0">
      逐段检查登录链路，精确指出卡在哪一步。只读取状态，不涉及任何账号密码。
    </span>

    <div v-if="error" class="banner danger" style="margin-top: 12px">{{ error }}</div>

    <div v-if="diag" style="margin-top: 12px">
      <div class="banner" :class="diag.blockedAt ? 'warn' : 'info'">
        {{ diag.summary }}
      </div>
      <table style="margin-top: 8px">
        <thead>
          <tr>
            <th style="width: 80px">状态</th>
            <th style="width: 34%">检查项</th>
            <th>实测结果</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in diag.steps" :key="s.id">
            <td>
              <span
                class="badge"
                :class="s.neutral ? 'muted' : s.ok ? 'ok' : 'warn'"
              >{{ s.neutral ? '待进行' : s.ok ? '正常' : '异常' }}</span>
            </td>
            <td>{{ s.label }}</td>
            <td style="color: var(--text-2)">{{ s.detail }}</td>
          </tr>
        </tbody>
      </table>
      <p class="footer-note">
        诊断时间：{{ new Date(diag.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) }}
      </p>
    </div>
  </div>
</template>
