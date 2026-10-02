'use strict';

/* =========================================================
 * 联排提示板前端（原生 JS SPA）
 * 视图：#/live 现场板（默认）  #/draft 编排（舞监）  #/versions 版本回看
 * ========================================================= */

const state = {
  user: null,
  tab: 'live',
  live: null,
  liveError: null,
  draft: null,
  modal: null,
  toasts: [],
  pollTimer: null,
  publishing: false
};

const $app = document.getElementById('app');

/* ---------------- 工具 ---------------- */

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// 毫秒 -> "MM-DD HH:mm:ss"；秒精度可关。
function fmtTime(ms, withSeconds = true) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const base = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

function fmtHM(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  return `${m} 分钟`;
}

function fmtDelay(ms) {
  if (!ms || ms <= 0) return '';
  const m = Math.round(ms / 60000);
  return m >= 1 ? `顺延约 ${m} 分钟` : '顺延不足 1 分钟';
}

// datetime-local 本地字符串（秒精度，可被 input 接受到分钟）。
function toLocalInput(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* 非 JSON */
  }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `请求失败（${res.status}）`);
    err.status = res.status;
    err.code = data && data.error && data.error.code;
    err.details = data && data.error && data.error.details;
    throw err;
  }
  return data;
}

function toast(message, type = 'info', ttl = 4000) {
  const id = Date.now() + Math.random();
  state.toasts.push({ id, message, type });
  render();
  setTimeout(() => {
    state.toasts = state.toasts.filter((t) => t.id !== id);
    render();
  }, ttl);
}

/* ---------------- 启动与路由 ---------------- */

async function boot() {
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modal) closeModal();
  });
  (async () => {
    try {
      const me = await api('GET', '/api/me');
      state.user = me.user;
    } catch (e) {
      state.user = null;
    }
    route();
  })();
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const allowed = state.user
    ? state.user.role === 'sm'
      ? ['live', 'draft', 'versions']
      : ['live', 'versions']
    : [];
  state.tab = allowed.includes(hash) ? hash : allowed[0] || null;
  if (!state.user) state.tab = null;

  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  if (state.tab === 'live') {
    refreshLive(true);
    // 现场板 8 秒轮询；正在填写登记时间或弹窗打开时不打断。
    state.pollTimer = setInterval(() => {
      if (!state.modal && !document.querySelector('input.inline-time:focus')) {
        refreshLive(false);
      }
    }, 8000);
  } else if (state.tab === 'draft') {
    refreshDraft();
  } else if (state.tab === 'versions') {
    state.pubList = null;
    state.pubView = null;
    refreshPubList();
  }
  render();
}

async function refreshLive(initial) {
  try {
    const data = await api('GET', '/api/live');
    state.live = data;
    state.liveError = null;
  } catch (e) {
    if (e.status === 401) {
      state.user = null;
      route();
      return;
    }
    state.liveError = e.message;
  }
  // 初次加载或轮询更新都重绘现场板；其余视图下只更新数据不抢焦点。
  if (state.tab === 'live' && !state.modal) render();
}

async function refreshDraft() {
  try {
    state.draft = await api('GET', '/api/draft');
    state.draftError = null;
  } catch (e) {
    state.draftError = e.message;
  }
  render();
}

async function refreshPubList() {
  try {
    const data = await api('GET', '/api/publications');
    state.pubList = data.publications;
  } catch (e) {
    state.pubList = [];
    state.pubListError = e.message;
  }
  state.pubView = null;
  render();
}

async function openPublication(id) {
  try {
    state.pubView = await api('GET', `/api/publications/${id}`);
  } catch (e) {
    toast(e.message, 'error');
  }
  render();
}

/* ---------------- 登录 ---------------- */

async function doLogin(ev) {
  ev.preventDefault();
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  try {
    const data = await api('POST', '/api/login', { username, password });
    state.user = data.user;
    location.hash = '#/live';
    route();
    toast(`欢迎，${data.user.display_name}`, 'success');
  } catch (e) {
    state.loginError = e.message;
    render();
  }
}

async function doLogout() {
  await api('POST', '/api/logout').catch(() => {});
  state.user = null;
  location.hash = '';
  route();
}

/* ---------------- 渲染：入口 ---------------- */

