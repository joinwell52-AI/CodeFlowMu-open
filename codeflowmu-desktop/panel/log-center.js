/**
 * CodeFlowMu 日志中心 — /api/v2/log-center/query
 */
(function (global) {
  'use strict';

  const Core = global.CodeFlowMuLogCenterCore;
  if (!Core) {
    console.error('[log-center] log-center-core.js 未加载');
    return;
  }

  const TABS = [
    { id: 'all', label: '全部' },
    { id: 'alerts', label: '错误/告警' },
    { id: 'runtime-alerts', label: '运行告警' },
    { id: 'runtime', label: 'Runtime 事件' },
    { id: 'tools', label: '工具调用' },
    { id: 'actions', label: '动作记录' },
    { id: 'sessions', label: 'Agent 会话' },
    { id: 'wake', label: 'Wake 记录' },
    { id: 'skills', label: 'Skill 调用' },
    { id: 'gateway', label: 'Gateway' },
    { id: 'raw', label: '原始 JSONL' },
  ];

  const state = {
    tab: 'all',
    agent: '',
    task_id: '',
    session_id: '',
    event_type: '',
    status: '',
    reason: '',
    sinceHours: '24',
    loading: false,
    lastData: null,
    selectedSkillRowId: null,
    gatewayStatus: null,
    gatewayReconnectBusy: false,
    processStartTs: null,
  };

  const LC_CLEAR_TS_KEY = 'codeflow_errors_cleared_at';

  const LC_SKILL_CHANNEL_LABEL = {
    pm: 'PM 治理',
    api: '面板 API',
    mcp: 'MCP',
    agent_runtime: 'Agent 运行时',
    auto_inject: '自动注入',
  };

  /** 列表/详情主标题：优先 manifest 中文名（tool_name / skill_display_name） */
  function lcSkillPrimaryLabel(r) {
    if (!r) return '—';
    const disp =
      r.skill_display_name != null ? String(r.skill_display_name).trim() : '';
    if (disp && disp !== r.skill_id) return disp;
    const tool = r.tool_name != null ? String(r.tool_name).trim() : '';
    if (tool && tool !== r.skill_id) return tool;
    const msg = r.message || '';
    const m = msg.match(/^\[([^\]]+)\]/);
    if (m && m[1]) {
      const bracket = m[1].trim();
      if (bracket) return bracket;
    }
    return r.skill_id || tool || '—';
  }

  function lcSkillSlugSubtitle(r) {
    const id = r && r.skill_id ? String(r.skill_id) : '';
    const primary = lcSkillPrimaryLabel(r);
    if (!id || primary === id) return '';
    return id;
  }

  let lcSkillDisplayNameMap = null;
  let lcSkillDisplayNameMapAt = 0;
  const LC_SKILL_NAME_MAP_TTL_MS = 60000;

  function buildSkillDisplayNameMapFromCatalog(catalog) {
    const map = Object.create(null);
    if (!catalog || !Array.isArray(catalog.groups)) return map;
    for (const g of catalog.groups) {
      for (const sk of g.skills || []) {
        if (!sk || !sk.id) continue;
        const dn = sk.display_name != null ? String(sk.display_name).trim() : '';
        if (dn && dn !== sk.id) map[sk.id] = dn;
      }
    }
    return map;
  }

  async function ensureLcSkillDisplayNameMap() {
    const now = Date.now();
    if (lcSkillDisplayNameMap && now - lcSkillDisplayNameMapAt < LC_SKILL_NAME_MAP_TTL_MS) {
      return lcSkillDisplayNameMap;
    }
    try {
      const r = await fetch('/api/v2/agent-skills/catalog');
      const data = await r.json();
      if (r.ok && data && Array.isArray(data.groups)) {
        lcSkillDisplayNameMap = buildSkillDisplayNameMapFromCatalog(data);
        lcSkillDisplayNameMapAt = now;
        return lcSkillDisplayNameMap;
      }
    } catch (_) { /* ignore */ }
    return lcSkillDisplayNameMap || Object.create(null);
  }

  function enrichLcSkillRowsClientSide(rows, nameMap) {
    if (!rows || !rows.length || !nameMap) return;
    for (const row of rows) {
      if (row.tab !== 'skills' && row.event_type !== 'skill.invocation') continue;
      const disp =
        row.skill_display_name != null ? String(row.skill_display_name).trim() : '';
      if (disp && disp !== row.skill_id) continue;
      const filled = nameMap[row.skill_id];
      if (!filled) continue;
      row.skill_display_name = filled;
      if (!row.tool_name || row.tool_name === row.skill_id) row.tool_name = filled;
      if (row.message && row.skill_id) {
        row.message = row.message.replace(
          new RegExp('^\\[' + String(row.skill_id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]'),
          '[' + filled + ']',
        );
      }
    }
  }

  /** 从报告/团队等页钻取进入日志中心时的返回目标 */
  const returnStack = {
    page: null,
    reportFilename: null,
  };

  const RETURN_LABELS = {
    reports: '返回报告列表',
    team: '返回团队',
    dashboard: '返回概览',
    tasks: '返回任务',
    chat: '返回对话',
    home: '返回首页',
  };

  const LC_RETURN_KEY = 'codeflow_lc_return_v1';

  function persistReturnStack() {
    try {
      if (returnStack.page) {
        sessionStorage.setItem(
          LC_RETURN_KEY,
          JSON.stringify({
            page: returnStack.page,
            reportFilename: returnStack.reportFilename || '',
          })
        );
      } else {
        sessionStorage.removeItem(LC_RETURN_KEY);
      }
    } catch (_) {
      /* ignore */
    }
  }

  function restoreReturnStackFromStorage() {
    if (returnStack.page) return;
    try {
      const raw = sessionStorage.getItem(LC_RETURN_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (o && o.page && o.page !== 'errorlog') {
        returnStack.page = o.page;
        returnStack.reportFilename = o.reportFilename || null;
      }
    } catch (_) {
      /* ignore */
    }
  }

  function currentPageId() {
    if (typeof global.curPage === 'string' && global.curPage) return global.curPage;
    try {
      if (typeof curPage === 'string' && curPage) return curPage;
    } catch (_) {
      /* curPage 可能不在本脚本作用域 */
    }
    return null;
  }

  function syncLogCenterBackButton() {
    restoreReturnStackFromStorage();
    const btn = document.getElementById('lc-back-btn');
    if (!btn) return;
    let page = returnStack.page;
    if (!page && global._lcNavFrom && global._lcNavFrom !== 'errorlog') {
      page = global._lcNavFrom;
    }
    if (page) {
      btn.classList.add('lc-back-visible');
      const label = RETURN_LABELS[page] || '返回上一页';
      btn.textContent = '← ' + label;
    } else {
      btn.classList.remove('lc-back-visible');
    }
  }

  function setLogCenterReturn(opts) {
    opts = opts || {};
    returnStack.page = opts.page || null;
    returnStack.reportFilename = opts.reportFilename || null;
    persistReturnStack();
    syncLogCenterBackButton();
  }

  function clearLogCenterReturn() {
    returnStack.page = null;
    returnStack.reportFilename = null;
    persistReturnStack();
    syncLogCenterBackButton();
  }

  function logCenterGoBack() {
    restoreReturnStackFromStorage();
    let page = returnStack.page;
    let reportFn = returnStack.reportFilename;
    if (!page && global._lcNavFrom && global._lcNavFrom !== 'errorlog') {
      page = global._lcNavFrom;
    }
    clearLogCenterReturn();
    if (!page) return;
    const nav =
      typeof global.navTo === 'function'
        ? global.navTo
        : typeof navTo === 'function'
          ? navTo
          : null;
    if (nav) nav(page);
    if (page === 'reports' && reportFn) {
      setTimeout(() => {
        const reg = global._taskReg;
        const f = reg && reg[reportFn];
        if (f && typeof global.openRpPreview === 'function') {
          global.openRpPreview(f);
        }
      }, 120);
    }
  }

  function esc(s) {
    if (s == null || s === '') return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sinceMs() {
    if (state.sinceHours === 'today') return Core.rangeStart('today', Date.now());
    const h = parseFloat(state.sinceHours);
    if (!Number.isFinite(h) || h <= 0) return undefined;
    return Date.now() - h * 3600 * 1000;
  }

  function buildQuery(tabOverride) {
    const tab = tabOverride || state.tab;
    const q = new URLSearchParams();
    q.set('tab', tab);
    q.set('limit', tab === 'gateway' ? '100' : '300');
    const since = sinceMs();
    if (since != null) q.set('since', String(since));
    if (state.agent.trim()) q.set('role', state.agent.trim());
    if (state.task_id.trim()) q.set('task_id', state.task_id.trim());
    if (state.session_id.trim()) q.set('session_id', state.session_id.trim());
    if (state.event_type.trim()) q.set('event_type', state.event_type.trim());
    if (state.status.trim()) q.set('status', state.status.trim());
    if (state.reason.trim()) q.set('reason', state.reason.trim());
    return q.toString();
  }

  function mergeLocalAlertsIntoRows(rows) {
    const out = rows.slice();
    const seen = new Set(out.map((row) => row.id));
    const localRows = Core.filterRowsByRange(loadLocalAlerts(), state.sinceHours, Date.now())
      .filter((row) => Core.matchesLocalFilters(row, state));
    for (const row of localRows) {
      if (!seen.has(row.id)) out.unshift(row);
    }
    return out;
  }

  function localAlertClearTs() {
    try {
      const raw = Number(localStorage.getItem(LC_CLEAR_TS_KEY) || 0);
      return Number.isFinite(raw) ? raw : 0;
    } catch (_) {
      return 0;
    }
  }

  function filterClearedAlertRows(rows) {
    const clearTs = localAlertClearTs();
    if (!clearTs || !Array.isArray(rows)) return rows || [];
    return rows.filter((row) => {
      if (!row || row.local_alert !== true) return true;
      const ts = Core.rowTimestamp(row);
      return ts != null ? ts > clearTs : false;
    });
  }

  function skillStatusBadge(status) {
    const raw = status != null ? String(status) : '—';
    const s = raw.toLowerCase();
    if (s === 'ok' || s === 'success') {
      return '<span class="lc-status-badge lc-status-ok">' + esc(raw) + '</span>';
    }
    if (s === 'failed' || s === 'error') {
      return '<span class="lc-status-badge lc-status-failed">' + esc(raw) + '</span>';
    }
    if (s === 'warn' || s === 'cancelled') {
      return '<span class="lc-status-badge lc-status-warn">' + esc(raw) + '</span>';
    }
    return '<span class="lc-status-badge">' + esc(raw) + '</span>';
  }

  function isSkillInvocationFailed(r) {
    const s = String(r.status || '').toLowerCase();
    return s === 'failed' || s === 'error' || r.level === 'ERROR';
  }

  const LC_FETCH_TIMEOUT_MS = 15000;

  function fetchWithTimeout(url, opts, timeoutMs) {
    timeoutMs = timeoutMs || LC_FETCH_TIMEOUT_MS;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl
      ? setTimeout(() => {
          try {
            ctrl.abort();
          } catch {
            /* ignore */
          }
        }, timeoutMs)
      : null;
    const reqOpts = ctrl ? Object.assign({}, opts || {}, { signal: ctrl.signal }) : opts;
    return fetch(url, reqOpts).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  function formatLogCenterError(err) {
    const msg = String((err && err.message) || err || '');
    if (/abort|timeout|timed out/i.test(msg)) return 'Runtime 未连接：请求超时，请检查 Panel 服务是否运行。';
    if (/failed to fetch|network|load failed/i.test(msg)) return 'Runtime 未连接：无法连接 Panel API。';
    if (/^HTTP\s*5/.test(msg)) return 'Runtime 未连接：服务端错误（' + msg + '）。';
    return msg || 'Runtime 未连接';
  }

  function loadLocalAlerts() {
    try {
      const raw = localStorage.getItem('codeflow_errors');
      const arr = JSON.parse(raw || '[]');
      if (!Array.isArray(arr)) return [];
      return arr.map((e, i) => Core.normalizeLocalAlert(e, i));
    } catch {
      return [];
    }
  }

  async function applyHealthResponse(response) {
    if (!response || !response.ok) return;
    try {
      const health = await response.json();
      const explicit = Number(health.process_started_at_ts);
      const uptime = Number(health.uptime);
      state.processStartTs = Number.isFinite(explicit) && explicit > 0
        ? explicit
        : Number.isFinite(uptime) && uptime >= 0
          ? Date.now() - uptime * 1000
          : null;
    } catch (_) {
      /* health is auxiliary; log rows remain usable */
    }
  }

  async function fetchLogCenter() {
    state.loading = true;
    renderLogCenterShell();
    const bodyEl = document.getElementById('lc-body');
    if (bodyEl) {
      bodyEl.innerHTML =
        '<div class="fl-empty" style="font-size:16px;padding:20px;text-align:center">加载中…</div>';
    }
    try {
      if (state.tab === 'runtime-alerts') {
        const [runtimeAlertsR, alertsR, healthR] = await Promise.all([
          fetchWithTimeout('/api/v2/runtime/alerts?status=active&group_by=false'),
          fetchWithTimeout(`/api/v2/log-center/query?${buildQuery('alerts')}`),
          fetchWithTimeout('/api/v2/health'),
        ]);
        await applyHealthResponse(healthR);
        if (!runtimeAlertsR.ok) throw new Error(`HTTP ${runtimeAlertsR.status}`);
        const runtimeAlerts = await runtimeAlertsR.json();
        const alertsData = alertsR.ok ? await alertsR.json() : { rows: [] };
        state.lastData = {
          total: (runtimeAlerts.active || []).length,
          rows: [],
          runtimeAlerts: runtimeAlerts.active || [],
          overall_status: runtimeAlerts.overall_status || 'ok',
          alertRowsForStats: filterClearedAlertRows(
            mergeLocalAlertsIntoRows(alertsData.rows || []),
          ),
        };
        return;
      }
      const needSkillNames = state.tab === 'skills' || state.tab === 'all';
      const needGatewayStatus = state.tab === 'gateway';
      const [r, nameMap, alertsR, gwStatusR, healthR] = await Promise.all([
        fetchWithTimeout(`/api/v2/log-center/query?${buildQuery()}`),
        needSkillNames ? ensureLcSkillDisplayNameMap() : Promise.resolve(null),
        fetchWithTimeout(`/api/v2/log-center/query?${buildQuery('alerts')}`),
        needGatewayStatus
          ? fetchWithTimeout('/api/v2/mobile/gateway/status')
          : Promise.resolve(null),
        fetchWithTimeout('/api/v2/health'),
      ]);
      await applyHealthResponse(healthR);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (needSkillNames && nameMap) enrichLcSkillRowsClientSide(data.rows, nameMap);
      data.rows = filterClearedAlertRows(data.rows || []);
      if (state.tab === 'alerts' || state.tab === 'all') {
        data.rows = mergeLocalAlertsIntoRows(data.rows || []);
        data.rows = filterClearedAlertRows(data.rows);
        data.rawTotal = data.rows.length;
        data.rows = Core.aggregateFailures(data.rows);
        data.total = data.rows.length;
      }
      let alertRowsForStats = [];
      if (alertsR.ok) {
        const alertsData = await alertsR.json();
        alertRowsForStats = filterClearedAlertRows(
          mergeLocalAlertsIntoRows(alertsData.rows || []),
        );
      } else {
        alertRowsForStats = filterClearedAlertRows(
          Core.filterRowsByRange(loadLocalAlerts(), state.sinceHours, Date.now())
            .filter((row) => Core.matchesLocalFilters(row, state)),
        );
      }
      data.alertRowsForStats = alertRowsForStats;
      if (gwStatusR && gwStatusR.ok) {
        state.gatewayStatus = await gwStatusR.json();
      }
      state.lastData = data;
    } catch (err) {
      state.lastData = {
        total: 0,
        rows: [],
        sessions: [],
        jsonl_path: null,
        jsonl_tail: [],
        error: formatLogCenterError(err),
      };
    } finally {
      state.loading = false;
      renderLogCenterBody();
    }
  }

  function levelClass(level) {
    if (level === 'ERROR') return 'ERROR';
    if (level === 'WARN') return 'WARN';
    return 'INFO';
  }

  function fmtTime(at, ts) {
    if (at) {
      try {
        const d = new Date(at);
        if (!Number.isNaN(d.getTime())) {
          return d.toLocaleString('zh-CN', { hour12: false });
        }
      } catch {
        /* ignore */
      }
      return at.slice(0, 19).replace('T', ' ');
    }
    if (ts) return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    return '—';
  }

  function emptyMessage() {
    if (state.tab === 'skills') {
      return '暂无 Skill 调用记录。PM 治理、面板 API，或 Agent 在会话中读取 Playbook（skills/*/SKILL.md）后会写入 .codeflowmu/skill-invocations.jsonl。';
    }
    if (state.tab === 'actions') {
      return (
        '暂无动作证据记录。Agent 执行读/写文件、运行命令、写 TASK/REPORT 等操作后会写入 fcop/logs/runtime/actions-YYYYMMDD.jsonl。' +
        (state.lastData?.actions_path
          ? `<br><span style="font-size:15px;color:var(--text3)">JSONL：${esc(state.lastData.actions_path)}</span>`
          : '')
      );
    }
    if (state.tab === 'gateway') {
      return (
        '暂无 Gateway 日志。连接/断开、慢请求（≥800ms）、超时与转发失败会写入 fcop/logs/runtime/gateway-YYYYMMDD.jsonl。' +
        (state.lastData?.jsonl_path
          ? `<br><span style="font-size:15px;color:var(--text3)">JSONL：${esc(state.lastData.jsonl_path)}</span>`
          : '')
      );
    }
    if (state.tab === 'alerts') {
      return (
        '暂无 ERROR / WARN。Runtime 事件、工具调用、Agent 会话请切换对应 Tab 查看。' +
        (state.lastData?.jsonl_path
          ? `<br><span style="font-size:15px;color:var(--text3)">JSONL：${esc(state.lastData.jsonl_path)}</span>`
          : '')
      );
    }
    if (state.loading) return '加载中…';
    if (state.lastData?.error) {
      return '<span style="color:#fca5a5">' + esc(state.lastData.error) + '</span>';
    }
    return '暂无日志。可放宽筛选或扩大时间范围。';
  }

  function rowClickAttrs(row) {
    const parts = [];
    if (row.session_id) parts.push(`data-session="${esc(row.session_id)}"`);
    if (row.task_id) parts.push(`data-task="${esc(row.task_id)}"`);
    return parts.join(' ');
  }

  function renderGenericRows(rows) {
    if (!rows.length) {
      return `<div class="fl-empty" style="font-size:16px;padding:20px;text-align:center">${emptyMessage()}</div>`;
    }
    const sorted = rows.slice().sort((a, b) => {
      const rank = (lv) => (lv === 'ERROR' ? 0 : lv === 'WARN' ? 1 : 2);
      const d = rank(a.level) - rank(b.level);
      if (d !== 0) return d;
      return (b.ts || 0) - (a.ts || 0);
    });
    const renderOne = (r, extraClass) => {
      const rowExtra =
        r.level === 'ERROR' ? ' lc-row-error' : r.level === 'WARN' ? ' lc-row-warn' : '';
      return `<div class="el-row lc-row${rowExtra}${extraClass || ''}" ${rowClickAttrs(r)} title="${esc(r.message || '')}">
      <span class="el-ts">${esc(fmtTime(r.at, r.ts))}</span>
      <span class="el-level ${levelClass(r.level)}">${esc(r.level)}</span>
      <span class="el-agent">${esc(r.agent_id || '—')}</span>
      <span class="lc-ev">${esc(r.event_type)}</span>
      <span class="el-msg" title="${esc(r.message || '')}">${esc(r.message || '')}</span>
    </div>`;
    };
    return sorted
      .map((r) => {
        if (!r || !Array.isArray(r.raw_events) || r.raw_event_count <= 1) return renderOne(r);
        const rawRows = r.raw_events
          .slice()
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))
          .map((raw) => renderOne(raw, ' lc-row-raw-evidence'))
          .join('');
        return `<details class="lc-fault-group">
          <summary>${renderOne(r, ' lc-row-grouped')}<span class="lc-raw-count">原始事件 × ${r.raw_event_count}</span></summary>
          <div class="lc-fault-evidence">${rawRows}</div>
        </details>`;
      })
      .join('');
  }

  function renderRuntimeAlerts(alerts) {
    if (!alerts.length) {
      return '<div class="fl-empty" style="font-size:16px;padding:28px;text-align:center;color:#86efac">当前没有未确认的运行告警。历史事件仍保留在“错误/告警”和“Runtime 事件”中。</div>';
    }
    const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const sorted = alerts.slice().sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || (b.last_seen || 0) - (a.last_seen || 0));
    const rows = sorted.map((a) => {
      const key = encodeURIComponent(a.alert_key || '');
      return '<div class="lc-row" style="align-items:center;padding:10px 12px;border-left:3px solid ' + (a.severity === 'P0' ? '#ef4444' : a.severity === 'P1' ? '#f59e0b' : a.severity === 'P2' ? '#60a5fa' : '#64748b') + '">' +
        '<span class="el-level ' + (a.severity === 'P0' ? 'ERROR' : a.severity === 'P1' ? 'WARN' : 'INFO') + '">' + esc(a.severity) + '</span>' +
        '<div class="lc-row-main"><div style="font-weight:700;color:var(--text)">' + esc(a.title || a.code) + (a.count > 1 ? ' ×' + esc(a.count) : '') + '</div>' +
        '<div class="lc-msg" style="margin-top:4px">' + esc(a.message || '') + '</div>' +
        '<div style="margin-top:4px;font-size:13px;color:var(--text3)">' + esc(a.category || '') + (a.affected_agent ? ' · ' + esc(a.affected_agent) : '') + (a.affected_task ? ' · ' + esc(a.affected_task) : '') + ' · ' + esc(fmtTime('', a.last_seen)) + '</div></div>' +
        '<button type="button" class="hbtn" data-runtime-alert-key="' + esc(key) + '" style="font-size:14px;flex-shrink:0">确认</button>' +
        '</div>';
    }).join('');
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--bd)"><span style="font-size:14px;color:var(--text3)">确认只移除当前运行告警，不删除 JSONL 审计历史。</span><button type="button" class="hbtn" id="lc-resolve-all-runtime-alerts" style="font-size:14px">全部确认</button></div>' + rows;
  }

  async function resolveRuntimeAlerts(alertKey, all) {
    const res = await fetchWithTimeout('/api/v2/runtime/alerts/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all ? { all: true } : { alert_key: alertKey }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (global.RuntimeAlertCenter && typeof global.RuntimeAlertCenter.pollOnce === 'function') {
      void global.RuntimeAlertCenter.pollOnce();
    }
    await fetchLogCenter();
  }

  function bindRuntimeAlertActions(root) {
    if (!root) return;
    root.querySelectorAll('[data-runtime-alert-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = decodeURIComponent(btn.getAttribute('data-runtime-alert-key') || '');
        void resolveRuntimeAlerts(key, false).catch((err) => alert('确认告警失败: ' + err.message));
      });
    });
    const all = root.querySelector('#lc-resolve-all-runtime-alerts');
    if (all) all.addEventListener('click', () => {
      if (confirm('确认全部当前运行告警？历史日志不会删除。')) {
        void resolveRuntimeAlerts('', true).catch((err) => alert('确认告警失败: ' + err.message));
      }
    });
  }

  function renderSessionsTable(sessions) {
    if (!sessions.length) {
      return `<div class="fl-empty" style="font-size:16px;padding:20px;text-align:center">${emptyMessage()}</div>`;
    }
    const head = `<div class="lc-table-head lc-sessions-grid">
      <span>时间</span><span>Agent</span><span>Task ID</span><span>Session</span>
      <span>状态</span><span>reason</span><span>时长</span><span>tools</span><span>报告</span>
    </div>`;
    const body = sessions
      .map((s) => {
        const dur =
          s.duration_ms != null ? `${Math.round(s.duration_ms / 1000)}s` : '—';
        const rep = s.report_written
          ? `<span class="lc-link" data-task="${esc(s.task_id)}" data-session="${esc(s.session_id)}">✓</span>`
          : '—';
        return `<div class="lc-table-row lc-sessions-grid lc-row" data-session="${esc(s.session_id)}" data-task="${esc(s.task_id)}">
        <span>${esc(fmtTime(s.at, s.ts))}</span>
        <span>${esc(s.agent_id)}</span>
        <span class="lc-mono" title="${esc(s.task_id)}">${esc((s.task_id || '').slice(-28))}</span>
        <span class="lc-mono" title="${esc(s.session_id)}">${esc((s.session_id || '').slice(-12))}</span>
        <span>${esc(s.status)}</span>
        <span class="lc-reason">${esc(s.reason)}</span>
        <span>${esc(dur)}</span>
        <span>${esc(String(s.tool_call_count ?? 0))}${s.last_tool ? ' · ' + esc(s.last_tool) : ''}</span>
        <span>${rep}</span>
      </div>`;
      })
      .join('');
    return head + body;
  }

  function skillRowId(r) {
    return r.id || 'skill-' + String(r.tool_name || r.at || '');
  }

  function lcSkillDetailRow(label, value, opts) {
    opts = opts || {};
    if (value == null || value === '') return '';
    const v = opts.html ? value : esc(String(value));
    return '<dt>' + esc(label) + '</dt><dd' + (opts.mono ? ' class="lc-mono"' : '') + '>' + v + '</dd>';
  }

  function renderLcSkillDetailContent(r) {
    if (!r) {
      return '<div style="font-size:15px;color:var(--text3);line-height:1.55">点击左侧记录查看详情。</div>';
    }
    const ch = LC_SKILL_CHANNEL_LABEL[r.reason] || r.reason || '—';
    const at = fmtTime(r.at, r.ts);
    const dur = r.duration_ms != null ? String(r.duration_ms) + ' ms' : '—';
    const invId = r.id && String(r.id).startsWith('skill-') ? String(r.id).slice(6) : r.id || '—';
    const summary = (r.message || '').replace(/^\[[^\]]+\]\s*/, '') || '—';
    const skillPrimary = lcSkillPrimaryLabel(r);
    const skillSlug = lcSkillSlugSubtitle(r);
    const skillCell = skillSlug
      ? esc(skillPrimary) +
        ' <span class="lc-mono" style="color:var(--text3);font-size:14px">(' +
        esc(skillSlug) +
        ')</span>'
      : esc(skillPrimary);
    const taskLink = r.task_id
      ? '<button type="button" class="btn-link lc-mono" data-lc-task="' +
        esc(r.task_id) +
        '">' +
        esc(r.task_id) +
        '</button>'
      : '—';
    const kv = [
      lcSkillDetailRow('调用 ID', invId, { mono: true }),
      lcSkillDetailRow('时间', at),
      lcSkillDetailRow('技能', skillCell, { html: true }),
      lcSkillDetailRow(
        '渠道',
        ch + (r.reason && LC_SKILL_CHANNEL_LABEL[r.reason] ? ' (' + r.reason + ')' : ''),
      ),
      lcSkillDetailRow('结果', r.status),
      lcSkillDetailRow('耗时', dur),
      lcSkillDetailRow('角色', r.agent_id),
      lcSkillDetailRow('thread', r.thread_key, { mono: true }),
      lcSkillDetailRow('task', taskLink, { html: !!r.task_id }),
    ].join('');
    return (
      '<dl class="skill-inv-detail-kv">' +
      kv +
      '</dl>' +
      '<div style="font-size:14px;font-weight:700;color:var(--text3);margin-bottom:4px">摘要</div>' +
      '<div style="font-size:15px;color:var(--text2);line-height:1.55;white-space:pre-wrap;word-break:break-word">' +
      esc(summary) +
      '</div>'
    );
  }

  function renderSkillsTable(rows) {
    const skills = rows.filter((r) => r.event_type === 'skill.invocation');
    if (!skills.length) {
      state.selectedSkillRowId = null;
      return `<div class="fl-empty" style="font-size:16px;padding:20px;text-align:center">${emptyMessage()}</div>`;
    }
    const selectedStill =
      state.selectedSkillRowId && skills.some((r) => skillRowId(r) === state.selectedSkillRowId);
    if (!selectedStill) state.selectedSkillRowId = skillRowId(skills[0]);
    const listHtml = skills
      .map((r) => {
        const id = skillRowId(r);
        const on = id === state.selectedSkillRowId ? ' on' : '';
        const failRow = isSkillInvocationFailed(r) ? ' lc-row-error' : '';
        const ch = LC_SKILL_CHANNEL_LABEL[r.reason] || r.reason || '—';
        const skillPrimary = lcSkillPrimaryLabel(r);
        const skillSlug = lcSkillSlugSubtitle(r);
        const sub = [ch, r.agent_id, (r.message || '').replace(/^\[[^\]]+\]\s*/, '').slice(0, 60)]
          .filter(Boolean)
          .join(' · ');
        const titleAttr = skillSlug
          ? esc(skillPrimary + ' (' + skillSlug + ')')
          : esc(skillPrimary);
        const nameHtml = skillSlug
          ? esc(skillPrimary) +
            ' <span class="lc-mono" style="color:var(--text3);font-size:13px">' +
            esc(skillSlug) +
            '</span>'
          : esc(skillPrimary);
        return (
          '<div class="skill-inv-row' +
          on +
          failRow +
          '" data-skill-row-id="' +
          esc(id) +
          '">' +
          '<div class="skill-inv-row-main">' +
          '<span class="skill-inv-time">' +
          esc(fmtTime(r.at, r.ts)) +
          '</span>' +
          '<span class="skill-inv-id" title="' +
          titleAttr +
          '">' +
          nameHtml +
          '</span>' +
          skillStatusBadge(r.status) +
          '</div>' +
          '<div class="skill-inv-row-sub" title="' +
          esc(r.message || '') +
          '">' +
          esc(sub) +
          '</div>' +
          '</div>'
        );
      })
      .join('');
    const selected =
      skills.find((r) => skillRowId(r) === state.selectedSkillRowId) || skills[0];
    return (
      '<div class="lc-skills-split">' +
      '<div class="lc-skills-list-col" id="lc-skills-list">' +
      listHtml +
      '</div>' +
      '<div class="lc-skills-detail-col">' +
      '<div style="font-size:16px;font-weight:800;margin-bottom:8px">调用详情</div>' +
      '<div id="lc-skills-detail-body">' +
      renderLcSkillDetailContent(selected) +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function bindSkillInvClicks(root) {
    if (!root) return;
    const list = root.querySelector('#lc-skills-list');
    if (!list) return;
    list.querySelectorAll('.skill-inv-row').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-skill-row-id');
        if (!id) return;
        state.selectedSkillRowId = id;
        list.querySelectorAll('.skill-inv-row').forEach((row) => {
          row.classList.toggle('on', row.getAttribute('data-skill-row-id') === id);
        });
        const skills = (state.lastData?.rows || []).filter((r) => r.event_type === 'skill.invocation');
        const rec = skills.find((r) => skillRowId(r) === id);
        const detailBody = root.querySelector('#lc-skills-detail-body');
        if (detailBody) detailBody.innerHTML = renderLcSkillDetailContent(rec);
      });
    });
    root.querySelectorAll('#lc-skills-detail-body [data-lc-task]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const tid = btn.getAttribute('data-lc-task');
        if (tid) openLogCenterForSession({ task_id: tid, tab: 'sessions' });
      });
    });
  }

  function actionStatusBadge(status) {
    const raw = status != null ? String(status) : '—';
    const s = raw.toLowerCase();
    if (s === 'ok' || s === 'success' || s === 'completed') {
      return '<span class="lc-status-badge lc-status-ok">' + esc(raw) + '</span>';
    }
    if (s === 'failed' || s === 'error') {
      return '<span class="lc-status-badge lc-status-failed">' + esc(raw) + '</span>';
    }
    return '<span class="lc-status-badge">' + esc(raw) + '</span>';
  }

  function renderActionsTable(rows) {
    const actions = rows.filter((r) => r.tab === 'actions');
    if (!actions.length) {
      return `<div class="fl-empty" style="font-size:16px;padding:20px;text-align:center">${emptyMessage()}</div>`;
    }
    const sorted = actions.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const head = `<div class="lc-table-head lc-actions-grid">
      <span>时间</span><span>角色</span><span>动作类型</span><span>目标</span>
      <span>状态</span><span>Task</span><span>Session</span><span>耗时</span>
    </div>`;
    const body = sorted
      .map((r) => {
        const failRow = r.level === 'ERROR' ? ' lc-row-error' : '';
        const target = (r.args_preview || r.tool_name || r.message || '').replace(/^[^·]+·\s*/, '');
        const dur =
          r.duration_ms != null ? `${Math.round(r.duration_ms)}ms` : '—';
        return `<div class="lc-table-row lc-actions-grid lc-row${failRow}" ${rowClickAttrs(r)} title="${esc(r.message || '')}">
        <span>${esc(fmtTime(r.at, r.ts))}</span>
        <span>${esc(r.agent_id || '—')}</span>
        <span class="lc-mono">${esc(r.event_type || '—')}</span>
        <span class="lc-mono lc-action-target" title="${esc(target)}">${esc((target || '—').slice(0, 72))}</span>
        <span>${actionStatusBadge(r.status)}</span>
        <span class="lc-mono" title="${esc(r.task_id)}">${esc((r.task_id || '—').slice(-28))}</span>
        <span class="lc-mono" title="${esc(r.session_id)}">${esc((r.session_id || '—').slice(-12))}</span>
        <span>${esc(dur)}</span>
      </div>`;
      })
      .join('');
    return head + body;
  }

  function renderToolsTable(rows) {
    const tools = rows.filter((r) => r.event_type === 'sdk.tool_call');
    if (!tools.length) {
      return `<div class="fl-empty" style="font-size:16px;padding:20px;text-align:center">${emptyMessage()}</div>`;
    }
    return tools
      .map(
        (r) => `<div class="el-row lc-row" ${rowClickAttrs(r)}>
      <span class="el-ts">${esc(fmtTime(r.at, r.ts))}</span>
      <span class="el-agent">${esc(r.agent_id || '—')}</span>
      <span class="lc-mono">${esc(r.tool_name || '—')}</span>
      <span class="el-msg" title="${esc(r.args_preview || '')}">${esc((r.args_preview || r.message || '').slice(0, 80))}</span>
      <span>${esc(r.status || '—')}</span>
      <span>${r.duration_ms != null ? esc(String(r.duration_ms) + 'ms') : '—'}</span>
    </div>`,
      )
      .join('');
  }

  function renderRawJsonl(tail, path) {
    const meta = path
      ? `<div style="padding:8px 12px;font-size:15px;color:var(--text3);border-bottom:1px solid var(--bd)">文件：${esc(path)} · ${tail.length} 条（最近）</div>`
      : '';
    if (!tail.length) {
      return (
        meta +
        `<div class="fl-empty" style="font-size:16px;padding:20px;text-align:center">JSONL 暂无记录或未配置持久化路径。</div>`
      );
    }
    return (
      meta +
      `<pre class="lc-raw-pre">${esc(JSON.stringify(tail, null, 2))}</pre>`
    );
  }

  function gatewayRowClass(row) {
    const gl = row.payload && row.payload.gateway_level;
    if (gl === 'slow') return ' lc-row-slow';
    if (gl === 'timeout') return ' lc-row-timeout';
    if (gl === 'error') return ' lc-row-gw-error';
    return '';
  }

  function gatewayLevelLabel(row) {
    const gl = row.payload && row.payload.gateway_level;
    if (gl === 'slow') return 'SLOW';
    if (gl === 'timeout') return 'TIMEOUT';
    if (gl === 'error') return 'ERROR';
    return 'INFO';
  }

  function renderGatewayTable(rows) {
    if (!rows.length) {
      return `<div class="fl-empty" style="font-size:16px;padding:20px;text-align:center">${emptyMessage()}</div>`;
    }
    const sorted = rows.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const head = `<div class="lc-table-head lc-gateway-grid">
      <span>时间</span><span>级别</span><span>method</span><span>path</span>
      <span>status</span><span>duration</span><span>message</span>
    </div>`;
    const body = sorted
      .map((r) => {
        const path = (r.payload && r.payload.path) || '—';
        const dur = r.duration_ms != null ? `${r.duration_ms}ms` : '—';
        const lvl = gatewayLevelLabel(r);
        const lvlCls =
          lvl === 'ERROR'
            ? 'ERROR'
            : lvl === 'TIMEOUT' || lvl === 'SLOW'
              ? 'WARN'
              : 'INFO';
        return `<div class="lc-table-row lc-gateway-grid lc-row${gatewayRowClass(r)}" title="${esc(r.message || '')}">
        <span>${esc(fmtTime(r.at, r.ts))}</span>
        <span class="el-level ${lvlCls}">${esc(lvl)}</span>
        <span class="lc-mono">${esc(r.tool_name || '—')}</span>
        <span class="lc-mono" title="${esc(path)}">${esc(path)}</span>
        <span>${esc(r.status || '—')}</span>
        <span>${esc(dur)}</span>
        <span class="lc-msg" title="${esc(r.message || '')}">${esc(r.message || '')}</span>
      </div>`;
      })
      .join('');
    return head + body;
  }

  function renderGatewayStatusBar() {
    const bar = document.getElementById('lc-gateway-bar');
    if (!bar) return;
    const show = state.tab === 'gateway';
    bar.style.display = show ? 'flex' : 'none';
    if (!show) return;

    const st = state.gatewayStatus || {};
    const busy = state.gatewayReconnectBusy;
    const reconnecting = busy || st.reconnecting === true;
    const online = !reconnecting && st.online === true;

    const dot = document.getElementById('lc-gw-dot');
    if (dot) {
      dot.className =
        'lc-gateway-dot' +
        (reconnecting ? ' reconnecting' : online ? ' on' : ' off');
    }
    const statusText = document.getElementById('lc-gw-status-text');
    if (statusText) {
      statusText.textContent = reconnecting
        ? '重连中'
        : online
          ? '在线'
          : '离线';
    }
    const instEl = document.getElementById('lc-gw-instance');
    if (instEl) {
      instEl.textContent = st.instance_id
        ? `instance_id: ${st.instance_id}`
        : '';
    }
    const connEl = document.getElementById('lc-gw-last-connected');
    if (connEl) {
      connEl.textContent = st.last_connected_at
        ? `上次连接: ${fmtTime(st.last_connected_at, null)}`
        : '';
    }
    const errEl = document.getElementById('lc-gw-last-error');
    if (errEl) {
      const err = st.last_error ? String(st.last_error) : '';
      errEl.textContent = err ? `错误: ${err}` : '';
      errEl.title = err;
    }
    const btn = document.getElementById('lc-gw-reconnect-btn');
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? '重连中…' : '重连 Gateway';
    }
  }

  async function requestGatewayReconnect() {
    if (state.gatewayReconnectBusy) return;
    state.gatewayReconnectBusy = true;
    renderGatewayStatusBar();
    try {
      const r = await fetchWithTimeout('/api/v2/mobile/gateway/reconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
      const stR = await fetchWithTimeout('/api/v2/mobile/gateway/status');
      if (stR.ok) state.gatewayStatus = await stR.json();
      void fetchLogCenter();
    } catch (err) {
      console.warn('[log-center] gateway reconnect failed', err);
      alert('重连失败: ' + (err && err.message ? err.message : String(err)));
    } finally {
      state.gatewayReconnectBusy = false;
      renderGatewayStatusBar();
    }
  }

  function bindRowClicks(root) {
    if (!root) return;
    root.querySelectorAll('.lc-row[data-session]:not(.lc-row-grouped)').forEach((el) => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        const sid = el.getAttribute('data-session');
        const tid = el.getAttribute('data-task');
        if (sid) {
          state.session_id = sid;
          state.tab = 'sessions';
          void fetchLogCenter();
        } else if (tid) {
          openLogCenterForSession({ task_id: tid, tab: 'sessions' });
        }
      });
    });
  }

  function renderLogCenterBody() {
    const body = document.getElementById('lc-body');
    const meta = document.getElementById('lc-meta');
    if (!body) return;
    const data = state.lastData || { rows: [], sessions: [], jsonl_tail: [] };
    if (meta) {
      const pathHint =
        state.tab === 'actions' && data.actions_path
          ? data.actions_path
          : data.jsonl_path;
      meta.textContent = state.loading
        ? '加载中…'
        : `当前显示 ${data.total ?? data.rows?.length ?? 0} 条` +
          (data.rawTotal != null ? ` · 原始事件 ${data.rawTotal} 条` : '') +
          (pathHint ? ` · ${pathHint}` : '');
    }
    let html = '';
    if (state.tab === 'sessions') {
      html = renderSessionsTable(data.sessions || []);
    } else if (state.tab === 'runtime-alerts') {
      html = renderRuntimeAlerts(data.runtimeAlerts || []);
    } else if (state.tab === 'tools') {
      html = renderToolsTable(data.rows || []);
    } else if (state.tab === 'actions') {
      html = renderActionsTable(data.rows || []);
    } else if (state.tab === 'skills') {
      html = renderSkillsTable(data.rows || []);
    } else if (state.tab === 'gateway') {
      html = renderGatewayTable(data.rows || []);
    } else if (state.tab === 'raw') {
      html = renderRawJsonl(data.jsonl_tail || [], data.jsonl_path);
    } else {
      html = renderGenericRows(data.rows || []);
    }
    body.innerHTML = html;
    if (state.tab === 'skills') {
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.minHeight = '280px';
      bindSkillInvClicks(body);
    } else if (state.tab === 'runtime-alerts') {
      body.style.display = '';
      body.style.flexDirection = '';
      body.style.minHeight = '';
      bindRuntimeAlertActions(body);
    } else {
      body.style.display = '';
      body.style.flexDirection = '';
      body.style.minHeight = '';
      bindRowClicks(body);
    }
    applyFilteredStats(data.alertRowsForStats || []);
    renderGatewayStatusBar();
  }

  function updateStatsHint(stats) {
    const hint = document.getElementById('lc-today-hint');
    if (!hint) return;
    hint.style.display = 'block';
    hint.innerHTML =
      '当前筛选：独立故障 <strong style="color:#fca5a5">' + stats.independentFaults +
      '</strong>，警告 <strong style="color:#fcd34d">' + stats.warnings +
      '</strong>；原始事件 ' + stats.rawEvents +
      '，其中今日 ' + stats.todayEvents +
      '、本次 Shell 启动后 ' + stats.startupEvents +
      '。同一故障链可展开查看全部原始证据；Cursor 用量时间不参与此统计。';
  }

  function applyFilteredStats(alertRows) {
    const stats = Core.calculateStats(alertRows, {
      processStartTs: state.processStartTs,
      now: Date.now(),
    });
    const $e = (id) => document.getElementById(id);
    if ($e('el-cnt-error')) $e('el-cnt-error').textContent = String(stats.errors);
    if ($e('el-cnt-warn')) $e('el-cnt-warn').textContent = String(stats.warnings);
    if ($e('el-cnt-today')) $e('el-cnt-today').textContent = String(stats.todayEvents);
    if ($e('el-cnt-startup')) $e('el-cnt-startup').textContent = String(stats.startupEvents);
    if ($e('el-cnt-raw')) $e('el-cnt-raw').textContent = String(stats.rawEvents);
    updateStatsHint(stats);
  }

  function renderLogCenterShell() {
    document.querySelectorAll('#lc-tab-chips .tp-chip').forEach((b) => {
      b.classList.toggle('on', b.dataset.lctab === state.tab);
    });
    const evEl = document.getElementById('lc-f-ev');
    if (evEl && document.activeElement !== evEl) {
      evEl.placeholder =
        state.tab === 'actions'
          ? '动作类型 (file.read…)'
          : state.tab === 'skills'
            ? 'skill_id'
            : 'event_type';
    }
    const ids = ['lc-f-agent', 'lc-f-task', 'lc-f-session', 'lc-f-ev', 'lc-f-status', 'lc-f-reason', 'lc-f-since'];
    const vals = [
      state.agent,
      state.task_id,
      state.session_id,
      state.event_type,
      state.status,
      state.reason,
      state.sinceHours,
    ];
    ids.forEach((id, i) => {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el) el.value = vals[i];
    });
    const filters = document.querySelector('.lc-filters');
    if (filters) {
      filters.style.display = state.tab === 'gateway' || state.tab === 'runtime-alerts' ? 'none' : '';
    }
    renderGatewayStatusBar();
  }

  function setLogCenterTab(tab) {
    if (tab !== 'skills') state.selectedSkillRowId = null;
    state.tab = tab;
    renderLogCenterShell();
    void fetchLogCenter();
  }

  function applyLogCenterFilters() {
    state.agent = document.getElementById('lc-f-agent')?.value ?? '';
    state.task_id = document.getElementById('lc-f-task')?.value ?? '';
    state.session_id = document.getElementById('lc-f-session')?.value ?? '';
    state.event_type = document.getElementById('lc-f-ev')?.value ?? '';
    state.status = document.getElementById('lc-f-status')?.value ?? '';
    state.reason = document.getElementById('lc-f-reason')?.value ?? '';
    state.sinceHours = document.getElementById('lc-f-since')?.value ?? '24';
    void fetchLogCenter();
  }

  function clearLogCenterFilters() {
    state.agent = '';
    state.task_id = '';
    state.session_id = '';
    state.event_type = '';
    state.status = '';
    state.reason = '';
    state.sinceHours = '24';
    renderLogCenterShell();
    void fetchLogCenter();
  }

  function openLogCenterForSession(opts) {
    opts = opts || {};
    if (opts.task_id) state.task_id = String(opts.task_id);
    if (opts.session_id) state.session_id = String(opts.session_id);
    if (opts.reason) state.reason = String(opts.reason);
    state.tab = opts.tab || 'sessions';
    if (opts.setReturn !== false) {
      const from = opts.returnPage || currentPageId() || global._lcNavFrom;
      if (from && from !== 'errorlog') {
        setLogCenterReturn({
          page: from,
          reportFilename: opts.reportFilename || '',
        });
        global._lcKeepReturn = true;
        if (opts.reportFilename) global._lcDrillReport = opts.reportFilename;
      }
    }
    if (typeof global.navTo === 'function') {
      global.navTo('errorlog');
    } else {
      void fetchLogCenter();
    }
  }

  function openLogCenterForReport(reportRef) {
    const fromPage = currentPageId() || global._lcNavFrom || 'reports';
    let taskId = '';
    let agent = '';
    let reportFilename = '';
    if (reportRef && typeof reportRef === 'object') {
      const f = reportRef;
      reportFilename = String(f.filename || '');
      taskId = String(f.task_id || f.parent_task_id || '');
      agent = String(f.sender || f.from || f.agent_id || '');
      const blob = [f.filename, f.subject, f.preview, f.summary].filter(Boolean).join(' ');
      if (!taskId) {
        const m = blob.match(/TASK-\d{8}-\d{3,}[^/\s]*/i);
        if (m) taskId = m[0];
      }
    } else {
      const s = String(reportRef || '');
      const m = s.match(/TASK-\d{8}-\d{3,}[^/\s]*/i);
      if (m) taskId = m[0];
    }
    if (reportFilename) global._lcDrillReport = reportFilename;
    if (taskId) {
      openLogCenterForSession({
        task_id: taskId,
        tab: 'sessions',
        returnPage: fromPage,
        reportFilename,
        setReturn: true,
      });
      return;
    }
    if (agent) {
      state.agent = agent;
      state.tab = 'sessions';
      setLogCenterReturn({ page: fromPage, reportFilename });
      global._lcKeepReturn = true;
      if (typeof global.navTo === 'function') global.navTo('errorlog');
      else void fetchLogCenter();
      return;
    }
    openLogCenterForSession({
      tab: 'all',
      returnPage: fromPage,
      reportFilename,
      setReturn: true,
    });
  }

  function renderLogCenter() {
    syncLogCenterBackButton();
    renderLogCenterShell();
    void fetchLogCenter();
    if (typeof global.loadUptimeForLog === 'function') global.loadUptimeForLog();
  }

  function lcRefreshIfVisible() {
    const page = document.getElementById('page-errorlog');
    if (page && page.style.display !== 'none') {
      void fetchLogCenter();
    }
  }

  function initLogCenterUi() {
    const chips = document.getElementById('lc-tab-chips');
    if (!chips || chips.dataset.lcBound === '1') return;
    chips.dataset.lcBound = '1';
    syncLogCenterBackButton();
    TABS.forEach((t) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tp-chip' + (t.id === state.tab ? ' on' : '');
      btn.dataset.lctab = t.id;
      btn.textContent = t.label;
      btn.onclick = () => setLogCenterTab(t.id);
      chips.appendChild(btn);
    });
    document.getElementById('el-stat-error-card')?.addEventListener('click', () => {
      setLogCenterTab('alerts');
    });
    document.getElementById('el-stat-warn-card')?.addEventListener('click', () => {
      setLogCenterTab('alerts');
    });
    const gwBtn = document.getElementById('lc-gw-reconnect-btn');
    if (gwBtn && gwBtn.dataset.lcBound !== '1') {
      gwBtn.dataset.lcBound = '1';
      gwBtn.addEventListener('click', () => {
        void requestGatewayReconnect();
      });
    }
  }

  global.setLogCenterTab = setLogCenterTab;
  global.applyLogCenterFilters = applyLogCenterFilters;
  global.clearLogCenterFilters = clearLogCenterFilters;
  global.fetchLogCenter = fetchLogCenter;
  global.renderLogCenterBody = renderLogCenterBody;
  global.renderLogCenter = renderLogCenter;
  global.openLogCenterForSession = openLogCenterForSession;
  global.openLogCenterForReport = openLogCenterForReport;
  global.logCenterGoBack = logCenterGoBack;
  global.clearLogCenterReturn = clearLogCenterReturn;
  global.lcRefreshIfVisible = lcRefreshIfVisible;
  global.initLogCenterUi = initLogCenterUi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLogCenterUi);
  } else {
    initLogCenterUi();
  }

  console.log('[log-center] loaded restore-v3 2026-06-10');
})(typeof window !== 'undefined' ? window : globalThis);
