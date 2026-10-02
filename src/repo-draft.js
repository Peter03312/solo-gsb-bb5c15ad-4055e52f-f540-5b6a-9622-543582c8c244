'use strict';

const { db } = require('./db');
const { badRequest, notFound, stale } = require('./errors');

const getDraftRow = () => db.prepare('SELECT * FROM draft WHERE id = 1').get();

const getCues = () =>
  db
    .prepare(
      `SELECT c.*, p.name AS position_name
         FROM cues c
         JOIN positions p ON p.id = c.position_id
        ORDER BY c.sort, c.id`
    )
    .all();

const getCueById = (id) =>
  db
    .prepare(
      `SELECT c.*, p.name AS position_name
         FROM cues c
         JOIN positions p ON p.id = c.position_id
        WHERE c.id = ?`
    )
    .get(id);

const getEdges = () =>
  db.prepare('SELECT pred_id AS pred, succ_id AS succ FROM dependencies').all();

// 解析前端提交的提示项字段。duration 以分钟输入（数字或 1.5 小数）。
function parseCueBody(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    out.title = String(body.title ?? '').trim();
    if (!out.title) throw badRequest('提示项名称不能为空', { field: 'title' });
  }
  if (!partial || body.code !== undefined) {
    out.code = String(body.code ?? '').trim().toUpperCase();
    if (!out.code) throw badRequest('提示项编号不能为空', { field: 'code' });
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(out.code))
      throw badRequest('编号只允许字母、数字、下划线或短横线（最多 20 位）', { field: 'code' });
  }
  if (!partial || body.position_id !== undefined) {
    out.position_id = Number(body.position_id);
    if (!Number.isInteger(out.position_id) || out.position_id <= 0)
      throw badRequest('必须指定有效岗位', { field: 'position_id' });
    const pos = db.prepare('SELECT id FROM positions WHERE id = ?').get(out.position_id);
    if (!pos) throw badRequest('岗位不存在', { field: 'position_id' });
  }
  if (!partial || body.planned_start !== undefined) {
    out.planned_start = parseLocalTime(body.planned_start, 'planned_start');
  }
  if (!partial || body.duration_min !== undefined) {
    const minutes = Number(body.duration_min);
    if (!Number.isFinite(minutes) || minutes <= 0)
      throw badRequest('时长必须为正数（分钟）', { field: 'duration_min' });
    out.duration_sec = Math.round(minutes * 60);
  }
  if (body.notes !== undefined) out.notes = String(body.notes ?? '').trim();
  return out;
}

// 浏览器 datetime-local 形如 "2026-10-05T19:00"，按本地时间解释。
function parseLocalTime(value, field) {
  const raw = String(value ?? '').trim();
  if (!raw) throw badRequest('计划开始时间不能为空', { field });
  const ms = Date.parse(raw.length === 16 ? `${raw}:00` : raw);
  if (!Number.isFinite(ms)) throw badRequest('时间格式不正确，应为 YYYY-MM-DDTHH:MM', { field });
  return ms;
}

function checkVersion(expected) {
  const current = getDraftRow().version;
  const ver = Number(expected);
  if (!Number.isInteger(ver)) throw badRequest('必须提供草稿版本号（draft_version）');
  if (ver !== current) throw stale(current);
  return current;
}

function bumpVersion(userId) {
  db.prepare(
    'UPDATE draft SET version = version + 1, updated_at = ?, updated_by = ? WHERE id = 1'
  ).run(Date.now(), userId);
  return getDraftRow().version;
}

// 解析前置编号列表（cue id 数组），排除自身与重复，校验存在性。
function resolvePreds(predIds, selfId) {
  if (!Array.isArray(predIds)) throw badRequest('predecessor_ids 必须是数组');
  const ids = [...new Set(predIds.map(Number))];
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) throw badRequest('前置提示项 ID 非法');
    if (selfId && id === selfId) throw badRequest('不能将自身设为前置');
    if (!getCueById(id)) throw badRequest(`前置提示项 ${id} 不存在`);
  }
  return ids;
}

function replaceDependencies(cueId, predIds) {
  db.prepare('DELETE FROM dependencies WHERE succ_id = ?').run(cueId);
  const ins = db.prepare('INSERT INTO dependencies (pred_id, succ_id) VALUES (?, ?)');
  predIds.forEach((pid) => {
    // pred=succ 数据库有 CHECK 拦截，这里再提前报出友好信息。
    if (pid === cueId) throw badRequest('不能将自身设为前置');
    ins.run(pid, cueId);
  });
}

function createCue(body, userId) {
  checkVersion(body.draft_version);
  const fields = parseCueBody(body);
  const predIds = resolvePreds(body.predecessor_ids ?? []);

  const existing = db.prepare('SELECT id FROM cues WHERE code = ?').get(fields.code);
  if (existing) throw badRequest(`编号 ${fields.code} 已存在`);

  return db.transaction(() => {
    const now = Date.now();
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM cues').get().m;
    const info = db
      .prepare(
        `INSERT INTO cues (code, title, position_id, planned_start, duration_sec, notes, sort, created_at, updated_at)
         VALUES (@code, @title, @position_id, @planned_start, @duration_sec, @notes, @sort, @now, @now)`
      )
      .run({ ...fields, notes: fields.notes ?? '', sort: maxSort + 1, now });
    const id = Number(info.lastInsertRowid);
    replaceDependencies(id, predIds);
    return { id, version: bumpVersion(userId) };
  })();
}

function updateCue(id, body, userId) {
  checkVersion(body.draft_version);
  const cue = getCueById(id);
  if (!cue) throw notFound(`提示项 ${id} 不存在`);
  const fields = parseCueBody(body, { partial: true });
  let predIds = null;
  if (body.predecessor_ids !== undefined) predIds = resolvePreds(body.predecessor_ids, id);

  if (fields.code) {
    const dup = db.prepare('SELECT id FROM cues WHERE code = ? AND id <> ?').get(fields.code, id);
    if (dup) throw badRequest(`编号 ${fields.code} 已存在`);
  }

  return db.transaction(() => {
    db.prepare(
      `UPDATE cues SET
         code = COALESCE(@code, code),
         title = COALESCE(@title, title),
         position_id = COALESCE(@position_id, position_id),
         planned_start = COALESCE(@planned_start, planned_start),
         duration_sec = COALESCE(@duration_sec, duration_sec),
         notes = COALESCE(@notes, notes),
         updated_at = @now
       WHERE id = @id`
    ).run({
      code: fields.code ?? null,
      title: fields.title ?? null,
      position_id: fields.position_id ?? null,
      planned_start: fields.planned_start ?? null,
      duration_sec: fields.duration_sec ?? null,
      notes: fields.notes ?? null,
      now: Date.now(),
      id
    });
    if (predIds) replaceDependencies(id, predIds);
    return { id, version: bumpVersion(userId) };
  })();
}

function deleteCue(id, body, userId) {
  checkVersion((body || {}).draft_version);
  if (!getCueById(id)) throw notFound(`提示项 ${id} 不存在`);
  return db.transaction(() => {
    // 相关 dependency 行由 ON DELETE CASCADE 自动清理。
    db.prepare('DELETE FROM cues WHERE id = ?').run(id);
    return { id, version: bumpVersion(userId) };
  })();
}

module.exports = {
  getDraftRow,
  getCues,
  getCueById,
  getEdges,
  createCue,
  updateCue,
  deleteCue,
  parseCueBody,
  parseLocalTime,
  checkVersion
};
