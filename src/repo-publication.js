'use strict';

const { db } = require('./db');
const { notFound, stale, forbidden, badRequest, publishConflict } = require('./errors');
const { validateDraft, computeLiveBoard } = require('./scheduler');
const draftRepo = require('./repo-draft');

// ---------- 发布 ----------

// 校验通过则生成只读快照；失败抛出 PUBLISH_CONFLICT 并列出冲突项。
function publish(expectedVersion, notes, userId) {
  const draft = draftRepo.getDraftRow();
  if (Number(expectedVersion) !== draft.version) throw stale(draft.version);

  const cues = draftRepo.getCues();
  if (cues.length === 0) throw publishConflict('草稿中没有任何提示项，无法发布');
  const edges = draftRepo.getEdges();
  const result = validateDraft(cues, edges);
  if (!result.ok) {
    throw publishConflict(`联排规则校验未通过，共 ${result.errors.length} 项冲突`, {
      errors: result.errors
    });
  }

  return db.transaction(() => {
    const now = Date.now();
    const pubId = Number(
      db
        .prepare(
          'INSERT INTO publications (draft_version, notes, created_at, created_by) VALUES (?, ?, ?, ?)'
        )
        .run(draft.version, String(notes ?? '').trim(), now, userId).lastInsertRowid
    );

    const insCV = db.prepare(
      `INSERT INTO cue_versions
         (publication_id, cue_id, code, title, position_id, planned_start, planned_end,
          duration_sec, notes, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    cues.forEach((c) => {
      insCV.run(
        pubId,
        c.id,
        c.code,
        c.title,
        c.position_id,
        c.planned_start,
        c.planned_start + c.duration_sec * 1000,
        c.duration_sec,
        c.notes ?? '',
        c.sort
      );
    });

    const insDV = db.prepare(
      'INSERT INTO dependency_versions (publication_id, pred_cue_id, succ_cue_id) VALUES (?, ?, ?)'
    );
    edges.forEach((e) => insDV.run(pubId, e.pred, e.succ));

    return { publicationId: pubId, draftVersion: draft.version, createdAt: now };
  })();
}

const listPublications = () =>
  db
    .prepare(
      `SELECT p.id, p.draft_version, p.notes, p.created_at,
              u.display_name AS created_by_name,
              (SELECT COUNT(*) FROM cue_versions cv WHERE cv.publication_id = p.id) AS cue_count
         FROM publications p
         LEFT JOIN users u ON u.id = p.created_by
        ORDER BY p.id DESC`
    )
    .all();

function getPublicationRow(id) {
  const row = db
    .prepare('SELECT * FROM publications WHERE id = ?')
    .get(Number(id));
  if (!row) throw notFound(`版本 ${id} 不存在`);
  return row;
}

const getVersionCues = (pubId) =>
  db
    .prepare(
      `SELECT cv.*, p.name AS position_name
         FROM cue_versions cv
         JOIN positions p ON p.id = cv.position_id
        WHERE cv.publication_id = ?
        ORDER BY cv.sort, cv.id`
    )
    .all(Number(pubId));

const getVersionEdges = (pubId) =>
  db
    .prepare(
      `SELECT pred_cue_id AS pred, succ_cue_id AS succ
         FROM dependency_versions WHERE publication_id = ?`
    )
    .all(Number(pubId));

const getPositions = () =>
  db.prepare('SELECT id, name FROM positions ORDER BY id').all();

const getActualsFor = (pubId) =>
  db.prepare('SELECT * FROM actuals WHERE publication_id = ?').all(Number(pubId));

const latestPublicationId = () => {
  const row = db.prepare('SELECT MAX(id) AS id FROM publications').get();
  return row.id ? Number(row.id) : null;
};

// 某版本的完整只读视图（已发布版本回看）。
function getPublicationView(id) {
  const pub = getPublicationRow(id);
  const cues = getVersionCues(id);
  const edges = getVersionEdges(id);
  const actualRows = getActualsFor(id);
  const actuals = new Map(
    actualRows.map((a) => [
      a.cue_id,
      {
        actual_start: a.actual_start,
        actual_end: a.actual_end,
        estimated_end: a.estimated_end
      }
    ])
  );
  const normalized = cues.map((c) => ({ ...c, id: c.cue_id }));
  const { schedule, conflicts } = computeLiveBoard(normalized, edges, actuals);
  return {
    publication: pub,
    positions: getPositions(),
    cues: mergeSchedule(normalized, schedule),
    edges,
    conflicts: annotateConflicts(conflicts, normalized),
    isLatest: latestPublicationId() === Number(id)
  };
}

// 现场板：始终基于最新发布版本；没有任何版本时返回 null。
function getLiveBoard() {
  const id = latestPublicationId();
  if (id == null) return null;
  return getPublicationView(id);
}

function mergeSchedule(cues, schedule) {
  return cues.map((c) => {
    const s = schedule.get(c.id);
    return {
      ...c,
      status: s.status,
      effective_start: s.effectiveStart,
      effective_end: s.effectiveEnd,
      delay_ms: s.delayMs,
      actual_start: s.actualStart,
      actual_end: s.actualEnd,
      estimated_end: s.estimatedEnd,
      waiting_for: (s.waitingFor ?? []).map((w) => ({
        cue_id: w.cueId,
        ready_at: w.readyAt,
        status: w.status
      }))
    };
  });
}

function annotateConflicts(conflicts, cues) {
  const byId = new Map(cues.map((c) => [c.id, c]));
  const positions = getPositions();
  return conflicts.map((cf) => ({
    type: cf.type,
    position_id: cf.positionId,
    cue_a_id: cf.cueAId,
    cue_b_id: cf.cueBId,
    start: cf.start,
    end: cf.end,
    caused_by_delay: cf.causedByDelay,
    cue_a_code: byId.get(cf.cueAId)?.code ?? '',
    cue_b_code: byId.get(cf.cueBId)?.code ?? '',
    cue_a_title: byId.get(cf.cueAId)?.title ?? '',
    cue_b_title: byId.get(cf.cueBId)?.title ?? '',
    position_name: byId.get(cf.cueAId)
      ? positions.find((p) => p.id === byId.get(cf.cueAId).position_id)?.name
      : ''
  }));
}

// ---------- 现场登记 ----------

function getActual(pubId, cueId) {
  return db
    .prepare('SELECT * FROM actuals WHERE publication_id = ? AND cue_id = ?')
    .get(pubId, cueId);
}

function ensureActual(pubId, cueId) {
  db.prepare(
    `INSERT OR IGNORE INTO actuals (publication_id, cue_id, updated_at)
     VALUES (?, ?, 0)`
  ).run(pubId, cueId);
  return getActual(pubId, cueId);
}

// 执行岗位登记。op: start | complete | estimate
function registerActual(opts) {
  const { publicationId, cueId, user, op, at, value, expectedVersion } = opts;
  const pub = getPublicationRow(publicationId);

  // 仅最新版本允许现场登记；在旧版本上操作给出明确版本提示。
  const latest = latestPublicationId();
  if (Number(publicationId) !== latest) {
    throw badRequest(
      `版本 ${publicationId} 不是最新联排版本（最新为 ${latest}），旧版本仅供回看，不能登记现场进度`
    );
  }
  if (expectedVersion !== undefined && Number(expectedVersion) !== pub.id) {
    throw stale(pub.id, '现场登记版本号已过期，可能舞监已发布新版本，请刷新页面');
  }

  const cue = db
    .prepare(
      `SELECT cv.*, p.name AS position_name FROM cue_versions cv
         JOIN positions p ON p.id = cv.position_id
        WHERE cv.publication_id = ? AND cv.cue_id = ?`
    )
    .get(publicationId, cueId);
  if (!cue) throw notFound('该版本中不存在此提示项');

  // 只有执行岗位能登记，且只能登记自己岗位的提示项；舞监账号现场板只读。
  if (user.role !== 'exec') {
    throw forbidden('仅执行岗位可登记现场进度，舞监账号在现场板只读');
  }
  if (user.position_id !== cue.position_id) {
    throw forbidden(`该提示项属于「${cue.position_name}」岗位，您只能登记本岗位的提示项`);
  }

  return db.transaction(() => {
    ensureActual(publicationId, cueId);
    const current = getActual(publicationId, cueId);
    const now = Date.now();
    const stamp = at != null ? parseStamp(at) : now;

    if (op === 'start') {
      if (current.actual_start != null)
        throw badRequest(`${cue.code} 已登记实际开始时间，不能重复登记`);
      if (current.actual_end != null)
        throw badRequest(`${cue.code} 已完成，不能再登记开始`);
      db.prepare(
        'UPDATE actuals SET actual_start = ?, updated_at = ?, updated_by = ? WHERE publication_id = ? AND cue_id = ?'
      ).run(stamp, now, user.id, publicationId, cueId);
    } else if (op === 'complete') {
      if (current.actual_end != null)
        throw badRequest(`${cue.code} 已登记完成时间，不能重复登记`);
      const start = current.actual_start ?? stamp;
      if (stamp < start) throw badRequest('完成时间不能早于实际开始时间');
      db.prepare(
        `UPDATE actuals SET actual_start = ?, actual_end = ?, estimated_end = NULL,
                           updated_at = ?, updated_by = ?
         WHERE publication_id = ? AND cue_id = ?`
      ).run(start, stamp, now, user.id, publicationId, cueId);
    } else if (op === 'estimate') {
      if (current.actual_end != null)
        throw badRequest(`${cue.code} 已完成，不能再更新预计结束`);
      const et = value != null ? parseStamp(value) : null;
      if (et == null || !Number.isFinite(et))
        throw badRequest('预计结束时间格式不正确');
      // 已开始项不得早于实际开始；未开始项不得早于按前置链重算出的顺延开始。
      let lowerBound;
      if (current.actual_start != null) {
        lowerBound = current.actual_start;
      } else {
        const view = getPublicationView(publicationId);
        lowerBound = view.cues.find((c) => c.id === cueId)?.effective_start ?? cue.planned_start;
      }
      if (et < lowerBound)
        throw badRequest(
          current.actual_start != null
            ? '预计结束时间不能早于实际开始时间'
            : '预计结束时间不能早于该提示项按前置链重算出的可开始时间（请顺延）'
        );
      db.prepare(
        'UPDATE actuals SET estimated_end = ?, updated_at = ?, updated_by = ? WHERE publication_id = ? AND cue_id = ?'
      ).run(et, now, user.id, publicationId, cueId);
    } else {
      throw badRequest(`未知登记类型：${op}（应为 start / complete / estimate）`);
    }

    return { publicationId, cueId, version: pub.id };
  })();
}

function parseStamp(value) {
  const raw = String(value).trim();
  const ms = Date.parse(raw.length === 16 ? `${raw}:00` : raw);
  if (!Number.isFinite(ms)) throw badRequest('时间格式不正确，应为 YYYY-MM-DDTHH:MM');
  return ms;
}

module.exports = {
  publish,
  listPublications,
  getPublicationView,
  getLiveBoard,
  registerActual,
  latestPublicationId,
  getVersionCues,
  getPositions
};
