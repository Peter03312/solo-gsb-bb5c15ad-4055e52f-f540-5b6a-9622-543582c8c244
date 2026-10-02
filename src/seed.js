'use strict';

const bcrypt = require('bcryptjs');
const { db } = require('./db');
const config = require('./config');

// 演示日期固定为 +08:00 时区，避免容器时区影响。
const t = (s) => Date.parse(`2026-10-05T${s}+08:00`);

const POSITIONS = ['灯光', '音响', '机械'];

const SEED_USERS = [
  { username: 'sm', password: 'admin123', displayName: '舞台监督', role: 'sm', position: null },
  { username: 'lighting', password: 'exec123', displayName: '灯光执行', role: 'exec', position: '灯光' },
  { username: 'sound', password: 'exec123', displayName: '音响执行', role: 'exec', position: '音响' },
  { username: 'machinery', password: 'exec123', displayName: '机械执行', role: 'exec', position: '机械' }
];

// 一份可直接通过校验的示范草稿（前置闭环 + 无同岗位重叠）。
const SEED_CUES = [
  { code: 'C1', title: '开场灯光就位', position: '灯光', start: '19:00:00', duration: 180, deps: [] },
  { code: 'C2', title: '开场音乐起', position: '音响', start: '19:00:00', duration: 240, deps: [] },
  { code: 'C3', title: '吊杆景片就位', position: '机械', start: '19:04:00', duration: 240, deps: ['C1', 'C2'] },
  { code: 'C4', title: '景片移动至表演区', position: '机械', start: '19:08:00', duration: 300, deps: ['C3'] },
  { code: 'C5', title: '追光定点', position: '灯光', start: '19:14:00', duration: 240, deps: ['C4'] },
  { code: 'C6', title: '音效切换', position: '音响', start: '19:18:00', duration: 120, deps: ['C5'] }
];

// 幂等播种：仅在全新数据库（无账号）时写入。
function seed() {
  if (!config.seedDemo) return false;
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return false;

  const now = Date.now();
  const run = db.transaction(() => {
    const insPos = db.prepare(
      'INSERT INTO positions (name, created_at) VALUES (?, ?)'
    );
    const posId = {};
    POSITIONS.forEach((name) => {
      posId[name] = Number(insPos.run(name, now).lastInsertRowid);
    });

    const insUser = db.prepare(
      `INSERT INTO users (username, password_hash, display_name, role, position_id, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    );
    SEED_USERS.forEach((u) => {
      insUser.run(
        u.username,
        bcrypt.hashSync(u.password, 10),
        u.displayName,
        u.role,
        u.position ? posId[u.position] : null,
        now
      );
    });

    const insCue = db.prepare(
      `INSERT INTO cues (code, title, position_id, planned_start, duration_sec, notes, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`
    );
    const cueIdByCode = {};
    SEED_CUES.forEach((c, i) => {
      cueIdByCode[c.code] = Number(
        insCue.run(c.code, c.title, posId[c.position], t(c.start), c.duration, i + 1, now, now).lastInsertRowid
      );
    });

    const insDep = db.prepare(
      'INSERT INTO dependencies (pred_id, succ_id) VALUES (?, ?)'
    );
    SEED_CUES.forEach((c) => {
      c.deps.forEach((predCode) => {
        insDep.run(cueIdByCode[predCode], cueIdByCode[c.code]);
      });
    });

    // 直接发布一份只读初始版本，让执行岗位登录后即可现场登记。
    const sm = db.prepare("SELECT id FROM users WHERE username = 'sm'").get();
    const cues = db
      .prepare(
        `SELECT c.*, p.name AS position_name FROM cues c JOIN positions p ON p.id = c.position_id`
      )
      .all();
    const deps = db.prepare('SELECT pred_id, succ_id FROM dependencies').all();
    const pubId = Number(
      db
        .prepare('INSERT INTO publications (draft_version, notes, created_at, created_by) VALUES (1, ?, ?, ?)')
        .run('初始示范版本', now, sm.id).lastInsertRowid
    );
    const insCV = db.prepare(
      `INSERT INTO cue_versions
         (publication_id, cue_id, code, title, position_id, planned_start, planned_end, duration_sec, notes, sort)
       VALUES (@publication_id, @cue_id, @code, @title, @position_id, @planned_start, @planned_end,
               @duration_sec, @notes, @sort)`
    );
    cues.forEach((c) => {
      insCV.run({
        publication_id: pubId,
        cue_id: c.id,
        code: c.code,
        title: c.title,
        position_id: c.position_id,
        planned_start: c.planned_start,
        planned_end: c.planned_start + c.duration_sec * 1000,
        duration_sec: c.duration_sec,
        notes: c.notes,
        sort: c.sort
      });
    });
    const insDV = db.prepare(
      'INSERT INTO dependency_versions (publication_id, pred_cue_id, succ_cue_id) VALUES (?, ?, ?)'
    );
    deps.forEach((d) => insDV.run(pubId, d.pred_id, d.succ_id));
  });

  run();
  return true;
}

module.exports = { seed };
