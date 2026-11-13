/**
 * LMS 考试列表归一化测试。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ 本文件所有夹具都是**合成夹具，非真实平台响应**。
 * ═══════════════════════════════════════════════════════════════════════
 * 真实考试列表响应从未拿到：2026-11-10 复核 LMS 会话为 needs_login，
 * `/courseapi|utestapi/exams/student` 均 401 `{code:2001}`。
 * 这些用例验证的是**归一化逻辑对形状不确定性的处理方式**（抛错而不是静默返回空、
 * 时间解析失败不猜测、attendance 恒 unknown），**不能**证明真实接口的形状。
 * 回填依据：investigation/lms/exam-evidence.md §C.1 / docs/LMS-EXAM-PLAN.md §4.5。
 */

import { describe, expect, it } from 'vitest';
import {
  LmsExamParseError,
  LmsExamSessionExpiredError,
  extractExamRows,
  normalizeExamItems,
  type LmsExamRow,
} from './lms-exam.js';
import { fetchExamRowsWithFallback } from './ulearning-source.js';
import { DISPLAY_TZ_OFFSET, isAllowedDetailUrl } from '@dgut-deadline/shared';

const SYNC_AT = '2026-11-11T15:00:00+08:00';
const COURSE = { id: 162440, name: '2025面向对象程序设计（java）' };

/** 合成夹具：一场考试 + 两个场次。字段名按「代码证据（未验证）」形状书写。 */
function mkRow(overrides: Partial<LmsExamRow> = {}): LmsExamRow {
  return {
    // 未验证：examId 的真实类型（这里用数字，与作业 id 同风格）
    examId: 9001,
    title: '期末考试',
    // 未验证：考试级时间（刻意给空值，模拟"考试级时间可能为空"）
    startTime: '',
    endTime: '',
    examRelationTimeList: [
      // 未验证：场次时间类型（这里用毫秒，另有用例验证 ISO 字符串）
      { startTime: 1793705220000, endTime: 1793708820000, examRoomName: '教学楼A101', seatNo: '12' },
      { startTime: 1793712420000, endTime: 1793716020000 },
    ],
    ...overrides,
  };
}

