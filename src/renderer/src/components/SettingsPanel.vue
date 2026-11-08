<script setup lang="ts">
import { computed } from 'vue';
import type { SettingsDto } from '../../../shared/ipc';
import DiagnosticPanel from './DiagnosticPanel.vue';

const props = defineProps<{ settings: SettingsDto }>();
const emit = defineEmits<{
  update: [patch: Partial<SettingsDto>];
  export: [];
  testNotification: [];
}>();

/** 按小时降序展示。 */
const thresholds = computed(() =>
  [...props.settings.thresholds].sort((a, b) => b.hours - a.hours),
);

/** 切换某个阈值的启用状态。 */
function toggleEnabled(hours: number, enabled: boolean): void {
  emit('update', {
    thresholds: props.settings.thresholds.map((t) =>
      t.hours === hours ? { ...t, enabled } : t,
    ),
  });
}

/** 切换某个阈值的"强制弹出"。 */
function toggleUrgent(hours: number, urgent: boolean): void {
  emit('update', {
    thresholds: props.settings.thresholds.map((t) =>
      t.hours === hours ? { ...t, urgent } : t,
    ),
  });
}

/** 新增自定义阈值。 */
function addThreshold(e: Event): void {
  const input = e.target as HTMLInputElement;
  const h = Number(input.value);
  if (!Number.isFinite(h) || h <= 0 || h > 24 * 30) {
    input.value = '';
    return;
  }
  const hours = Math.round(h);
  if (props.settings.thresholds.some((t) => t.hours === hours)) {
    input.value = '';
    return;
  }
  emit('update', {
    thresholds: [...props.settings.thresholds, { hours, enabled: true, urgent: hours <= 12 }],
  });
  input.value = '';
}

/** 删除自定义阈值（12/6/3/1 等内置项也能删，但至少保留一个）。 */
function removeThreshold(hours: number): void {
  if (props.settings.thresholds.length <= 1) return;
  emit('update', {
    thresholds: props.settings.thresholds.filter((t) => t.hours !== hours),
  });
}

function setSyncInterval(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(v) && v >= 0) emit('update', { syncIntervalMinutes: Math.floor(v) });
}

function setQuiet(patch: Partial<SettingsDto['quietHours']>): void {
  emit('update', { quietHours: { ...props.settings.quietHours, ...patch } });
}

function setTheme(e: Event): void {
  const v = (e.target as HTMLSelectElement).value as SettingsDto['theme'];
  emit('update', { theme: v });
}
</script>

