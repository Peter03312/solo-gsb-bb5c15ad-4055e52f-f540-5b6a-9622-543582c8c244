'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

// 保证数据目录存在（首次运行 / 空卷时）。
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 幂等建表：启动与 init-db 都会执行，已存在则跳过。
function ensureSchema() {
  db.exec(`
    -- 岗位（灯光 / 音响 / 机械……）
    CREATE TABLE IF NOT EXISTS positions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    -- 本地账号：role=sm 舞监；role=exec 执行岗位（绑定 position_id）
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('sm', 'exec')),
      position_id   INTEGER REFERENCES positions(id),
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL
    );

    -- 唯一一份可编辑草稿；version 即乐观锁版本号，每次改动 +1。
    CREATE TABLE IF NOT EXISTS draft (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      version    INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER,
      updated_by INTEGER REFERENCES users(id)
    );

    -- 草稿提示项：时长以秒存储，时间以毫秒时间戳存储。
    CREATE TABLE IF NOT EXISTS cues (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL,
      position_id   INTEGER NOT NULL REFERENCES positions(id),
      planned_start INTEGER NOT NULL,
      duration_sec  INTEGER NOT NULL CHECK (duration_sec > 0),
      notes         TEXT NOT NULL DEFAULT '',
      sort          INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    -- 前置关系：succ_id 必须等 pred_id 完成。
    CREATE TABLE IF NOT EXISTS dependencies (
      pred_id INTEGER NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
      succ_id INTEGER NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
      PRIMARY KEY (pred_id, succ_id),
      CHECK (pred_id <> succ_id)
    );

    -- 已发布联排版本（只读快照）。
    CREATE TABLE IF NOT EXISTS publications (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_version  INTEGER NOT NULL,
      notes          TEXT NOT NULL DEFAULT '',
      created_at     INTEGER NOT NULL,
      created_by     INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS cue_versions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      cue_id        INTEGER NOT NULL,
      code          TEXT NOT NULL,
      title         TEXT NOT NULL,
      position_id   INTEGER NOT NULL,
      planned_start INTEGER NOT NULL,
      planned_end   INTEGER NOT NULL,
      duration_sec  INTEGER NOT NULL,
      notes         TEXT NOT NULL DEFAULT '',
      sort          INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS dependency_versions (
      publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      pred_cue_id    INTEGER NOT NULL,
      succ_cue_id    INTEGER NOT NULL
    );

    -- 现场登记：实际开始 / 完成 / 预计结束，按“版本 × 提示项”唯一。
    CREATE TABLE IF NOT EXISTS actuals (
      publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      cue_id         INTEGER NOT NULL,
      actual_start   INTEGER,
      actual_end     INTEGER,
      estimated_end  INTEGER,
      updated_at     INTEGER NOT NULL,
      updated_by     INTEGER REFERENCES users(id),
      PRIMARY KEY (publication_id, cue_id)
    );

    CREATE INDEX IF NOT EXISTS idx_cue_versions_pub ON cue_versions(publication_id);
    CREATE INDEX IF NOT EXISTS idx_dep_versions_pub ON dependency_versions(publication_id);
    CREATE INDEX IF NOT EXISTS idx_actuals_pub ON actuals(publication_id);
  `);

  db.prepare(
    `INSERT OR IGNORE INTO draft (id, version) VALUES (1, 1)`
  ).run();
}

module.exports = { db, ensureSchema };