describe('extractExamRows —— 容器识别不了必须抛错（绝不返回空数组）', () => {
  it('【关键】响应里没有 examList => 抛 parse_error 类错误', () => {
    expect(() => extractExamRows({ total: 3 })).toThrow(LmsExamParseError);
    expect(() => extractExamRows({ total: 3 })).toThrow(/examList/);
  });

  it('【关键】examList 不存在不能当成"没有考试"', () => {
    // 若这里返回 []，上层会把"读不懂"渲染成"你没有考试" —— 直接违反红线 3。
    let threw = false;
    try {
      extractExamRows({ data: [] });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('examList 存在但为 null => 抛错（与"空数组"语义不同）', () => {
    expect(() => extractExamRows({ examList: null })).toThrow(LmsExamParseError);
  });

  it('examList 不是数组 => 抛错', () => {
    expect(() => extractExamRows({ examList: {} })).toThrow(/不是数组/);
  });

  it('响应体不是 JSON 对象（例如 HTML 错误页被解析成 null）=> 抛错', () => {
    expect(() => extractExamRows(null)).toThrow(LmsExamParseError);
    expect(() => extractExamRows('<!doctype html>')).toThrow(LmsExamParseError);
  });

  it('examList: [] 是合法的"确认没有考试"（返回空数组，不抛）', () => {
    expect(extractExamRows({ total: 0, examList: [] })).toEqual([]);
  });

  it('过滤掉非对象元素', () => {
    const rows = extractExamRows({ examList: [{ examId: 1, title: 'A' }, 'junk', 42, null] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.examId).toBe(1);
  });
});

describe('normalizeExamItems —— 场次展开为 N 条', () => {
  it('两个场次 => 两条 ExamItem，身份键含 examId + 场次开始毫秒', () => {
    const r = normalizeExamItems(COURSE, [mkRow()], SYNC_AT);
    expect(r.items).toHaveLength(2);
    for (const x of r.items) {
      expect(x.kind).toBe('exam');
      expect(x.examId).toBe('9001');
      expect(x.sourceAssignmentId.startsWith('exam:9001@')).toBe(true);
      expect(x.id).toBe(`ulearning:${x.sourceAssignmentId}`);
      expect(x.timePrecision).toBe('datetime');
      expect(x.startsAt).not.toBeNull();
    }
    // 第一条场次：1793705220000
    expect(r.items[0]!.id).toBe('ulearning:exam:9001@1793705220000');
  });

  it('场次时间按升序排序，时间未知的置底', () => {
    const rows: LmsExamRow[] = [
      mkRow({ examId: 2, title: '晚的', examRelationTimeList: [{ startTime: 1793712420000 }] }),
      mkRow({ examId: 1, title: '早的', examRelationTimeList: [{ startTime: 1793705220000 }] }),
      mkRow({ examId: 3, title: '未知', examRelationTimeList: [] }),
    ];
    const r = normalizeExamItems(COURSE, rows, SYNC_AT);
    expect(r.items.map((x) => x.title)).toEqual(['早的', '晚的', '未知']);
  });

  it('ISO 字符串形态的场次时间也能解析（双格式探测）', () => {
    const r = normalizeExamItems(
      COURSE,
      [mkRow({ examRelationTimeList: [{ startTime: '2026-12-30T09:00:00+08:00' }] })],
      SYNC_AT,
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.startsAt).toBe(`2026-12-30T09:00:00${DISPLAY_TZ_OFFSET}`);
  });

  it('考场/座位仅展示，字段缺失时为 null 而不编造', () => {
    const r = normalizeExamItems(COURSE, [mkRow()], SYNC_AT);
    expect(r.items[0]!.venue).toEqual({ roomName: '教学楼A101', seatNo: '12' });
    // 第二个场次没有考场信息
    expect(r.items[1]!.venue).toBeNull();
  });

  it('课程信息正确带入', () => {
    const r = normalizeExamItems(COURSE, [mkRow()], SYNC_AT);
    expect(r.items[0]!.courseId).toBe('162440');
    expect(r.items[0]!.courseName).toBe('2025面向对象程序设计（java）');
  });
});

describe('normalizeExamItems —— 时间非法 => startsAt=null 且不丢条目', () => {
  it('【关键】场次开始时间无法解析 => 折成一条 @nostart 兜底项，不静默丢弃', () => {
    const r = normalizeExamItems(
      COURSE,
      [mkRow({ examRelationTimeList: [{ startTime: '另行通知', endTime: null }] })],
      SYNC_AT,
    );
    expect(r.items).toHaveLength(1);
    const item = r.items[0]!;
    expect(item.startsAt).toBeNull();
    expect(item.endsAt).toBeNull();
    expect(item.timePrecision).toBe('none');
    expect(item.sourceAssignmentId).toBe('exam:9001@nostart');
    // 必须告警，不允许静默
    expect(r.warnings.join('\n')).toContain('无法解析');
  });

  it('多个场次时间都非法 => 只生成一条 @nostart（每场考试至多一条）', () => {
    const r = normalizeExamItems(
      COURSE,
      [
        mkRow({
          examRelationTimeList: [{ startTime: 'bad1' }, { startTime: 'bad2' }, { startTime: 0 }],
        }),
      ],
      SYNC_AT,
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.id).toBe('ulearning:exam:9001@nostart');
  });

  it('只有日期没有时刻 => 不能定锚点，折成 @nostart（不补 00:00）', () => {
    const r = normalizeExamItems(
      COURSE,
      [mkRow({ examRelationTimeList: [{ startTime: '2026-12-30' }] })],
      SYNC_AT,
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.startsAt).toBeNull();
    expect(r.items[0]!.timePrecision).toBe('none');
  });

  it('开始时间可解析但结束时间非法 => startsAt 保留，endsAt=null + warning', () => {
    const r = normalizeExamItems(
      COURSE,
      [mkRow({ examRelationTimeList: [{ startTime: 1793705220000, endTime: 'nope' }] })],
      SYNC_AT,
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.startsAt).not.toBeNull();
    expect(r.items[0]!.endsAt).toBeNull();
    expect(r.warnings.join('\n')).toContain('结束时间无法解析');
  });

  it('部分场次时间非法 => 合法场次正常列出，非法场次计 warning（不补重复的 @nostart 行）', () => {
    const r = normalizeExamItems(
      COURSE,
      [
        mkRow({
          examRelationTimeList: [{ startTime: 1793705220000 }, { startTime: 'bad' }],
        }),
      ],
      SYNC_AT,
    );
    // 只有一条可见场次，不额外生成 @nostart（否则列表出现同名重复行）
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.startsAt).not.toBeNull();
    expect(r.warnings.join('\n')).toContain('无法解析，已跳过');
  });

  it('【关键】考试级 startTime 不得用来兜底场次时间', () => {
    // 考试级时间存在，但场次列表为空 ⇒ 只能是 @nostart，不能拿考试级时间当锚点
    const r = normalizeExamItems(
      COURSE,
      [mkRow({ startTime: 1793705220000, endTime: 1793708820000, examRelationTimeList: [] })],
      SYNC_AT,
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.startsAt).toBeNull();
    expect(r.items[0]!.timePrecision).toBe('none');
    expect(r.warnings.join('\n')).toContain('考试级时间存在但按设计不使用');
  });
});

describe('normalizeExamItems —— 空场次 / 缺字段的兜底', () => {
  it('examRelationTimeList 为空 => 生成一条 @nostart 兜底项（可见但不提醒）', () => {
    const r = normalizeExamItems(COURSE, [mkRow({ examRelationTimeList: [] })], SYNC_AT);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.startsAt).toBeNull();
    expect(r.items[0]!.timePrecision).toBe('none');
    expect(r.items[0]!.id).toBe('ulearning:exam:9001@nostart');
  });

  it('examRelationTimeList 字段缺失 => 同样生成 @nostart', () => {
    const row = mkRow();
    delete row.examRelationTimeList;
    const r = normalizeExamItems(COURSE, [row], SYNC_AT);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.startsAt).toBeNull();
  });

  it('examRelationTimeList 不是数组 => 按无场次处理 + warning', () => {
    const r = normalizeExamItems(COURSE, [mkRow({ examRelationTimeList: 'oops' })], SYNC_AT);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.startsAt).toBeNull();
    expect(r.warnings.join('\n')).toContain('不是数组');
  });

  it('缺少 examId => 跳过该场考试并计 warning（不用兜底键编 id）', () => {
    const r = normalizeExamItems(COURSE, [mkRow({ examId: undefined })], SYNC_AT);
    expect(r.items).toHaveLength(0);
    expect(r.warnings.join('\n')).toContain('缺少 examId');
  });

  it('examId 为空白字符串 => 视为缺失', () => {
    const r = normalizeExamItems(COURSE, [mkRow({ examId: '   ' })], SYNC_AT);
    expect(r.items).toHaveLength(0);
    expect(r.warnings.join('\n')).toContain('缺少 examId');
  });

  it('标题为空 => 跳过并计 warning（不生成空标题条目）', () => {
    const r = normalizeExamItems(COURSE, [mkRow({ title: '  ' })], SYNC_AT);
    expect(r.items).toHaveLength(0);
    expect(r.warnings.join('\n')).toContain('标题为空');
  });
});

