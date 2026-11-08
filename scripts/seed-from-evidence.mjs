/**
 * 用真实采集数据预热 store，验证从"采集 -> 归一化 -> 存储 -> UI 渲染"的完整链路。
 * 这只是**开发期验证脚本**，不参与打包，也不写死任何假数据到产品代码。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const evidence = join(process.cwd(), 'investigation', 'evidence');
const { readFileSync } = await import('node:fs');

const planRaw = JSON.parse(readFileSync(join(evidence, 'real-plan.json'), 'utf8'));
const hwRaw = JSON.parse(readFileSync(join(evidence, 'real-homework.json'), 'utf8'));

const plan = planRaw.find((e) => e.url.includes('/api/student/plan'));
const hw = hwRaw.find((e) => e.url.includes('/api/student/homework?'));

const planRows = plan.body.data.data;
const uploadRows = hw.body.data.data;

function parseDue(raw) {
  if (raw == null) return { dueAt: null, duePrecision: 'none' };
  const t = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m) {
    return {
      dueAt: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+08:00`,
      duePrecision: 'datetime',
    };
  }
  return { dueAt: null, duePrecision: 'none' };
}

const byId = new Map();
for (const p of planRows) byId.set(Number(p.id), { plan: p });
for (const u of uploadRows) {
  const k = Number(u.homeworkPlanId ?? u.planId ?? u.id);
  const cur = byId.get(k);
  if (cur) cur.upload = u;
  else byId.set(k, { upload: u });
}

const now = new Date().toISOString();
const assignments = [];
for (const [planId, pair] of byId) {
  const p = pair.plan;
  const u = pair.upload;
  const title = (p?.homeworkName ?? u?.homeworkName ?? '').trim();
  if (!title) continue;
  const parsed = parseDue(p?.deadlineDate ?? u?.deadlineDate ?? null);
  let status = 'unknown';
  let evidenceText = '平台未返回 submitted';
  if (p && typeof p.submitted === 'boolean') {
    status = p.submitted ? 'submitted' : 'not_submitted';
    evidenceText = `plan.submitted=${p.submitted}`;
  } else if (!p && u) {
    status = 'submitted';
    evidenceText = '仅在上传记录中出现，推断已提交';
  }
  assignments.push({
    source: 'hw',
    sourceAssignmentId: String(planId),
    id: `hw:${planId}`,
    courseId: null,
    courseName: (p?.courseName ?? u?.courseName ?? null) || null,
    title,
    detailUrl: 'https://hw.dgut.edu.cn/student/homeworkPlan',
    dueAt: parsed.dueAt,
    duePrecision: parsed.duePrecision,
    submissionStatus: status,
    statusEvidence: evidenceText,
    firstSeenAt: now,
    lastSeenAt: now,
    lastSyncAt: now,
    sourceUpdatedAt: p?.createTime ?? u?.uploadDate ?? null,
  });
}

assignments.sort((a, b) => {
  const x = a.dueAt ? Date.parse(a.dueAt) : Infinity;
  const y = b.dueAt ? Date.parse(b.dueAt) : Infinity;
  return x - y;
});

console.log(JSON.stringify({ count: assignments.length, assignments }, null, 2));
