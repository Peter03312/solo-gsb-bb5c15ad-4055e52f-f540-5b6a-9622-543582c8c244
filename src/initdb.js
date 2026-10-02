'use strict';

// 启动入口脚本之一：建表 + 初始化数据（幂等，可重复执行）。
const { ensureSchema } = require('./db');
const { seed } = require('./seed');

ensureSchema();
const created = seed();
console.log(created ? '[initdb] 已写入初始账号与示范数据' : '[initdb] 数据库已存在数据，跳过播种');