describe('normalizeExamItems —— 个人交卷状态（2026-11-13 /utestapi/exams/student 实测响应）', () => {
  it('answerTimes >= 1 且有允许次数与得分（实测《3. 组合逻辑电路》形状）=> submitted + 次数 + 总分', () => {
    const row = mkRow({
      examId: 146063,
      title: '3. 组合逻辑电路',
      answerTimes: 1,
      limitTimes: 2,
      isLimitTimes: '1',
      subjective: 30,
      objective: 30,
      examState: 2,
      isInExam: 1,
      examFinish: '1;3',
    });
    const r = normalizeExamItems(COURSE, [row], SYNC_AT);
    expect(r.items.length).toBeGreaterThan(0);
    for (const x of r.items) {
      expect(x.attendance).toBe('submitted');
      expect(x.answerTimes).toBe(1);
      expect(x.limitTimes).toBe(2);
      expect(x.score).toBe(60);
      expect('submissionStatus' in x).toBe(false);
      expect(x.attendanceEvidence).toContain('answerTimes=1');
      expect(x.attendanceEvidence).toContain('limitTimes=2');
      expect(x.attendanceEvidence).toContain('score=60');
    }
  });

  it('answerTimes === 0 且有限制次数（实测《4. 时序逻辑电路》形状）=> not_submitted + 0/1 + score=null', () => {
    const row = mkRow({
      examId: 146117,
      title: '4. 时序逻辑电路',
      answerTimes: 0,
      limitTimes: 1,
      isLimitTimes: '1',
      subjective: null,
      objective: null,
      examState: 2,
      isInExam: 1,
    });
    const r = normalizeExamItems(COURSE, [row], SYNC_AT);
    for (const x of r.items) {
      expect(x.attendance).toBe('not_submitted');
      expect(x.answerTimes).toBe(0);
      expect(x.limitTimes).toBe(1);
      expect(x.score).toBeNull();
      expect(x.attendanceEvidence).toContain('answerTimes=0');
    }
  });

  it('isLimitTimes="0" 不限次数（实测《第一章测试》《第七章测试》形状）=> limitTimes=null', () => {
    const submittedUnlimited = mkRow({
      examId: 145425,
      title: '第一章测试',
      answerTimes: 1,
      limitTimes: 0,
      isLimitTimes: '0',
      subjective: 0,
      objective: 90,
    });
    const unsubmittedUnlimited = mkRow({
      examId: 146180,
      title: '第七章测试',
      answerTimes: 0,
      limitTimes: 0,
      isLimitTimes: '0',
      subjective: null,
      objective: null,
    });
    const r = normalizeExamItems(COURSE, [submittedUnlimited, unsubmittedUnlimited], SYNC_AT);
    const sub = r.items.find((i) => i.examId === '145425')!;
    const unsub = r.items.find((i) => i.examId === '146180')!;
    expect(sub.attendance).toBe('submitted');
    expect(sub.answerTimes).toBe(1);
    expect(sub.limitTimes).toBeNull();
    expect(sub.score).toBe(90);
    expect(unsub.attendance).toBe('not_submitted');
    expect(unsub.answerTimes).toBe(0);
    expect(unsub.limitTimes).toBeNull();
    expect(unsub.score).toBeNull();
  });

  it('answerTimes 缺失或非数字时保守降级为 unknown（红线 3：不猜状态，也不看 examState）', () => {
    const row = mkRow({
      examState: 3, // 即使考试已结束，缺少 answerTimes 也绝不能当成已交卷或未交卷
      examFinish: '1;2;3',
    });
    const r = normalizeExamItems(COURSE, [row], SYNC_AT);
    for (const x of r.items) {
      expect(x.attendance).toBe('unknown');
      expect(x.answerTimes).toBeNull();
      expect(x.limitTimes).toBeNull();
      expect(x.score).toBeNull();
    }
  });
});

