'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const config = require('./config');
const { db, ensureSchema } = require('./db');
const { seed } = require('./seed');
const { ApiError, unauthorized, forbidden, badRequest } = require('./errors');
const draftRepo = require('./repo-draft');
const pubRepo = require('./repo-publication');

// ---------- 启动：建表 + 数据初始化（幂等） ----------
ensureSchema();
const seeded = seed();
console.log(seeded ? '[startup] 完成首次数据初始化（账号 + 示范联排版本）' : '[startup] 数据已存在，直接启动');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.set('trust proxy', false);

app.use(
  session({
    name: 'callboard.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000 // 12 小时
    }
  })
);

// ---------- 鉴权辅助 ----------
function currentUser(req) {
  if (!req.session.userId) return null;
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.position_id,
              p.name AS position_name, u.active
         FROM users u LEFT JOIN positions p ON p.id = u.position_id
        WHERE u.id = ?`
    )
    .get(req.session.userId);
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user || !user.active) return next(unauthorized('登录已失效，请重新登录'));
  req.user = user;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) return next(forbidden('仅舞监可执行该操作'));
    next();
  };
}

// ---------- 认证 ----------
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post('/api/login', (req, res, next) => {
  try {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!username || !password) throw badRequest('请输入账号和密码');

    const row = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    // 账号不存在与密码错误统一文案，避免账号枚举。
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      throw new ApiError(401, 'BAD_CREDENTIALS', '账号或密码错误');
    }
    req.session.userId = row.id;
    const user = currentUser(req);
    res.json({ user: publicUser(user) });
  } catch (e) {
    next(e);
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    position_id: u.position_id,
    position_name: u.position_name
  };
}

// ---------- 基础数据 ----------
app.get('/api/positions', requireAuth, (req, res) => {
  res.json({ positions: pubRepo.getPositions() });
});

// ---------- 草稿（舞监编排） ----------
app.get('/api/draft', requireAuth, (req, res) => {
  const draft = draftRepo.getDraftRow();
  res.json({
    draft: {
      version: draft.version,
      updated_at: draft.updated_at,
      updated_by: draft.updated_by
    },
    cues: draftRepo.getCues(),
    dependencies: draftRepo.getEdges(),
    positions: pubRepo.getPositions()
  });
});

app.post('/api/draft/cues', requireAuth, requireRole('sm'), (req, res, next) => {
  try {
    const result = draftRepo.createCue(req.body || {}, req.user.id);
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

app.put('/api/draft/cues/:id', requireAuth, requireRole('sm'), (req, res, next) => {
  try {
    const result = draftRepo.updateCue(Number(req.params.id), req.body || {}, req.user.id);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

app.delete('/api/draft/cues/:id', requireAuth, requireRole('sm'), (req, res, next) => {
  try {
    const result = draftRepo.deleteCue(Number(req.params.id), req.body || {}, req.user.id);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// 仅校验、不发布：前端点“校验”时预览冲突项。
app.post('/api/draft/validate', requireAuth, requireRole('sm'), (req, res) => {
  const { validateDraft } = require('./scheduler');
  const result = validateDraft(draftRepo.getCues(), draftRepo.getEdges());
  res.json(result);
});

// 发布只读联排版本（校验草稿版本号 + 全部联排规则）。
app.post('/api/draft/publish', requireAuth, requireRole('sm'), (req, res, next) => {
  try {
    const { draft_version, notes } = req.body || {};
    const result = pubRepo.publish(draft_version, notes, req.user.id);
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

// ---------- 已发布版本（回看） ----------
app.get('/api/publications', requireAuth, (req, res) => {
  res.json({ publications: pubRepo.listPublications() });
});

app.get('/api/publications/:id', requireAuth, (req, res, next) => {
  try {
    res.json(pubRepo.getPublicationView(Number(req.params.id)));
  } catch (e) {
    next(e);
  }
});

// ---------- 现场板 ----------
app.get('/api/live', requireAuth, (req, res) => {
  const view = pubRepo.getLiveBoard();
  if (!view) {
    return res.json({
      empty: true,
      message: '舞监尚未发布任何联排版本',
      positions: pubRepo.getPositions()
    });
  }
  res.json(view);
});

// 岗位现场登记：实际开始 / 完成 / 预计结束（携带 publication_id 作版本号）。
app.post('/api/live/cues/:cueId/register', requireAuth, (req, res, next) => {
  try {
    const body = req.body || {};
    const publicationId = Number(body.publication_id);
    if (!Number.isInteger(publicationId)) throw badRequest('缺少 publication_id 版本号');
    const result = pubRepo.registerActual({
      publicationId,
      cueId: Number(req.params.cueId),
      user: req.user,
      op: String(body.op || ''),
      at: body.at,
      value: body.value,
      expectedVersion: body.version
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ---------- 静态前端（SPA） ----------
const publicDir = path.join(config.root, 'public');
app.use(express.static(publicDir));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ---------- 错误处理 ----------
app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details }
    });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
});

const server = app.listen(config.port, () => {
  console.log(`联排提示板已启动: http://localhost:${config.port}`);
});

module.exports = { app, server };
