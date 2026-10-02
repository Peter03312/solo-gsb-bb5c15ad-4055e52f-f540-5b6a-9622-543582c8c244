'use strict';

// 集中配置，均可通过环境变量覆盖（详见 README）。
const path = require('path');

const ROOT = path.join(__dirname, '..');

const config = {
  root: ROOT,
  port: parseInt(process.env.PORT || '3000', 10),
  sessionSecret: process.env.SESSION_SECRET || 'rehearsal-callboard-dev-secret',
  // SQLite 数据文件；Compose 中挂载为持久化卷。
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'callboard.db'),
  // 首次初始化时写入演示数据（账号 + 一份可发布的示范草稿）。
  seedDemo: (process.env.SEED_DEMO ?? 'true') !== 'false',
  // 现场板轮询间隔（前端也有默认值，这里仅注入页面用）。
  nodeEnv: process.env.NODE_ENV || 'development'
};

module.exports = config;