function render() {
  if (!state.user) {
    $app.innerHTML = renderLogin();
    bindLogin();
    renderToasts();
    return;
  }
  $app.innerHTML = renderShell();
  bindShell();
  const host = document.getElementById('view-host');
  if (state.tab === 'live') host.innerHTML = renderLive();
  if (state.tab === 'draft') host.innerHTML = renderDraft();
  if (state.tab === 'versions') host.innerHTML = renderVersions();
  bindView();
  renderModal();
  renderToasts();
}

function renderToasts() {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  stack.innerHTML = state.toasts
    .map((t) => `<div class="toast ${esc(t.type)}">${esc(t.message)}</div>`)
    .join('');
}

/* ---------------- 登录页 ---------------- */

function renderLogin() {
  return `
  <div class="login-wrap">
    <form class="login-card" id="login-form">
      <h1>🎭 联排提示板</h1>
      <p class="sub">Rehearsal Callboard · 舞监编排 / 岗位执行</p>
      ${state.loginError ? `<div class="alert error">${esc(state.loginError)}</div>` : ''}
      <div class="field">
        <label for="login-user">账号</label>
        <input id="login-user" autocomplete="username" placeholder="如 sm / lighting" />
      </div>
      <div class="field">
        <label for="login-pass">密码</label>
        <input id="login-pass" type="password" autocomplete="current-password" />
      </div>
      <button class="primary" type="submit" style="width:100%">登 录</button>
      <div class="login-hint">
        初始账号（首次启动自动创建）：<br>
        舞监 <code>sm / admin123</code><br>
        灯光 <code>lighting / exec123</code> ·
        音响 <code>sound / exec123</code> ·
        机械 <code>machinery / exec123</code>
      </div>
    </form>
  </div>`;
}

function bindLogin() {
  const f = document.getElementById('login-form');
  if (f) f.addEventListener('submit', doLogin);
}

/* ---------------- 外壳 ---------------- */

function renderShell() {
  const u = state.user;
  const tab = (id, label) =>
    `<button class="tab ${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`;
  return `
  <div class="topbar">
    <div class="brand">🎭 联排提示板<span class="dot">.</span></div>
    <div class="tabs">
      ${tab('live', '现场板')}
      ${u.role === 'sm' ? tab('draft', '舞监编排') : ''}
      ${tab('versions', '版本回看')}
    </div>
    <div class="spacer"></div>
    <span class="userchip">
      ${u.role === 'sm' ? '<span class="badge sm">舞监</span>' : `<span class="badge exec">${esc(u.position_name || '执行')}</span>`}
      <b>${esc(u.display_name)}</b>（${esc(u.username)}）
    </span>
    <button class="small ghost" id="btn-logout">退出</button>
  </div>
  <div class="container" id="view-host"></div>`;
}

function bindShell() {
  document.querySelectorAll('.tab[data-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      location.hash = `#/${el.dataset.tab}`;
    });
  });
  document.getElementById('btn-logout').addEventListener('click', doLogout);
}

/* ---------------- 现场板 ---------------- */