<template>
  <div class="settings">
    <div class="field" style="display: block">
      <div style="display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap">
        <span class="label" style="width: auto">提醒阈值</span>
        <span class="hint" style="padding-left: 0">
          勾选「启用」才会提醒；勾选「强制」会在临近截止时弹出右下角窗口并闪烁任务栏，
          且<b>不受静默时段限制</b>。已提交的作业不会提醒，同一作业同一阈值只提醒一次。
        </span>
      </div>

      <table class="threshold-table">
        <thead>
          <tr>
            <th style="width: 110px">提前</th>
            <th style="width: 80px">启用</th>
            <th style="width: 90px">强制弹出</th>
            <th>说明</th>
            <th style="width: 60px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in thresholds" :key="t.hours">
            <td><strong>{{ t.hours }}</strong> 小时</td>
            <td>
              <input
                type="checkbox"
                :checked="t.enabled"
                @change="toggleEnabled(t.hours, ($event.target as HTMLInputElement).checked)"
              />
            </td>
            <td>
              <input
                type="checkbox"
                :checked="t.urgent"
                :disabled="!t.enabled"
                @change="toggleUrgent(t.hours, ($event.target as HTMLInputElement).checked)"
              />
            </td>
            <td class="muted-sm">
              <span v-if="!t.enabled">已关闭，不会提醒</span>
              <span v-else-if="t.urgent">
                {{ t.hours <= 1 ? '最后 1 小时强提醒' : `剩 ${t.hours} 小时强提醒` }}（弹窗 + 任务栏闪烁）
              </span>
              <span v-else>普通提醒（静默时段内不弹）</span>
            </td>
            <td>
              <button class="link" @click="removeThreshold(t.hours)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>

      <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px">
        <span class="muted-sm">新增阈值：</span>
        <input
          type="number"
          min="1"
          max="720"
          placeholder="小时数"
          style="width: 90px"
          @keyup.enter="addThreshold"
        />
        <span class="muted-sm">小时后按回车添加</span>
      </div>
    </div>

    <div class="field">
      <span class="label">自动同步间隔</span>
      <input
        type="number"
        min="0"
        max="1440"
        style="width: 90px"
        :value="settings.syncIntervalMinutes"
        @change="setSyncInterval"
      />
      <span>分钟（0 = 关闭自动同步）</span>
      <span class="hint">同步会复用已登录的浏览器会话；频率过高可能给学校平台带来压力，建议 ≥ 30 分钟。</span>
    </div>

    <div class="field">
      <span class="label">静默时段</span>
      <input
        type="checkbox"
        :checked="settings.quietHours.enabled"
        @change="setQuiet({ enabled: ($event.target as HTMLInputElement).checked })"
      />
      <span>启用</span>
      <input
        type="time"
        :value="settings.quietHours.start"
        :disabled="!settings.quietHours.enabled"
        @change="setQuiet({ start: ($event.target as HTMLInputElement).value })"
      />
      <span>至</span>
      <input
        type="time"
        :value="settings.quietHours.end"
        :disabled="!settings.quietHours.enabled"
        @change="setQuiet({ end: ($event.target as HTMLInputElement).value })"
      />
      <span class="hint">静默时段内不弹出系统通知（支持跨零点，例如 23:00 至 07:00）。</span>
    </div>

    <div class="field">
      <span class="label">开机自启</span>
      <input
        type="checkbox"
        :checked="settings.launchAtLogin"
        @change="emit('update', { launchAtLogin: ($event.target as HTMLInputElement).checked })"
      />
      <span>登录 Windows 后自动启动</span>
      <span class="hint">默认为关闭。如不开启，软件只能在运行时提醒。</span>
    </div>

    <div class="field">
      <span class="label">关闭窗口</span>
      <input
        type="checkbox"
        :checked="settings.minimizeToTrayOnClose"
        @change="
          emit('update', { minimizeToTrayOnClose: ($event.target as HTMLInputElement).checked })
        "
      />
      <span>最小化到系统托盘（不退出）</span>
      <span class="hint">真正退出请使用托盘菜单中的「退出」。</span>
    </div>

    <div class="field">
      <span class="label">未知状态提醒</span>
      <input
        type="checkbox"
        :checked="settings.notifyUnknownStatus"
        @change="
          emit('update', { notifyUnknownStatus: ($event.target as HTMLInputElement).checked })
        "
      />
      <span>对"提交状态未知"的作业给出低确定性提醒</span>
      <span class="hint">提醒文案会是「请核对作业状态」，不会写成「你还没交」。</span>
    </div>

    <div class="field">
      <span class="label">演示模式</span>
      <input
        type="checkbox"
        :checked="settings.showDemoData === true"
        @change="
          emit('update', { showDemoData: ($event.target as HTMLInputElement).checked })
        "
      />
      <span>显示虚构的演示数据（用于预览提醒效果）</span>
      <span class="hint">
        开启后列表中全部是<b>虚构数据</b>，每条都会标注「演示」并显示醒目的红色横幅，
        且不会触发真实通知。关闭后恢复你的真实作业。
      </span>
    </div>

    <div class="field">
      <span class="label">主题</span>
      <select :value="settings.theme" @change="setTheme">
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </div>

    <div class="field">
      <span class="label">通知测试</span>
      <button class="btn" @click="emit('testNotification')">发送测试通知</button>
      <span class="hint">
        实机验证 Windows 通知是否可用。若没看到通知，请检查「设置 → 系统 → 通知」中是否允许本应用，
        以及是否开启了专注助手/勿扰模式。
      </span>
    </div>

    <DiagnosticPanel />

    <div class="field">
      <span class="label">诊断信息</span>
      <button class="btn" @click="emit('export')">导出脱敏诊断信息</button>
      <span class="hint">
        导出内容包含版本、Edge 检测结果、同步状态统计；<strong>不包含</strong>Cookie、Token、密码或作业正文。
      </span>
    </div>

    <p class="footer-note">
      本软件仅读取你在学校平台上有权查看的作业信息，不会提交作业、不会修改任何学校数据，
      也不会接入 AI、云服务器或任何付费接口。所有数据保存在你的本机。
    </p>
  </div>
</template>
