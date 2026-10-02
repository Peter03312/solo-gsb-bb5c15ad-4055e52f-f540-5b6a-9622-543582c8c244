'use strict';

// 联排规则引擎（纯函数，便于测试）：
//   1) findCycle          —— 依赖无环检查
//   2) validateDraft      —— 发布前校验：前置时序 + 同岗位时段不重叠 + 无环
//   3) computeLiveBoard   —— 按实际/预计结束重算未开始后项（只顺延，不早于计划），输出岗位冲突

const minute = 60 * 1000;

function plannedEnd(cue) {
  if (cue.planned_end != null) return cue.planned_end;
  return cue.planned_start + cue.duration_sec * 1000;
}

// 返回构成环的提示项 id 数组（有顺序），无环返回 null。
function findCycle(cues, edges) {
  const adj = new Map(cues.map((c) => [c.id, []]));
  for (const e of edges) {
    if (!adj.has(e.pred) || !adj.has(e.succ)) continue; // 忽略悬挂边（删除过程中不应出现）
    adj.get(e.pred).push(e.succ);
  }
  const color = new Map(); // 0=未访问 1=栈中 2=完成
  const stack = [];
  let cycle = null;

  const dfs = (u) => {
    if (cycle) return;
    color.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u)) {
      if (cycle) return;
      if (color.get(v) === 1) {
        const i = stack.indexOf(v);
        cycle = stack.slice(i).concat(v);
        return;
      }
      if (color.get(v) !== 2) dfs(v);
    }
    stack.pop();
    color.set(u, 2);
  };

  for (const c of cues) {
    if (color.get(c.id) !== 2) dfs(c.id);
    if (cycle) break;
  }
  return cycle;
}