function renderLive() {
  if (state.liveError) {
    return `<div class="alert error">现场板加载失败：${esc(state.liveError)}</div>`;
  }
  if (!state.live) return `<div class="empty">正在加载现场板…</div>`;
  if (state.live.empty) {
    return `
    <div class="panel">
      <div class="empty">
        <div style="font-size:2rem;margin-bottom:10px">📋</div>
        ${esc(state.live.message)}<br>
        ${state.user.role === 'sm'
          ? '<a href="#/draft"><button class="primary" style="margin-top:16px">前往编排并发布</button></a>'
          : '请等待舞监发布联排版本。'}
      </div>
    </div>`;
  }

  const v = state.live;
  const isSm = state.user.role === 'sm';
  const myPos = state.user.position_id;
  const pub = v.publication;

  const conflictBanner = v.conflicts.length
    ? `<div class="alert error">
         <b>顺延岗位冲突 ${v.conflicts.length} 项</b>（同岗位实际/预计时段重叠）：
         <ul class="conflict-list">
           ${v.conflicts
             .map(
               (c) => `<li><b>${esc(c.position_name)}</b>：${esc(c.cue_a_code)}「${esc(
                 c.cue_a_title
               )}」× ${esc(c.cue_b_code)}「${esc(c.cue_b_title)}」
                 重叠时段 ${fmtTime(c.start)} – ${fmtTime(c.end)}
                 ${c.caused_by_delay ? '<span class="badge delay">顺延导致</span>' : ''}</li>`
             )
             .join('')}
         </ul>
       </div>`
    : `<div class="alert success">当前各岗位时段无重叠冲突。</div>`;

  const rows = v.cues
    .map((c) => {
      const mine = !isSm && c.position_id === myPos;
      const delayed = c.delay_ms > 0;
      const statusBadge =
        c.status === 'done'
          ? '<span class="badge done">已完成</span>'
          : c.status === 'running'
          ? '<span class="badge running">进行中</span>'
          : '<span class="badge pending">未开始</span>';
      const waitText =
        c.status === 'pending' && c.waiting_for && c.waiting_for.length
          ? `<div class="muted">等待：${c.waiting_for
              .map((w) => {
                const pc = v.cues.find((x) => x.id === w.cue_id);
                return `${pc ? esc(pc.code) : '#' + w.cue_id} 至 ${fmtTime(w.ready_at)}`;
              })
              .join('；')}</div>`
          : '';
      return `
      <tr class="${mine ? 'mine' : ''} ${delayed ? 'delayed' : ''}">
        <td><b>${esc(c.code)}</b></td>
        <td class="wrap">${esc(c.title)}<div class="muted">${esc(c.notes || '')}</div></td>
        <td>${esc(c.position_name)}</td>
        <td>${statusBadge}</td>
        <td class="mono">${fmtTime(c.planned_start, false)}<div class="muted">计划 ${fmtDuration(
        c.duration_sec
      )}</div></td>
        <td class="mono">
          <b>${fmtTime(c.effective_start)}</b> → ${fmtTime(c.effective_end)}
          ${delayed ? `<div><span class="badge delay">${esc(fmtDelay(c.delay_ms))}</span></div>` : ''}
          ${waitText}
          <div class="muted">实际起 ${fmtTime(c.actual_start)} / 止 ${fmtTime(c.actual_end)}
            ${c.estimated_end != null ? `；预计止 ${fmtTime(c.estimated_end)}` : ''}</div>
        </td>
        <td>${renderLiveActions(c, mine, isSm)}</td>
      </tr>`;
    })
    .join('');

  return `
  <div class="panel">
    <h2>现场板</h2>
    <div class="pub-meta">
      联排版本 <span class="badge version">v${pub.id}</span>
      （草稿第 ${pub.draft_version} 版快照）
      发布于 ${fmtTime(pub.created_at)}${pub.notes ? ` · ${esc(pub.notes)}` : ''}
      <span style="margin-left:8px">页面每 8 秒自动刷新</span>
    </div>
    ${conflictBanner}
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>编号</th><th>提示项</th><th>岗位</th><th>状态</th>
          <th>计划时间</th><th>实际 / 预计时间</th><th>现场登记</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="legend">
      <span class="lg-done">已完成</span>
      <span class="lg-running">进行中</span>
      <span class="lg-pending">未开始（自动顺延）</span>
      <span class="lg-delay">相对计划顺延</span>
      <span>蓝底行＝当前账号所属岗位</span>
    </div>
  </div>`;
}

function renderLiveActions(c, mine, isSm) {
  if (isSm) return '<span class="muted">舞监账号只读</span>';
  if (!mine) return '<span class="muted">非本岗位</span>';

  const ver = state.live.publication.id;
  if (c.status === 'done') return '<span class="badge done">已完成登记</span>';

  const defaultEst = toLocalInput(
    c.estimated_end != null
      ? c.estimated_end
      : c.status === 'running'
      ? c.effective_end
      : c.effective_end
  );

  const startBtn =
    c.status === 'pending'
      ? `<button class="small primary" data-act="start" data-cue="${c.id}">登记实际开始</button>`
      : '';
  const completeBtn = `<button class="small" data-act="complete" data-cue="${c.id}">登记完成</button>`;
  return `
    <div style="display:flex;flex-direction:column;gap:6px">
      ${startBtn}
      ${completeBtn}
      <div class="inline-form">
        <input class="inline-time" type="datetime-local" step="1" id="est-${c.id}" value="${esc(
    defaultEst
  )}" />
        <button class="small ghost" data-act="estimate" data-cue="${c.id}">预计结束</button>
      </div>
      <div class="muted" style="font-size:.72rem">登记版本号 v${ver}</div>
    </div>`;
}