describe('normalizeExamItems —— detailUrl 过 allowlist', () => {
  it('detailUrl 指向 lms.dgut.edu.cn 且能通过 allowlist 校验', () => {
    const r = normalizeExamItems(COURSE, [mkRow()], SYNC_AT);
    const url = r.items[0]!.detailUrl;
    expect(url).not.toBeNull();
    expect(url).toContain('lms.dgut.edu.cn');
    expect(url).toContain('/utest/#/exam/9001');
    // 未验证：hash 路由可达性未验证，但至少合法性必须通过校验
    expect(isAllowedDetailUrl('ulearning', url)).toBe(true);
  });

  it('examId 含特殊字符时被正确编码，不拼接出非法 URL', () => {
    const r = normalizeExamItems(COURSE, [mkRow({ examId: 'a/b c' })], SYNC_AT);
    expect(r.items[0]!.detailUrl).toBe('https://lms.dgut.edu.cn/utest/#/exam/a%2Fb%20c');
    expect(isAllowedDetailUrl('ulearning', r.items[0]!.detailUrl)).toBe(true);
  });
});

describe('normalizeExamItems —— 去重与身份稳定性', () => {
  it('同 examId + 同场次开始时间 => 去重并告警', () => {
    const r = normalizeExamItems(
      COURSE,
      [mkRow({ examRelationTimeList: [{ startTime: 1793705220000 }, { startTime: 1793705220000 }] })],
      SYNC_AT,
    );
    expect(r.items).toHaveLength(1);
    expect(r.warnings.join('\n')).toContain('重复场次');
  });

  it('不同 examId 但同开始时间 => 身份不同（不误去重）', () => {
    const r = normalizeExamItems(
      COURSE,
      [
        mkRow({ examId: 1, title: 'A', examRelationTimeList: [{ startTime: 1793705220000 }] }),
        mkRow({ examId: 2, title: 'B', examRelationTimeList: [{ startTime: 1793705220000 }] }),
      ],
      SYNC_AT,
    );
    expect(r.items.map((x) => x.id)).toEqual([
      'ulearning:exam:1@1793705220000',
      'ulearning:exam:2@1793705220000',
    ]);
  });

  it('【关键】场次开始时间变了 => id 变（改期后旧提醒键自然失效）', () => {
    const before = normalizeExamItems(
      COURSE,
      [mkRow({ examRelationTimeList: [{ startTime: 1793705220000 }] })],
      SYNC_AT,
    );
    const after = normalizeExamItems(
      COURSE,
      [mkRow({ examRelationTimeList: [{ startTime: 1793708820000 }] })],
      SYNC_AT,
    );
    expect(before.items[0]!.id).not.toBe(after.items[0]!.id);
  });

  it('作业 id 与考试 id 物理不撞车（作业恒纯数字，考试恒 exam: 前缀）', () => {
    const r = normalizeExamItems(COURSE, [mkRow({ examId: 500750 })], SYNC_AT);
    // 作业若是 id=500750，其 id 为 ulearning:500750
    expect(r.items[0]!.id.startsWith('ulearning:exam:')).toBe(true);
    expect(r.items[0]!.id).not.toBe('ulearning:500750');
  });
});