// 发布前校验。返回 { ok, errors }；errors 中均带冲突项编号，可直接展示。
function validateDraft(cues, edges) {
  const byId = new Map(cues.map((c) => [c.id, c]));
  const errors = [];

  // 规则一：依赖无环。
  const cycle = findCycle(cues, edges);
  if (cycle) {
    const codes = cycle.map((id) => byId.get(id)?.code ?? `#${id}`);
    errors.push({
      type: 'cycle',
      cueIds: cycle,
      label: `前置关系存在环路：${codes.join(' → ')}`
    });
  }

  // 规则二：前置项计划结束不晚于后项计划开始（允许首尾相接）。
  for (const e of edges) {
    const p = byId.get(e.pred);
    const s = byId.get(e.succ);
    if (!p || !s) continue;
    const pEnd = plannedEnd(p);
    if (pEnd > s.planned_start) {
      errors.push({
        type: 'precedence',
        predId: p.id,
        succId: s.id,
        predEnd: pEnd,
        succStart: s.planned_start,
        overrunMs: pEnd - s.planned_start,
        label: `前置 ${p.code}「${p.title}」计划结束晚于后项 ${s.code}「${s.title}」开始 ${Math.ceil(
          (pEnd - s.planned_start) / minute
        )} 分钟`
      });
    }
  }

  // 规则三：同岗位时段不重叠（允许首尾相接：start < end 判为重叠）。
  const byPosition = new Map();
  for (const c of cues) {
    if (!byPosition.has(c.position_id)) byPosition.set(c.position_id, []);
    byPosition.get(c.position_id).push(c);
  }
  for (const group of byPosition.values()) {
    const sorted = [...group].sort((a, b) => a.planned_start - b.planned_start || a.id - b.id);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        const aEnd = plannedEnd(a);
        const bEnd = plannedEnd(b);
        if (a.planned_start < bEnd && b.planned_start < aEnd) {
          errors.push({
            type: 'overlap',
            cueAId: a.id,
            cueBId: b.id,
            positionId: a.position_id,
            start: Math.max(a.planned_start, b.planned_start),
            end: Math.min(aEnd, bEnd),
            label: `同岗位时段重叠：${a.code}「${a.title}」与 ${b.code}「${b.title}」`
          });
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// 现场重算。
// actuals: Map cueId -> { actual_start, actual_end, estimated_end }
// 返回 { schedule: Map cueId -> {...}, conflicts: [...] }
function computeLiveBoard(cues, edges, actuals) {
  const byId = new Map(cues.map((c) => [c.id, c]));
  const preds = new Map(cues.map((c) => [c.id, []]));
  for (const e of edges) {
    if (preds.has(e.succ) && byId.has(e.pred)) preds.get(e.succ).push(e.pred);
  }

  const schedule = new Map();

  const compute = (id, visiting = new Set()) => {
    if (schedule.has(id)) return schedule.get(id);
    const cue = byId.get(id);
    const a = actuals.get(id) || {};
    const pStart = cue.planned_start;
    const pEnd = plannedEnd(cue);
    const dur = cue.duration_sec * 1000;

    let status;
    let effectiveStart;
    let effectiveEnd;
    let delayMs = 0;

    if (a.actual_end != null) {
      status = 'done';
      effectiveStart = a.actual_start != null ? a.actual_start : pStart;
      effectiveEnd = a.actual_end;
      delayMs = effectiveStart - pStart;
    } else if (a.actual_start != null) {
      status = 'running';
      effectiveStart = a.actual_start;
      // 已开始：预计结束优先，否则按原时长推算。
      effectiveEnd = a.estimated_end != null ? a.estimated_end : effectiveStart + dur;
      delayMs = effectiveStart - pStart;
    } else {
      status = 'pending';
      let start = pStart;
      const waitingFor = [];
      // 后项按“前置的实际或预计结束”重算；只顺延，绝不早于原计划。
      if (!visiting.has(id)) {
        visiting.add(id);
        for (const pid of preds.get(id)) {
          const ps = compute(pid, visiting);
          waitingFor.push({ cueId: pid, readyAt: ps.effectiveEnd, status: ps.status });
          if (ps.effectiveEnd > start) start = ps.effectiveEnd;
        }
        visiting.delete(id);
      }
      effectiveStart = start;
      effectiveEnd = start + dur;
      // 尚未开始但岗位已给出预计结束（前瞻预报）时，以预计结束为准参与后项重算。
      if (a.estimated_end != null) {
        effectiveEnd = a.estimated_end;
      }
      delayMs = start - pStart;
      schedule.set(
        id,
        {
          cueId: id,
          status,
          plannedStart: pStart,
          plannedEnd: pEnd,
          effectiveStart,
          effectiveEnd,
          delayMs,
          waitingFor,
          actualStart: null,
          actualEnd: null,
          estimatedEnd: null
        }
      );
      return schedule.get(id);
    }

    schedule.set(id, {
      cueId: id,
      status,
      plannedStart: pStart,
      plannedEnd: pEnd,
      effectiveStart,
      effectiveEnd,
      delayMs,
      actualStart: a.actual_start ?? null,
      actualEnd: a.actual_end ?? null,
      estimatedEnd: a.estimated_end ?? null
    });
    return schedule.get(id);
  };

  for (const c of cues) compute(c.id);

  // 顺延岗位冲突：按实际/预计时段检测同岗位重叠（首尾相接不算冲突）。
  const byPosition = new Map();
  for (const c of cues) {
    if (!byPosition.has(c.position_id)) byPosition.set(c.position_id, []);
    byPosition.get(c.position_id).push(c);
  }
  const conflicts = [];
  for (const group of byPosition.values()) {
    const items = group
      .map((c) => ({ cue: c, s: schedule.get(c.id) }))
      .sort((x, y) => x.s.effectiveStart - y.s.effectiveStart || x.cue.id - y.cue.id);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const x = items[i];
        const y = items[j];
        if (x.s.effectiveStart < y.s.effectiveEnd && y.s.effectiveStart < x.s.effectiveEnd) {
          // 仅展示由顺延（相对计划发生偏移）导致的冲突。
          const caused = x.s.delayMs > 0 || y.s.delayMs > 0;
          conflicts.push({
            type: 'live_overlap',
            positionId: x.cue.position_id,
            cueAId: x.cue.id,
            cueBId: y.cue.id,
            start: Math.max(x.s.effectiveStart, y.s.effectiveStart),
            end: Math.min(x.s.effectiveEnd, y.s.effectiveEnd),
            causedByDelay: caused
          });
        }
      }
    }
  }

  return { schedule, conflicts };
}

module.exports = { findCycle, validateDraft, computeLiveBoard, plannedEnd };