async function handleRegister(btn) {
  const act = btn.dataset.act;
  const cueId = Number(btn.dataset.cue);
  const ver = state.live.publication.id;
  const body = { publication_id: ver, version: ver };
  if (act === 'start' || act === 'complete') {
    // 默认取当前时刻；可在确认框中调整。
    const label = act === 'start' ? '实际开始时间' : '实际完成时间';
    const custom = window.prompt(`${label}（留空使用当前时刻，格式 YYYY-MM-DDTHH:MM:SS）`, '');
    if (custom === null) return;
    if (custom.trim()) body.at = custom.trim();
  } else if (act === 'estimate') {
    const input = document.getElementById(`est-${cueId}`);
    const val = input && input.value;
    if (!val) {
      toast('请先选择预计结束时间', 'warn');
      return;
    }
    body.value = val;
  }

  try {
    await api('POST', `/api/live/cues/${cueId}/register`, body);
    toast('登记成功，已重算后项时间线', 'success');
    await refreshLive(true);
  } catch (e) {
    await handleApiError(e, { onStale: () => refreshLive(true) });
  }
}

/* ---------------- 舞监编排 ---------------- */

function renderDraft() {
  if (state.draftError) {
    return `<div class="alert error">草稿加载失败：${esc(state.draftError)}</div>`;
  }
  if (!state.draft) return `<div class="empty">正在加载草稿…</div>`;

  const d = state.draft;
  const codeById = new Map(d.cues.map((c) => [c.id, c.code]));
  const depsBySucc = new Map();
  d.dependencies.forEach((e) => {
    if (!depsBySucc.has(e.succ)) depsBySucc.set(e.succ, []);
    depsBySucc.get(e.succ).push(e.pred);
  });

  const rows = d.cues
    .map((c) => {
      const preds = (depsBySucc.get(c.id) || [])
        .map((pid) => `<code>${esc(codeById.get(pid) || '#' + pid)}</code>`)
        .join(' ') || '<span class="muted">无</span>';
      return `
      <tr>
        <td><b>${esc(c.code)}</b></td>
        <td class="wrap">${esc(c.title)}</td>
        <td>${esc(c.position_name)}</td>
        <td class="mono">${fmtTime(c.planned_start, false)} → ${fmtHM(
        c.planned_start + c.duration_sec * 1000
      )}<div class="muted">${fmtDuration(c.duration_sec)}</div></td>
        <td>${preds}</td>
        <td>
          <button class="small" data-act="edit-cue" data-cue="${c.id}">编辑</button>
          <button class="small danger" data-act="delete-cue" data-cue="${c.id}">删除</button>
        </td>
      </tr>`;
    })
    .join('');

  return `
  <div class="panel">
    <h2>舞监编排（草稿）</h2>
    <p class="desc">
      录入提示项的计划开始、时长、岗位与前置关系。所有改动自动校验草稿版本号，他人改动后你的提交将被拒绝。
      当前草稿版本：<span class="badge version" id="draft-version">v${d.draft.version}</span>
    </p>
    <div class="toolbar">
      <button class="primary" data-act="new-cue">＋ 新增提示项</button>
      <button data-act="validate">校验发布规则</button>
      <button class="primary" data-act="publish">发布只读联排版本…</button>
      <button class="ghost small" data-act="reload-draft">重新加载</button>
      <span class="muted" style="font-size:.78rem">
        发布条件：前置计划结束 ≤ 后项开始 · 同岗位时段不重叠 · 依赖无环
      </span>
    </div>
    <div id="draft-feedback"></div>
    ${
      d.cues.length === 0
        ? '<div class="empty">草稿暂无提示项，点击「新增提示项」开始编排。</div>'
        : `<div class="table-wrap">
        <table>
          <thead><tr>
            <th>编号</th><th>标题</th><th>岗位</th><th>计划时段</th><th>前置项</th><th>操作</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
    }
  </div>`;
}

function cueModalHtml(cue) {
  const d = state.draft;
  const isEdit = !!cue;
  const depsBySucc = new Map();
  d.dependencies.forEach((e) => {
    if (!depsBySucc.has(e.succ)) depsBySucc.set(e.succ, new Set());
    depsBySucc.get(e.succ).add(e.pred);
  });
  const selected = cue ? depsBySucc.get(cue.id) || new Set() : new Set();
  const predOptions = d.cues
    .filter((c) => !cue || c.id !== cue.id)
    .map(
      (c) =>
        `<label><input type="checkbox" name="preds" value="${c.id}" ${
          selected.has(c.id) ? 'checked' : ''
        }> ${esc(c.code)} · ${esc(c.title)}（${esc(c.position_name)}）</label>`
    )
    .join('');

  return `
  <div class="modal-mask" id="modal-mask">
    <div class="modal">
      <h3>${isEdit ? `编辑提示项 ${esc(cue.code)}` : '新增提示项'}</h3>
      <div id="cue-form-error"></div>
      <div class="row">
        <div class="field">
          <label>编号（字母数字）</label>
          <input id="f-code" value="${isEdit ? esc(cue.code) : ''}" placeholder="如 C7" />
        </div>
        <div class="field" style="flex:2">
          <label>标题</label>
          <input id="f-title" value="${isEdit ? esc(cue.title) : ''}" placeholder="如 黑场切景" />
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label>岗位</label>
          <select id="f-position">
            ${d.positions
              .map(
                (p) =>
                  `<option value="${p.id}" ${isEdit && p.id === cue.position_id ? 'selected' : ''}>${esc(
                    p.name
                  )}</option>`
              )
              .join('')}
          </select>
        </div>
        <div class="field">
          <label>计划开始</label>
          <input id="f-start" type="datetime-local" step="1" value="${
            isEdit ? toLocalInput(cue.planned_start) : ''
          }" />
        </div>
        <div class="field">
          <label>时长（分钟）</label>
          <input id="f-duration" type="number" min="0.5" step="0.5" value="${
            isEdit ? Math.round((cue.duration_sec / 60) * 100) / 100 : ''
          }" />
        </div>
      </div>
      <div class="field">
        <label>备注</label>
        <textarea id="f-notes" rows="2">${isEdit ? esc(cue.notes || '') : ''}</textarea>
      </div>
      <div class="field">
        <label>前置项（后项计划开始不得早于这些项的计划结束）</label>
        <div class="pred-checks">${predOptions || '<span class="muted">暂无可选提示项</span>'}</div>
      </div>
      <div class="modal-actions">
        <button data-act="close-modal">取消</button>
        <button class="primary" data-act="save-cue" data-cue="${isEdit ? cue.id : ''}">保存</button>
      </div>
    </div>
  </div>`;
}

function openCueModal(cueId) {
  const cue = cueId ? state.draft.cues.find((c) => c.id === cueId) : null;
  state.modal = { type: 'cue', cue };
  renderModal();
}

function closeModal() {
  state.modal = null;
  renderModal();
}

function renderModal() {
  const host = document.getElementById('modal-root') || (() => {
    const div = document.createElement('div');
    div.id = 'modal-root';
    document.body.appendChild(div);
    return div;
  })();
  host.innerHTML = state.modal ? cueModalHtml(state.modal.cue) : '';
  bindModal();
}

async function saveCue(btn) {
  const cueId = btn.dataset.cue ? Number(btn.dataset.cue) : null;
  const payload = {
    draft_version: state.draft.draft.version,
    code: document.getElementById('f-code').value,
    title: document.getElementById('f-title').value,
    position_id: Number(document.getElementById('f-position').value),
    planned_start: document.getElementById('f-start').value,
    duration_min: Number(document.getElementById('f-duration').value),
    notes: document.getElementById('f-notes').value,
    predecessor_ids: [...document.querySelectorAll('input[name="preds"]:checked')].map((el) =>
      Number(el.value)
    )
  };
  try {
    if (cueId) await api('PUT', `/api/draft/cues/${cueId}`, payload);
    else await api('POST', '/api/draft/cues', payload);
    state.modal = null;
    toast(cueId ? '提示项已更新，草稿版本 +1' : '提示项已创建，草稿版本 +1', 'success');
    await refreshDraft();
  } catch (e) {
    const host = document.getElementById('cue-form-error');
    if (host) host.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    await handleApiError(e, { inline: true, onStale: () => refreshDraft() });
  }
}

async function validateDraftOnly() {
  const host = document.getElementById('draft-feedback');
  try {
    const result = await api('POST', '/api/draft/validate', {});
    if (result.ok) {
      host.innerHTML = `<div class="alert success">校验通过：前置时序、同岗位时段与依赖关系均满足发布条件，共 ${
        state.draft.cues.length
      } 个提示项。</div>`;
    } else {
      host.innerHTML = renderDraftErrors(result.errors);
    }
  } catch (e) {
    host.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}

function renderDraftErrors(errors) {
  const typeLabel = {
    cycle: '依赖环路',
    precedence: '前置时序冲突',
    overlap: '同岗位时段重叠'
  };
  return `<div class="alert error"><b>无法发布，共 ${errors.length} 项冲突：</b>
    <ul class="conflict-list">
      ${errors
        .map(
          (e) =>
            `<li><span class="badge conflict">${esc(typeLabel[e.type] || e.type)}</span> ${esc(
              e.label
            )}</li>`
        )
        .join('')}
    </ul></div>`;
}

async function deleteCue(cueId) {
  const cue = state.draft.cues.find((c) => c.id === cueId);
  if (!window.confirm(`确认删除提示项 ${cue.code}「${cue.title}」？相关前置关系一并移除。`)) return;
  try {
    await api('DELETE', `/api/draft/cues/${cueId}`, { draft_version: state.draft.draft.version });
    toast('已删除，草稿版本 +1', 'success');
    await refreshDraft();
  } catch (e) {
    await handleApiError(e, { onStale: () => refreshDraft() });
  }
}

async function publishDraft() {
  if (!state.draft.cues.length) {
    toast('草稿为空，无法发布', 'warn');
    return;
  }
  const notes = window.prompt('为本次只读联排版本添加备注（可留空）：', '') ?? '';
  try {
    const r = await api('POST', '/api/draft/publish', {
      draft_version: state.draft.draft.version,
      notes
    });
    toast(`已发布联排版本 v${r.publicationId}，执行岗位可现场登记`, 'success', 6000);
    await refreshDraft();
  } catch (e) {
    const host = document.getElementById('draft-feedback');
    if (e.code === 'PUBLISH_CONFLICT' && e.details && e.details.errors) {
      host.innerHTML = renderDraftErrors(e.details.errors);
      toast('发布失败：存在联排规则冲突，已列出冲突项', 'error', 6000);
    } else {
      toast(e.message, 'error', 6000);
    }
    await handleApiError(e, { silent: true, onStale: () => refreshDraft() });
  }
}

/* ---------------- 版本回看 ---------------- */

function renderVersions() {
  if (!state.pubList) return `<div class="empty">正在加载版本列表…</div>`;

  const list = state.pubList.length
    ? `<div class="table-wrap" style="margin-bottom:18px">
        <table>
          <thead><tr><th>版本</th><th>备注</th><th>草稿版本</th><th>提示项</th><th>发布时间</th><th>发布人</th><th></th></tr></thead>
          <tbody>
            ${state.pubList
              .map(
                (p, i) => `<tr ${i === 0 ? 'class="mine"' : ''}>
                <td><b>v${p.id}</b>${i === 0 ? ' <span class="badge version">最新</span>' : ''}</td>
                <td class="wrap">${esc(p.notes || '—')}</td>
                <td class="mono">v${p.draft_version}</td>
                <td>${p.cue_count}</td>
                <td class="mono">${fmtTime(p.created_at)}</td>
                <td>${esc(p.created_by_name || '—')}</td>
                <td><button class="small" data-act="open-pub" data-pub="${p.id}">回看</button></td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`
    : '<div class="empty">尚未发布任何版本。</div>';

  return `
  <div class="panel">
    <h2>已发布版本（只读回看）</h2>
    <p class="desc">已发布内容不可修改；打开任一版本可查看其快照与当时/累计的现场登记时间线。</p>
    ${list}
    <div id="pub-view-host"></div>
  </div>`;
}

function renderPubView() {
  const v = state.pubView;
  if (!v) return '';
  const pub = v.publication;
  const rows = v.cues
    .map((c) => {
      const badge =
        c.status === 'done'
          ? '<span class="badge done">已完成</span>'
          : c.status === 'running'
          ? '<span class="badge running">进行中</span>'
          : '<span class="badge pending">未开始</span>';
      return `<tr class="${c.delay_ms > 0 ? 'delayed' : ''}">
        <td><b>${esc(c.code)}</b></td>
        <td class="wrap">${esc(c.title)}</td>
        <td>${esc(c.position_name)}</td>
        <td>${badge}</td>
        <td class="mono">${fmtTime(c.planned_start, false)} → ${fmtHM(c.planned_end)}</td>
        <td class="mono">${fmtTime(c.effective_start)} → ${fmtTime(c.effective_end)}
          ${c.delay_ms > 0 ? `<div><span class="badge delay">${esc(fmtDelay(c.delay_ms))}</span></div>` : ''}
          <div class="muted">实际 ${fmtTime(c.actual_start)} / ${fmtTime(c.actual_end)}
            ${c.estimated_end != null ? `；预计止 ${fmtTime(c.estimated_end)}` : ''}</div>
        </td>
      </tr>`;
    })
    .join('');

  const conflicts = v.conflicts.length
    ? `<div class="alert error"><b>岗位冲突 ${v.conflicts.length} 项</b>
        <ul class="conflict-list">${v.conflicts
          .map(
            (c) => `<li><b>${esc(c.position_name)}</b>：${esc(c.cue_a_code)} × ${esc(
              c.cue_b_code
            )} 重叠 ${fmtTime(c.start)} – ${fmtTime(c.end)}</li>`
          )
          .join('')}</ul></div>`
    : '';

  return `
  <div class="panel" style="background:var(--bg-elev2)">
    <h2>版本 v${pub.id} 快照详情</h2>
    <div class="pub-meta">
      草稿第 ${pub.draft_version} 版 · 发布于 ${fmtTime(pub.created_at)}
      ${pub.notes ? ` · 备注：${esc(pub.notes)}` : ''}
      ${v.isLatest ? '<span class="badge version">当前现场使用版本</span>' : '<span class="badge conflict">历史版本·只读</span>'}
    </div>
    ${conflicts}
    <div class="table-wrap">
      <table>
        <thead><tr><th>编号</th><th>提示项</th><th>岗位</th><th>状态</th><th>计划时段</th><th>实际 / 预计</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

/* ---------------- 事件绑定 ---------------- */

function bindView() {
  document.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      const act = el.dataset.act;
      if (act === 'start' || act === 'complete' || act === 'estimate') {
        // 防止 estimate 触发表单提交
        ev.preventDefault();
        return handleRegister(el);
      }
      if (act === 'new-cue') return openCueModal(null);
      if (act === 'edit-cue') return openCueModal(Number(el.dataset.cue));
      if (act === 'delete-cue') return deleteCue(Number(el.dataset.cue));
      if (act === 'validate') return validateDraftOnly();
      if (act === 'publish') return publishDraft();
      if (act === 'reload-draft') return refreshDraft();
      if (act === 'open-pub') return openPublication(Number(el.dataset.pub));
    });
  });

  const pubHost = document.getElementById('pub-view-host');
  if (pubHost && state.pubView) pubHost.innerHTML = renderPubView();
}

function bindModal() {
  const mask = document.getElementById('modal-mask');
  if (!mask) return;
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.dataset.act === 'close-modal') closeModal();
  });
  document.querySelectorAll('#modal-mask [data-act]').forEach((el) => {
    if (el.dataset.act === 'save-cue') el.addEventListener('click', () => saveCue(el));
    if (el.dataset.act === 'close-modal') el.addEventListener('click', closeModal);
  });
}

// 统一处理过期版本等错误：明确提示并刷新数据。
async function handleApiError(e, opts = {}) {
  if (opts.inline && e.code === 'STALE_VERSION') {
    const host = document.getElementById('cue-form-error');
    if (host) host.innerHTML = `<div class="alert error">${esc(e.message)}。页面将重新加载最新草稿。</div>`;
  }
  if (!opts.silent && !(opts.inline && e.code === 'STALE_VERSION')) {
    toast(e.message, 'error', 6000);
  }
  if (e.status === 401) {
    setTimeout(() => {
      state.user = null;
      route();
    }, 800);
    return;
  }
  if (e.code === 'STALE_VERSION' && opts.onStale) {
    setTimeout(opts.onStale, 1200);
  }
}

boot();