describe('fetchExamRowsWithFallback —— 先新后旧的双分支回退（§6.4）', () => {
  // ⚠️ 合成夹具：这些响应用来说明**分支决策逻辑**，不代表真实平台返回。
  const validBody = { total: 1, examList: [{ examId: 9001, title: '期末考试' }] };

  it('新分支 200 且容器可解析 => 直接用新分支，不再请求旧分支', async () => {
    const calls: string[] = [];
    const rows = await fetchExamRowsWithFallback(async (path) => {
      calls.push(path);
      return { status: 200, body: validBody };
    }, 162440);
    expect(rows).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/utestapi/exams/student');
    expect(calls[0]).toContain('ocId=162440');
  });

  it('新分支 404 => 回退旧分支（旧分支参数含 keyword 与 lang=zh）', async () => {
    const calls: string[] = [];
    const rows = await fetchExamRowsWithFallback(async (path) => {
      calls.push(path);
      if (path.includes('/utestapi/')) return { status: 404, body: null };
      return { status: 200, body: validBody };
    }, 162440);
    expect(rows).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('/courseapi/exams/student');
    expect(calls[1]).toContain('keyword=');
    expect(calls[1]).toContain('lang=zh');
  });

  it('新分支返回 HTML（body=null）=> 回退旧分支', async () => {
    const rows = await fetchExamRowsWithFallback(async (path) => {
      if (path.includes('/utestapi/')) return { status: 200, body: null };
      return { status: 200, body: validBody };
    }, 1);
    expect(rows).toHaveLength(1);
  });

  it('新分支容器不认识（无 examList）=> 回退旧分支', async () => {
    const rows = await fetchExamRowsWithFallback(async (path) => {
      if (path.includes('/utestapi/')) return { status: 200, body: { data: [] } };
      return { status: 200, body: validBody };
    }, 1);
    expect(rows).toHaveLength(1);
  });

  it('【关键】两条分支都失败 => 抛 parse_error，绝不返回空数组', async () => {
    await expect(
      fetchExamRowsWithFallback(
        async (path) =>
          path.includes('/utestapi/')
            ? { status: 404, body: null }
            : { status: 200, body: { data: [] } },
        162440,
      ),
    ).rejects.toThrow(LmsExamParseError);
  });

  it('业务码 2001 => 抛会话失效（不逐课程重试、不回退旧分支）', async () => {
    let calls = 0;
    await expect(
      fetchExamRowsWithFallback(async () => {
        calls++;
        return { status: 200, body: { code: 2001, message: '缺少访问token' } };
      }, 162440),
    ).rejects.toThrow(LmsExamSessionExpiredError);
    expect(calls).toBe(1); // 立即失败，不重试
  });

  it.each([2101, 2201])('业务码 %i => 会话失效', async (code) => {
    await expect(
      fetchExamRowsWithFallback(async () => ({ status: 200, body: { code } }), 162440),
    ).rejects.toThrow(LmsExamSessionExpiredError);
  });

  it.each([401, 403])('HTTP %i => 会话失效', async (status) => {
    await expect(
      fetchExamRowsWithFallback(async () => ({ status, body: null }), 162440),
    ).rejects.toThrow(LmsExamSessionExpiredError);
  });

  it('新分支 500、旧分支 200 => 回退后成功（非 404 的服务端错误也降级）', async () => {
    const rows = await fetchExamRowsWithFallback(async (path) => {
      if (path.includes('/utestapi/')) return { status: 500, body: null };
      return { status: 200, body: validBody };
    }, 1);
    expect(rows).toHaveLength(1);
  });

  it('新分支 examList: [] 是合法空列表 => 直接返回空，不回退', async () => {
    const calls: string[] = [];
    const rows = await fetchExamRowsWithFallback(async (path) => {
      calls.push(path);
      return { status: 200, body: { total: 0, examList: [] } };
    }, 1);
    expect(rows).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
