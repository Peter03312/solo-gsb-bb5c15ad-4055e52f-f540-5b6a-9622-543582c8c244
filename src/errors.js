'use strict';

// 统一业务错误：携带 HTTP 状态码与机器可读 code，路由层据此返回 JSON。
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, 'BAD_REQUEST', message, details);
const unauthorized = (message = '请先登录') => new ApiError(401, 'UNAUTHORIZED', message);
const forbidden = (message = '没有执行该操作的权限') =>
  new ApiError(403, 'FORBIDDEN', message);
const notFound = (message = '资源不存在') => new ApiError(404, 'NOT_FOUND', message);
// 版本号过期 / 冲突（发布冲突也使用 409，靠 code 区分）。
const conflict = (message, code = 'CONFLICT', details) =>
  new ApiError(409, code, message, details);
const stale = (currentVersion, message) =>
  new ApiError(409, 'STALE_VERSION', message || `版本已过期，请刷新后重试（当前版本 ${currentVersion}）`, {
    currentVersion
  });
// 发布前联排规则校验失败。
const publishConflict = (message, details) =>
  new ApiError(409, 'PUBLISH_CONFLICT', message, details);

module.exports = {
  ApiError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  stale,
  publishConflict
};
