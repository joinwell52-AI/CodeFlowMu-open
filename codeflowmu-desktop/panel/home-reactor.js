/**
 * CodeFlowMu Home · FCoP Five-Bucket Reactor (live data)
 * Spec: docs/CODEFLOWMU_HOME_FCOP_REACTOR_DEV_SPEC.md
 * Data: /api/v2/tasks, /api/v2/reports, /api/v2/approvals, /api/v2/doorbell/system
 */
(function (global) {
  'use strict';

  const COLORS = {
    inbox: '#39a3ff',
    active: '#e5b43b',
    review: '#a66cff',
    done: '#36d77d',
    archive: '#8ca1bd',
  };

  const DEFAULT_CORE_BUCKET = 'inbox';

  function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6) return { r: 57, g: 163, b: 255 };
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function rgbaHex(hex, a) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  }

  function rgbMix(hex, dim) {
    const { r, g, b } = hexToRgb(hex);
    const d = (v) => Math.min(255, Math.max(0, Math.round(v * dim)));
    return `rgb(${d(r)},${d(g)},${d(b)})`;
  }

  /** 中心圆主题色：进入/选中哪个桶就用哪个桶的颜色 */
  function applyCoreBucketTheme(core, bucketKey) {
    if (!core) return;
    const key = bucketKey && COLORS[bucketKey] ? bucketKey : DEFAULT_CORE_BUCKET;
    const hex = COLORS[key];
    core.style.setProperty('--core-accent', hex);
    core.style.setProperty('--core-border', rgbaHex(hex, 0.58));
    core.style.setProperty('--core-glow', rgbaHex(hex, 0.3));
    core.style.setProperty('--core-bg-mid', rgbMix(hex, 0.38));
    core.style.setProperty('--core-bg-deep-1', rgbMix(hex, 0.16));
    core.style.setProperty('--core-bg-deep-2', rgbMix(hex, 0.07));
    core.style.setProperty('--core-wave-a-top', rgbaHex(hex, 0.58));
    core.style.setProperty('--core-wave-a-bottom', rgbaHex(hex, 0.84));
    core.style.setProperty('--core-wave-b-top', rgbaHex(hex, 0.36));
    core.style.setProperty('--core-wave-b-bottom', rgbaHex(hex, 0.74));
    core.style.setProperty('--core-event-glow', rgbaHex(hex, 0.16));
    core.style.setProperty('--core-pulse-low', rgbaHex(hex, 0.2));
    core.style.setProperty('--core-pulse-high', rgbaHex(hex, 0.55));
    core.style.setProperty('--core-title', rgbaHex(hex, 0.95));
    core.style.setProperty('--core-action-text', rgbaHex(hex, 0.92));
    BUCKET_KEYS.forEach((k) => core.classList.toggle(`bucket-${k}`, k === key));
    core.dataset.bucket = key;
  }

  function resolveEventBucketKey(to) {
    if (to && to !== 'core' && COLORS[to]) return to;
    return DEFAULT_CORE_BUCKET;
  }

  const MEANINGS = {
    inbox: '任务舱。任务文件创建后先进入这里，等待角色认领。',
    active: '执行舱。任务被 PM/DEV/OPS/QA 认领后进入这里。',
    review: '判定舱。执行者提交回执后，任务等待上游角色判定。判定不是审批页。',
    done: '完成舱。上游角色根据回执判定通过后，任务进入完成舱。',
    archive: '归档舱。已归档文件只读保存，归档舱只进不出。',
  };

  const BUCKET_KEYS = ['inbox', 'active', 'review', 'done', 'archive'];

  const BUCKET_META = {
    inbox: { name: '任务舱', sub: '待领取' },
    active: { name: '执行舱', sub: '执行中' },
    review: { name: '判定舱', sub: '待判定' },
    done: { name: '完成舱', sub: '已完成' },
    archive: { name: '归档舱', sub: '已归档（只读）' },
  };

  /** 四角色 ↔ 生命周期桶（思考流在侧栏合并展示，不占画布四角） */
  const CORNER_THINK_BUCKETS = ['archive', 'active', 'done', 'review'];
  const AGENT_THINK_SLOTS = [
    { corner: 'tl', bucket: 'archive', role: 'PM', label: 'PM', hint: '规划 · 技能 · 治理' },
    { corner: 'tr', bucket: 'active', role: 'DEV', label: 'DEV', hint: '实现 · 测试 · 落盘' },
    { corner: 'bl', bucket: 'done', role: 'QA', label: 'QA', hint: '验收 · 回归' },
    { corner: 'br', bucket: 'review', role: 'OPS', label: 'OPS', hint: '运维 · 发布' },
  ];
  const THINK_MAX_LINES = 24;
  const THINK_PHASE_GAP_MS = 45000;

  /** 治理图形库 · Governance Iconography（感知 / 研判 / 驱动 / 闭环） */
  const GOV_ICONS = {
    scan: { zone: 'perceive', glyph: '🔍', label: 'Scan', cn: '扫描' },
    fetch: { zone: 'perceive', glyph: '📖', label: 'Fetch', cn: '读取' },
    map: { zone: 'perceive', glyph: '🗺️', label: 'Map', cn: '映射' },
    observe: { zone: 'perceive', glyph: '👁️', label: 'Observe', cn: '感知' },
    judge: { zone: 'judge', glyph: '⚖️', label: 'Judge', cn: '研判' },
    reason: { zone: 'judge', glyph: '🧠', label: 'Reason', cn: '推理' },
    route: { zone: 'judge', glyph: '🔀', label: 'Route', cn: '分流' },
    insight: { zone: 'judge', glyph: '💡', label: 'Insight', cn: '洞察' },
    invoke: { zone: 'drive', glyph: '⚡', label: 'Invoke', cn: '调用' },
    retry: { zone: 'drive', glyph: '🔄', label: 'Retry', cn: '重试' },
    patch: { zone: 'drive', glyph: '🛠️', label: 'Patch', cn: '纠偏' },
    sync: { zone: 'drive', glyph: '⚙️', label: 'Sync', cn: '同步' },
    resolve: { zone: 'close', glyph: '🏁', label: 'Resolve', cn: '闭环' },
    verify: { zone: 'close', glyph: '✅', label: 'Verify', cn: '确认' },
    archive: { zone: 'close', glyph: '📁', label: 'Archive', cn: '归档' },
    deploy: { zone: 'close', glyph: '🚀', label: 'Deploy', cn: '上线' },
  };

  const GOV_ZONE_TITLE = {
    perceive: '感知',
    judge: '研判',
    drive: '驱动',
    close: '闭环',
  };

  const GOV_STATUS = {
    healthy: { glyph: '🟢', label: '正常', color: '#4ade80' },
    throttled: { glyph: '🟡', label: '限流', color: '#fbbf24' },
    blocked: { glyph: '🔴', label: '阻塞', color: '#f87171' },
    syncing: { glyph: '🔵', label: '同步中', color: '#60a5fa' },
  };

  /** 演示：TASK-20260603-005 治理链（PM-01 → 左上归档舱） */
  const THINK_DEMO_ARCHIVE = [
    { kind: 'tool', iconId: 'scan', text: 'glob 扫描 fcop/ledger 目录', gapMin: 0 },
    { kind: 'tool', iconId: 'fetch', text: '读取 PM.todo.md · 发现 TASK-20260603-005', gapMin: 0 },
    { kind: 'tool', iconId: 'map', text: '映射依赖 · docs/skills/pm-product-requirements', gapMin: 0 },
    { kind: 'tool', iconId: 'judge', text: 'Auth 核查 PM 权限 · Authorized', gapMin: 0.17 },
    { kind: 'think', iconId: 'reason', text: '分析路径 · ADMIN-to-PM 直接指令', gapMin: 0.17 },
    { kind: 'tool', iconId: 'route', text: '治理路由 · 准备 Governance API', gapMin: 0.17 },
    { kind: 'tool', iconId: 'invoke', text: '发送 review-check 请求', gapMin: 0.33 },
    { kind: 'tool', iconId: 'retry', text: '限流保护 · Start-Sleep 等待 5s', gapMin: 0.33, status: 'throttled' },
    { kind: 'tool', iconId: 'patch', text: 'UTF-8 编码差异 · 自动纠偏', gapMin: 0.33 },
    { kind: 'tool', iconId: 'resolve', text: '提交闭档 close-draft', gapMin: 0.58 },
    { kind: 'tool', iconId: 'archive', text: '写入 REPORT-005-PM-COMPLETE.md', gapMin: 0.58 },
    { kind: 'tool', iconId: 'verify', text: '状态同步确认 · SUCCESS', gapMin: 0.58, status: 'healthy' },
  ];

  let _thinkByBucket = {
    archive: [],
    active: [],
    done: [],
    review: [],
  };
  /** 四角面板已移除；保留桩，避免旧版缓存脚本访问 _cornerThinkEls 报错 */
  let _cornerThinkEls = Object.create(null);
  let _thinkRenderTimer = null;
  const THINK_MERGE_WINDOW_MS = 15000;
  const THINK_MAX_TEXT_CHARS = 4000;

  const TB_SCOPE_ALIASES = { admin: 'inbox', lifecycle: 'inbox' };

  /** 生命周期上一桶（taskId 回退映射用） */
  const PREV_BUCKET = {
    inbox: 'core',
    active: 'inbox',
    review: 'active',
    done: 'review',
    archive: 'done',
  };
  const HEALTH_RANK = { normal: 1, waiting: 2, review: 2, blocked: 3, admin: 4 };

  let _bucketDefs = [];
  let _adminItems = [];
  let _recentEvents = [];
  let _doorbellEvents = [];
  let _loadError = null;
  let _loading = false;
  let _lastRefreshAt = null;

  let _selectedBucket = null;
  let _jiggleTimer = null;
  let _coreTimer = null;
  let _replayTimer = null;
  let _replayQueue = [];
  let _replayIndex = 0;
  let _bucketEls = {};
  let _reactorEl = null;
  let _resizeObs = null;
  let _resizeRaf = null;

  /** 设计稿 930×700 上的 orb 椭圆分布参数（相对桶尺寸的比例） */
  const ORB_CY_RATIO = 108 / 190;
  const ORB_RX_RATIO = 64 / 230;
  const ORB_RY_RATIO = 35 / 190;
  const DESIGN_W = 930;
  const DESIGN_H = 700;

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function callGlobal(fnName, ...args) {
    const fn = global[fnName];
    return typeof fn === 'function' ? fn(...args) : undefined;
  }

  function getPanelLang() {
    if (global.lang === 'en' || global.lang === 'zh') return global.lang;
    try {
      const stored = localStorage.getItem('cf-lang');
      if (stored === 'en' || stored === 'zh') return stored;
    } catch (_) { /* ignore */ }
    return 'zh';
  }

  function rt(key, vars) {
    const lang = getPanelLang();
    const dict = (global.REACTOR_I18N && global.REACTOR_I18N[lang]) || {};
    const fallback = (global.REACTOR_I18N && global.REACTOR_I18N.zh) || {};
    let s = dict[key] != null ? dict[key] : (fallback[key] != null ? fallback[key] : key);
    if (vars && typeof vars === 'object') {
      Object.keys(vars).forEach((k) => {
        s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(vars[k]));
      });
    }
    return s;
  }

  function bucketMeta(key) {
    return {
      name: rt(`reactor.bucket.${key}.name`),
      sub: rt(`reactor.bucket.${key}.sub`),
    };
  }

  function bucketMeaning(key) {
    return rt(`reactor.bucket.${key}.meaning`);
  }

  function thinkSlotHint(role) {
    const map = { PM: 'pm', DEV: 'dev', QA: 'qa', OPS: 'ops' };
    const r = map[String(role || '').toUpperCase()] || 'pm';
    return rt(`reactor.think.hint.${r}`);
  }

  function govZoneTitle(zone) {
    return rt(`reactor.gov.zone.${zone}`) || zone;
  }

  function govStatusMeta(key) {
    const base = GOV_STATUS[key];
    if (!base) return null;
    return { ...base, label: rt(`reactor.gov.status.${key}`) };
  }

  function govIconMeta(iconId) {
    const id = GOV_ICONS[iconId] ? iconId : 'sync';
    const base = GOV_ICONS[id];
    return { ...base, cn: rt(`reactor.gov.icon.${id}`) };
  }

  function thinkToolLabel(tool) {
    const key = String(tool || '').toLowerCase();
    if (!key) return rt('reactor.tool.invoke');
    const i18nKey = `reactor.tool.${key}`;
    const label = rt(i18nKey);
    return label !== i18nKey ? label : rt('reactor.tool.generic', { tool: key });
  }

  function renderBucketInfoHtml(b) {
    if (!b) return '';
    const key = b.key;
    return `
<b style="color:${b.color};font-size:15px">${esc(b.name)}</b><br/>
${esc(bucketMeaning(key))}<br/><br/>
<b>${esc(rt('reactor.bucketInfo.distributionTitle'))}</b><br/>
${esc(rt('reactor.bucketInfo.distributionLine', { tasks: b.taskCount, reports: b.reportCount, total: bucketCount(b) }))}<br/>
${esc(rt('reactor.bucketInfo.statsLine', { normal: b.stats.normal, waiting: b.stats.waiting, blocked: b.stats.blocked, admin: b.stats.admin }))}<br/><br/>
<b>${esc(rt('reactor.bucketInfo.operationsTitle'))}</b><br/>
${esc(rt('reactor.bucketInfo.operationsHint'))}`;
  }

  function refreshBucketDefLabels() {
    _bucketDefs.forEach((b) => {
      const m = bucketMeta(b.key);
      b.name = m.name;
      b.sub = m.sub;
    });
  }

  function refreshBucketVesselDomLabels() {
    if (_bucketDefs.length) {
      refreshBucketDefLabels();
      _bucketDefs.forEach((b) => {
        const el = _bucketEls[b.key];
        if (!el) return;
        const title = el.querySelector('.home-v-title');
        if (title) title.innerHTML = `${esc(b.name)}<small>${esc(b.sub)}</small>`;
      });
      return;
    }
    BUCKET_KEYS.forEach((key) => {
      const el = _bucketEls[key];
      if (!el) return;
      const m = bucketMeta(key);
      const title = el.querySelector('.home-v-title');
      if (title) title.innerHTML = `${esc(m.name)}<small>${esc(m.sub)}</small>`;
    });
  }

  function refreshHomeStaticChrome() {
    const coreTitle = document.querySelector('#page-home .home-core-default h2');
    const coreSub = document.querySelector('#page-home .home-core-sub');
    if (coreTitle) coreTitle.textContent = rt('reactor.core.title');
    if (coreSub) coreSub.innerHTML = rt('reactor.core.subHtml');

    const rule = document.querySelector('#page-home .home-rule');
    if (rule) rule.innerHTML = rt('reactor.rule.flowHtml');

    const legend = document.querySelector('#page-home .home-legend');
    if (legend) {
      legend.innerHTML = `
        <span>${esc(rt('reactor.legend.normal'))}</span>
        <span class="waiting">${esc(rt('reactor.legend.waiting'))}</span>
        <span class="blocked">${esc(rt('reactor.legend.blocked'))}</span>
        <span class="admin">${esc(rt('reactor.legend.admin'))}</span>
        <span style="opacity:.8">${esc(rt('reactor.legend.orbHint'))}</span>`;
    }

    const adminH3 = document.querySelector('#page-home .admin-panel h3');
    if (adminH3) adminH3.textContent = rt('reactor.sidebar.adminTitle');

    const thinkH3 = document.querySelector('#page-home .home-panel-think h3');
    if (thinkH3) thinkH3.textContent = rt('reactor.sidebar.thinkTitle');

    const thinkHint = document.querySelector('#page-home .home-think-feed-hint');
    if (thinkHint) thinkHint.textContent = rt('reactor.sidebar.thinkHint');

    const bucketH3 = document.querySelector('#page-home .home-panel:not(.admin-panel):not(.home-panel-think) h3');
    if (bucketH3) bucketH3.textContent = rt('reactor.sidebar.bucketDetailTitle');

    const bucketInfo = document.getElementById('homeBucketInfo');
    if (bucketInfo && !_selectedBucket) {
      bucketInfo.textContent = rt('reactor.sidebar.bucketPlaceholder');
    }

    const refreshBtn = document.getElementById('homeRefreshBtn');
    if (refreshBtn) {
      const sm = refreshBtn.querySelector('small');
      if (sm) sm.textContent = rt('reactor.toolbar.refresh');
      refreshBtn.title = rt('reactor.toolbar.refreshTitle');
    }
    const replayBtn = document.getElementById('homeReplayBtn');
    if (replayBtn) {
      const sm = replayBtn.querySelector('small');
      if (sm) sm.textContent = rt('reactor.toolbar.replay');
      replayBtn.title = rt('reactor.toolbar.replayTitle');
    }
    syncFullscreenBtn();
  }

  let _fullscreenEscBound = false;

  function isHomeReactorPage() {
    const p = global.curPage;
    return p === 'home' || p === 'bigscreen';
  }

  function syncFullscreenBtn() {
    const btn = document.getElementById('homeFullscreenBtn');
    if (!btn) return;
    const on = document.documentElement.classList.contains('cf-bigscreen-fs');
    const sm = btn.querySelector('small');
    if (sm) sm.textContent = rt(on ? 'reactor.toolbar.fullscreenExit' : 'reactor.toolbar.fullscreen');
    btn.title = rt(on ? 'reactor.toolbar.fullscreenExitTitle' : 'reactor.toolbar.fullscreenTitle');
    btn.classList.toggle('active', on);
    const strong = btn.querySelector('strong');
    if (strong) strong.textContent = on ? '\u2913' : '\u26F6';
  }

  function onFullscreenEsc(e) {
    if (e.key === 'Escape') exitBigScreenFullscreen();
  }

  function enterBigScreenFullscreen() {
    document.documentElement.classList.add('cf-bigscreen-fs');
    if (!_fullscreenEscBound) {
      document.addEventListener('keydown', onFullscreenEsc);
      _fullscreenEscBound = true;
    }
    syncFullscreenBtn();
  }

  function exitBigScreenFullscreen() {
    document.documentElement.classList.remove('cf-bigscreen-fs');
    if (_fullscreenEscBound) {
      document.removeEventListener('keydown', onFullscreenEsc);
      _fullscreenEscBound = false;
    }
    syncFullscreenBtn();
  }

  function toggleBigScreenFullscreen() {
    if (document.documentElement.classList.contains('cf-bigscreen-fs')) {
      exitBigScreenFullscreen();
    } else {
      enterBigScreenFullscreen();
    }
  }

  function refreshThinkLinesForLang() {
    for (const bucket of Object.keys(_thinkByBucket)) {
      const arr = _thinkByBucket[bucket];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        arr[i] = normalizeThinkLine(arr[i]);
      }
    }
  }

  function applyHomeReactorI18n() {
    if (!document.getElementById('page-home')) return;
    refreshHomeStaticChrome();
    refreshBucketVesselDomLabels();
    refreshThinkLinesForLang();
    if (_homeTasksCache.length || _adminItems.length) {
      _adminItems = buildAdminItems(
        _homeTasksCache,
        _homeApprovalsCache,
        global.ledgerThreads || []
      );
    }
    _bucketDefs.forEach((b) => {
      const m = bucketMeta(b.key);
      b.name = m.name;
      b.sub = m.sub;
    });
    const stats = document.getElementById('homeToolbarStats');
    if (stats) {
      const st = _bucketDefs.length ? globalStats() : { total: 0, tasks: 0, reports: 0, normal: 0, waiting: 0, blocked: 0, admin: 0 };
      stats.innerHTML = renderKpis(st);
    }
    const adminEl = document.querySelector('#page-home .admin-panel');
    if (adminEl) {
      const h3 = adminEl.querySelector('h3');
      adminEl.innerHTML = `${h3 ? h3.outerHTML : `<h3>${esc(rt('reactor.sidebar.adminTitle'))}</h3>`}${renderAdminPanel()}`;
    }
    renderMergedThinkFeed();
    if (_selectedBucket) homeSelectBucket(_selectedBucket);
    else setHomeStatus(_loadError ? null : (_replayTimer ? rt('reactor.replay.playing') : ''));
  }

  function taskIdPrefix(fn) {
    const g = callGlobal('taskIdPrefix', fn);
    if (g != null && g !== '') return g;
    const m = (fn || '').match(/^(TASK-\d{8}-\d{3,})/);
    return m ? m[1] : '';
  }

  function isAdminMainlineTask(fn) {
    const g = callGlobal('isAdminMainlineTask', fn);
    if (typeof g === 'boolean') return g;
    return /-ADMIN-to-PM/i.test(fn || '');
  }

  function isSmokeArtifactTask(f) {
    const g = callGlobal('isSmokeArtifactTask', f);
    if (typeof g === 'boolean') return g;
    const gt = callGlobal('classifyTask', f);
    if (gt === 'smoke') return true;
    if (gt && gt !== 'unknown') return false;
    const fn = (f && f.filename) || '';
    const subject = String((f && f.subject) || '').trim();
    if (/-ADMIN-to-PM/i.test(fn)) {
      return /topology fix smoke|delete if test|test artifact/i.test(subject);
    }
    return /delete if test|test artifact/i.test(subject);
  }

  function isEvalProtocolTask(f) {
    const g = callGlobal('isEvalProtocolTask', f);
    if (typeof g === 'boolean') return g;
    const fn = (f && f.filename) || '';
    if (/EVAL|OBSERVATION|AUTO-AUDIT/i.test(fn)) return true;
    return false;
  }

  function dashboardTaskList(list) {
    const g = callGlobal('dashboardTaskList', list);
    if (Array.isArray(g)) return g;
    return (list || []).filter((t) => !isEvalProtocolTask(t));
  }

  function reportIdPrefix(fn) {
    const s = String(fn || '');
    const m = s.match(/^(REPORT-\d{8}-\d{3,})/);
    return m ? m[1] : '';
  }

  function taskParentPrefix(f) {
    const g = callGlobal('taskParentPrefix', f);
    if (g) return g;
    const raw = String((f && f.parent) || '');
    const m = raw.match(/TASK-\d{8}-\d{3,}/);
    return m ? m[0] : '';
  }

  /** Ledger / API scope，不含轨道机线程投影。 */
  function rawTaskScope(f) {
    const pathStr = String((f && f.path) || '').replace(/\\/g, '/');
    if (pathStr.includes('/_lifecycle/archive/')) return 'archive';
    const ds = String((f && f.display_status) || '').toLowerCase();
    if (ds === 'waiting_pm_consolidation') return 'waiting_pm_consolidation';
    const g = callGlobal('taskNormScope', f);
    if (typeof g === 'string' && g) return g;
    let s = String((f && f.scope) || 'inbox').toLowerCase();
    s = TB_SCOPE_ALIASES[s] || s;
    // 账本 scope=archive 但文件不在 _lifecycle/archive/ → 勿投影归档舱（幽灵 ledger）
    if (s === 'archive' && !pathStr.includes('/_lifecycle/archive/')) {
      const ds = String((f && f.display_status) || '').toLowerCase();
      if (ds === 'waiting_pm_review') return 'review';
      if (ds === 'done' || ds === 'waiting_pm_consolidation') return 'done';
      if (pathStr.includes('/tasks/') && !pathStr.includes('/_lifecycle/')) return 'done';
      return 'done';
    }
    return s;
  }

  /**
   * 轨道机线程投影：根任务进归档舱时，整线 TASK/REPORT 同舱展示。
   * 产品前提（任务详情 updateTdpLifecycleButtons）：支线未 settled 时根任务不会出「归档」按钮，
   * 故只需在 rootScope===archive 时投影，无需在 done 阶段强行合并。
   */
  let _threadScopeByTaskId = new Map();
  let _threadScopeByReportId = new Map();

  function rebuildThreadScopeProjection(tasks, reports, threads) {
    _threadScopeByTaskId = new Map();
    _threadScopeByReportId = new Map();
    const taskById = new Map();
    for (const t of tasks || []) {
      const id = taskIdPrefix(t.filename || t.task_id || '');
      if (id) taskById.set(id, t);
    }

    const absorbThread = (threadRow, bucketKey) => {
      if (!bucketKey || !BUCKET_KEYS.includes(bucketKey)) return;
      for (const tid of threadRow.task_ids || []) {
        const p = taskIdPrefix(String(tid));
        if (p) _threadScopeByTaskId.set(p, bucketKey);
      }
      for (const rid of threadRow.report_ids || []) {
        const p = reportIdPrefix(String(rid));
        if (p) _threadScopeByReportId.set(p, bucketKey);
      }
    };

    for (const th of threads || []) {
      const rootId = taskIdPrefix(String(th.root_task_id || ''));
      if (!rootId) continue;
      const root = taskById.get(rootId);
      if (!root) continue;
      const rootScope = rawTaskScope(root);
      if (rootScope === 'archive') {
        absorbThread(th, 'archive');
      }
    }

    // 无 threads 行时：parent 链跟随已投影的根/父任务
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of tasks || []) {
        const id = taskIdPrefix(t.filename || '');
        if (!id || _threadScopeByTaskId.has(id)) continue;
        const parent = taskParentPrefix(t);
        const parentBucket = parent ? _threadScopeByTaskId.get(parent) : undefined;
        if (parentBucket) {
          _threadScopeByTaskId.set(id, parentBucket);
          changed = true;
        }
      }
    }

    // PM 汇总 REPORT：references / task_id 链跟主线程同舱（threads 未列全时兜底）
    for (const r of reports || []) {
      const rid = reportIdPrefix(r.filename || '');
      if (!rid || _threadScopeByReportId.has(rid)) continue;
      let bucket = null;
      const refs = r.references;
      const scanRef = (v) => {
        if (!v) return;
        if (Array.isArray(v)) v.forEach(scanRef);
        else {
          const refRid = reportIdPrefix(String(v));
          if (refRid && _threadScopeByReportId.has(refRid)) bucket = _threadScopeByReportId.get(refRid);
        }
      };
      scanRef(refs);
      if (!bucket) {
        for (const tid of getLinkedTaskIds(r)) {
          const tb = _threadScopeByTaskId.get(taskIdPrefix(tid));
          if (tb) {
            bucket = tb;
            break;
          }
        }
      }
      if (bucket) _threadScopeByReportId.set(rid, bucket);
    }

    // 汇总 REPORT 已在归档舱 → references 里的支线 REPORT 同舱
    for (const r of reports || []) {
      const rid = reportIdPrefix(r.filename || '');
      if (!rid || _threadScopeByReportId.get(rid) !== 'archive') continue;
      const scanRefOut = (v) => {
        if (!v) return;
        if (Array.isArray(v)) v.forEach(scanRefOut);
        else {
          const refRid = reportIdPrefix(String(v));
          if (refRid) _threadScopeByReportId.set(refRid, 'archive');
        }
      };
      scanRefOut(r.references);
    }
  }

  function normScope(f) {
    const fn = (f && f.filename) || '';
    if (fn.startsWith('REPORT-')) {
      const rid = reportIdPrefix(fn);
      if (rid && _threadScopeByReportId.has(rid)) return _threadScopeByReportId.get(rid);
    } else {
      const id = taskIdPrefix(fn || (f && f.task_id) || '');
      if (id && _threadScopeByTaskId.has(id)) return _threadScopeByTaskId.get(id);
    }
    return rawTaskScope(f);
  }

  function getLinkedTaskIds(rep) {
    if (typeof callGlobal('reportLinkedTaskIds', rep) !== 'undefined') {
      return callGlobal('reportLinkedTaskIds', rep) || [];
    }
    const ids = new Set();
    if (Array.isArray(rep.linked_task_ids)) rep.linked_task_ids.forEach((id) => ids.add(String(id)));
    [rep.task_id, rep.parent, rep.subject_id].forEach((v) => {
      if (v) ids.add(String(v));
    });
    return [...ids];
  }

  function taskHealth(f) {
    const ds = String((f && f.display_status) || '').toLowerCase();
    if (ds === 'waiting_pm_consolidation') return 'waiting';
    if (callGlobal('taskNeedsHuman', f)) return 'admin';
    const fn = f.filename || '';
    if (/blocked/i.test(fn)) return 'blocked';
    const scope = normScope(f);
    const gl = callGlobal('ghostLevel', f) || '';
    if (gl === 'red') return 'blocked';
    if (gl === 'amber') return 'waiting';
    if (scope === 'active' && callGlobal('inferSt', f, 'T') === 'doing') return 'normal';
    if (scope === 'review') {
      if (callGlobal('hasReportForTask', fn) === false) return 'waiting';
      if (callGlobal('inferSt', f, 'T') === 'todo') return 'waiting';
    }
    if (scope === 'inbox' && callGlobal('inferSt', f, 'T') === 'todo') return 'waiting';
    return 'normal';
  }

  function reportHealth(rep, taskById) {
    let best = 'normal';
    for (const id of getLinkedTaskIds(rep)) {
      const task = taskById.get(id) || taskById.get(taskIdPrefix(id));
      if (!task) continue;
      const h = taskHealth(task);
      if (HEALTH_RANK[h] > HEALTH_RANK[best]) best = h;
    }
    return best;
  }

  function reportBucket(rep, taskById) {
    for (const id of getLinkedTaskIds(rep)) {
      const task = taskById.get(id) || taskById.get(taskIdPrefix(id));
      if (task) return normScope(task);
    }
    const seq = (rep.filename || '').match(/REPORT-(\d{8}-\d{3})/);
    if (seq) {
      const task = (_homeTasksCache || []).find((t) => (t.filename || '').includes(seq[1]));
      if (task) return normScope(task);
    }
    return 'review';
  }

  let _homeTasksCache = [];
  let _homeReportsCache = [];
  let _homeApprovalsCache = [];

  function emptyStats() {
    return { normal: 0, waiting: 0, blocked: 0, admin: 0 };
  }

  function buildBucketDefs(tasks, reports) {
    const threads = global.ledgerThreads || [];
    rebuildThreadScopeProjection(tasks, reports, threads);

    const buckets = BUCKET_KEYS.map((key) => ({
      key,
      name: bucketMeta(key).name,
      sub: bucketMeta(key).sub,
      color: COLORS[key],
      stats: emptyStats(),
      orbs: [],
      taskCount: 0,
      reportCount: 0,
    }));
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    const taskById = new Map();

    const reactorTasks = dashboardTaskList(tasks);
    for (const t of reactorTasks) {
      const key = normScope(t);
      if (!byKey[key]) continue;
      const h = taskHealth(t);
      const smoke = isSmokeArtifactTask(t);
      const mainline = isAdminMainlineTask(t.filename);
      byKey[key].orbs.push({ health: h, type: 'task', file: t, isBranch: !mainline, smoke });
      if (smoke) continue;
      if (mainline) {
        byKey[key].stats[h] += 1;
        byKey[key].taskCount += 1;
      }
      const id = taskIdPrefix(t.filename);
      if (id) taskById.set(id, t);
    }

    for (const r of reports) {
      const key = reportBucket(r, taskById);
      if (!byKey[key]) continue;
      const h = reportHealth(r, taskById);
      byKey[key].stats[h] += 1;
      byKey[key].reportCount += 1;
      byKey[key].orbs.push({ health: h, type: 'report', file: r });
    }

    return buckets;
  }

  function pickRepresentativeOrbs(orbs, bucketKey) {
    const total = orbs.length;
    let limit = total;
    if (total > 40) limit = 16;
    else if (total > 12) limit = 20;
    if (bucketKey === 'archive') limit = Math.min(limit, 24);
    const sorted = [...orbs].sort((a, b) => HEALTH_RANK[b.health] - HEALTH_RANK[a.health]);
    return sorted.slice(0, limit);
  }

  function bucketCount(b) {
    return Object.values(b.stats).reduce((a, n) => a + n, 0);
  }

  function globalStats() {
    let total = 0;
    let tasks = 0;
    let reports = 0;
    const h = emptyStats();
    _bucketDefs.forEach((b) => {
      total += bucketCount(b);
      tasks += b.taskCount;
      reports += b.reportCount;
      Object.entries(b.stats).forEach(([k, v]) => { h[k] = (h[k] || 0) + v; });
    });
    return { total, tasks, reports, ...h };
  }

  function formatTaskWallTime(isoOrMs) {
    const fmt = callGlobal('fmtLocalShortDateTime', isoOrMs);
    if (fmt && fmt !== '—') return fmt;
    return formatRelativeTime(isoOrMs);
  }

  function formatRelativeTime(isoOrMs) {
    let ms = isoOrMs;
    if (typeof isoOrMs === 'string') {
      const d = Date.parse(isoOrMs);
      ms = Number.isNaN(d) ? Date.now() : d;
    }
    if (typeof ms !== 'number' || Number.isNaN(ms)) return '—';
    const diff = Date.now() - ms;
    const min = Math.floor(diff / 60000);
    if (min < 1) return rt('reactor.time.justNow');
    if (min < 60) return rt('reactor.time.minutesAgo', { n: min });
    const hr = Math.floor(min / 60);
    if (hr < 24) return rt('reactor.time.hoursAgo', { n: hr });
    return rt('reactor.time.daysAgo', { n: Math.floor(hr / 24) });
  }

  function formatClock(isoOrMs) {
    let d;
    if (typeof isoOrMs === 'number') d = new Date(isoOrMs);
    else d = new Date(isoOrMs || Date.now());
    if (Number.isNaN(d.getTime())) return '--:--';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function displayTitle(f) {
    const t = callGlobal('fcopDocDisplayTitle', f, 48);
    if (t) return t;
    return f.subject || f.filename || '—';
  }

  function routeLabel(fn) {
    const route = callGlobal('taskRouteFromFn', fn);
    if (!route) return fn || '—';
    return `${route.sender} → ${route.recipient}`;
  }

  function buildAdminItems(tasks, approvals, ledgerThreadsIn) {
    const items = [];
    const seen = new Set();

    for (const a of approvals || []) {
      const fn = a.filename || a.subject_id || a.id || '';
      const id = taskIdPrefix(fn) || fn;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({
        name: displayTitle(a) || fn || id,
        tag: rt('reactor.admin.tag.needsAdmin'),
        tagClass: 'admin',
        reason: a.reason || a.summary || a.decision || rt('reactor.admin.reason.approval'),
        meta: `${a.sender || a.agent_id || '—'} · ${formatTaskWallTime(a.created_at || a.updated_at || a.ts)}`,
        health: 'admin',
        filename: fn,
      });
    }

    for (const row of ledgerThreadsIn || []) {
      if (!row.waiting_pm_consolidation) continue;
      const id = String(row.root_task_id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const t = (tasks || []).find((x) => taskIdPrefix(x.filename) === id || (x.filename || '').includes(id));
      items.push({
        name: t ? displayTitle(t) : id,
        tag: rt('reactor.admin.tag.pmSummary'),
        tagClass: 'waiting',
        reason: rt('reactor.admin.reason.pmSummary'),
        meta: t ? `${routeLabel(t.filename)} · ${formatTaskWallTime(t.updated_at || t.created_at)}` : rt('reactor.admin.meta.ledger'),
        health: 'waiting',
        filename: t ? t.filename : '',
      });
    }

    for (const t of tasks || []) {
      const fn = t.filename || '';
      if (!fn.startsWith('TASK-')) continue;
      const route = callGlobal('taskRouteFromFn', fn);
      if (!route || route.recipient !== 'PM') continue;
      const scope = normScope(t);
      if (scope === 'done' || scope === 'archive') continue;
      if (scope === 'waiting_pm_consolidation') continue;
      const id = taskIdPrefix(fn) || fn;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({
        name: displayTitle(t),
        tag: rt('reactor.admin.tag.pmOpen'),
        tagClass: 'waiting',
        reason: rt('reactor.admin.reason.pmOpen'),
        meta: `${routeLabel(fn)} · ${formatTaskWallTime(t.updated_at || t.created_at)}`,
        health: 'waiting',
        filename: fn,
      });
    }

    const pendingIds = new Set();
    for (const row of ledgerThreadsIn || []) {
      for (const id of row.pending_pm_review || []) {
        pendingIds.add(String(id));
      }
    }
    for (const id of pendingIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const t = (tasks || []).find((x) => taskIdPrefix(x.filename) === id || (x.filename || '').includes(id));
      items.push({
        name: t ? displayTitle(t) : id,
        tag: rt('reactor.admin.tag.pmReview'),
        tagClass: 'review',
        reason: rt('reactor.admin.reason.pmReview'),
        meta: t ? routeLabel(t.filename) : rt('reactor.admin.meta.ledger'),
        health: 'review',
        filename: t ? t.filename : '',
      });
    }

    for (const t of tasks) {
      const h = taskHealth(t);
      if (h !== 'admin' && h !== 'blocked') continue;
      const id = taskIdPrefix(t.filename) || t.filename;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({
        name: displayTitle(t),
        tag: h === 'admin' ? rt('reactor.admin.tag.needsAdmin') : rt('reactor.admin.tag.blocked'),
        tagClass: h === 'admin' ? 'admin' : 'blocked',
        reason: h === 'admin' ? rt('reactor.admin.reason.humanGate') : rt('reactor.admin.reason.blocked'),
        meta: `${routeLabel(t.filename)} · ${formatRelativeTime(t.updated_at || t.created_at)}`,
        health: h,
        filename: t.filename,
      });
    }

    items.sort((a, b) => HEALTH_RANK[b.health] - HEALTH_RANK[a.health]);
    return items.slice(0, 12);
  }

  function parseDoorbellResponse(raw) {
    const hist = Array.isArray(raw) ? raw : (raw?.events ?? raw?.system ?? []);
    return hist.map((e) => ({
      id: e.id || `sys-${e.ts || Date.now()}`,
      ts: e.ts || Date.parse(e.at) || Date.now(),
      at: e.at || (typeof callGlobal('safeIsoString', e.ts) === 'string' ? callGlobal('safeIsoString', e.ts) : callGlobal('toLocalIsoStringOffset', e.ts || Date.now())),
      event_type: e.event_type || e.evType || e.type || 'sys',
      agent_id: e.agent_id || e.agentId || 'system',
      session_id: e.session_id || e.sessionId,
      task_id: e.task_id || e.taskId,
      payload: e.payload || e,
    }));
  }

  /** SSE 保活事件，不应出现在「最近流转」或重播队列。 */
  function isDoorbellNoise(ev) {
    const type = ev.event_type || '';
    return type.includes('heartbeat');
  }

  /** 重播应优先展示的生命周期门铃（含完整状态机各段）。 */
  const LIFECYCLE_REPLAY_RE =
    /inbox_to_active|task_to_review|review_to_done|done_to_archive|review_to_active|done_to_active|root_review_blocked|pending_pm_review/;

  /** 与 lifecycle 同任务时可插入时间线的辅助动作（排除 sdk 噪声）。 */
  const REPLAY_ANCILLARY_RE =
    /runtime\.session_|wake_agent\.|codeflowmu\.failure|codeflowmu\.failure_recorded|codeflowmu\.task_dispatched|codeflowmu\.report_detected|codeflowmu\.report_gate\.|transient_sdk_/;

  function isLifecycleReplayEvent(ev) {
    return LIFECYCLE_REPLAY_RE.test(ev.event_type || '');
  }

  function isReplayAncillaryEvent(ev) {
    const type = ev.event_type || '';
    if (isDoorbellNoise(ev)) return false;
    if (isLifecycleReplayEvent(ev)) return false;
    if (/^sdk\.(tool_call|thinking|status|result)/.test(type)) return false;
    return REPLAY_ANCILLARY_RE.test(type);
  }

  /** 归一化门铃 payload（兼容 SSE 嵌套 payload.payload）。 */
  function doorbellPayload(ev) {
    const pl = ev?.payload || ev || {};
    if (!pl || typeof pl !== 'object') return {};
    if (pl.from_stage || pl.to_stage || pl.task_id || pl.root_task_id) return pl;
    const inner = pl.payload;
    if (inner && typeof inner === 'object') return inner;
    return pl;
  }

  function doorbellAgent(ev) {
    return ev.agent_id || rt('reactor.doorbell.agentFallback');
  }

  function doorbellEventTitle(ev) {
    const type = ev.event_type || '';
    const pl = ev.payload || {};
    const subj = pl.subject || pl.task_id || pl.filename || pl.status || '';
    const agent = doorbellAgent(ev);
    if (type.includes('session_started')) return rt('reactor.doorbell.session_started', { agent });
    if (type.includes('session_completed')) return rt('reactor.doorbell.session_completed', { agent });
    if (type.includes('session_cancelled')) return rt('reactor.doorbell.session_cancelled', { agent });
    if (type.includes('session_ended')) return rt('reactor.doorbell.session_ended', { agent });
    if (type.includes('heartbeat')) return rt('reactor.doorbell.heartbeat');
    if (type.includes('root_review_blocked')) {
      const rid = pl.root_task_id || pl.task_id || '';
      return rid
        ? rt('reactor.doorbell.root_review_blocked', { id: rid })
        : rt('reactor.doorbell.root_review_blocked_short');
    }
    if (type.includes('inbox_to_active')) return rt('reactor.doorbell.inbox_to_active');
    if (type.includes('task_to_review')) return rt('reactor.doorbell.task_to_review');
    if (type.includes('review_to_done')) return rt('reactor.doorbell.review_to_done');
    if (type.includes('done_to_archive')) return rt('reactor.doorbell.done_to_archive');
    if (type.includes('review_to_active')) return rt('reactor.doorbell.review_to_active');
    if (type.includes('done_to_active')) return rt('reactor.doorbell.done_to_active');
    if (type.includes('pending_pm_review')) return rt('reactor.doorbell.pending_pm_review');
    if (type.includes('task_dispatched')) return rt('reactor.doorbell.task_dispatched');
    if (type.includes('report_detected')) return rt('reactor.doorbell.report_detected');
    if (type.includes('failure_recorded') || type.includes('codeflowmu.failure')) {
      return rt('reactor.doorbell.failure_recorded');
    }
    if (type.includes('report_gate.missing_report')) return rt('reactor.doorbell.report_gate_missing');
    if (type.includes('wake_agent.')) return rt('reactor.doorbell.wake_agent');
    if (type.includes('transient_sdk')) return rt('reactor.doorbell.transient_sdk');
    if (type.includes('thinking')) return rt('reactor.doorbell.thinking', { agent });
    if (type.includes('status')) return rt('reactor.doorbell.status', { agent });
    return subj ? String(subj).slice(0, 40) : type;
  }

  function doorbellEventMeta(ev) {
    const type = ev.event_type || '';
    const pl = doorbellPayload(ev);
    if (pl._inferred) return rt('reactor.doorbell.meta.inferred');
    if (type.includes('root_review_blocked')) {
      return pl.child_tasks_settled
        ? rt('reactor.doorbell.meta.root_blocked_settled')
        : String(pl.reason || rt('reactor.doorbell.meta.root_blocked_default'));
    }
    if (type.includes('inbox_to_active')) return rt('reactor.doorbell.meta.inbox_to_active');
    if (type.includes('task_to_review')) return rt('reactor.doorbell.meta.task_to_review');
    if (type.includes('review_to_done')) return rt('reactor.doorbell.meta.review_to_done');
    if (type.includes('done_to_archive')) return rt('reactor.doorbell.meta.done_to_archive');
    if (type.includes('review_to_active')) {
      return String(pl.reopen_reason || pl.reason || rt('reactor.doorbell.meta.review_to_active'));
    }
    if (type.includes('done_to_active')) {
      return String(pl.reason || rt('reactor.doorbell.meta.done_to_active'));
    }
    if (type.includes('task_dispatched')) {
      return String(pl.recipient || pl.to || rt('reactor.doorbell.meta.task_dispatched'));
    }
    if (type.includes('report_detected')) {
      return String(pl.report_id || pl.filename || rt('reactor.doorbell.meta.report_detected'));
    }
    if (type.includes('failure')) {
      const cat = pl.failure_category || pl.payload?.failure_category;
      const tc = pl.tool_call_count ?? pl.payload?.tool_call_count;
      const dur = pl.duration_ms ?? pl.payload?.duration_ms;
      const sdkMsg = pl.sdk_error_message || pl.payload?.sdk_error_message;
      const noDetail =
        pl.sdk_no_detail_note ||
        pl.payload?.sdk_no_detail_note ||
        cat === 'cursor_sdk_error_no_detail';
      const parts = [];
      if (cat) parts.push(String(cat));
      if (tc != null) parts.push('tools=' + tc);
      if (dur != null) parts.push(Math.round(Number(dur)) + 'ms');
      if (sdkMsg) parts.push(String(sdkMsg).slice(0, 60));
      else if (noDetail) parts.push('SDK 未暴露详细错误');
      const actions = pl.suggested_actions || pl.payload?.suggested_actions;
      if (Array.isArray(actions) && actions.length) {
        parts.push('建议: ' + actions.slice(0, 2).join(' / '));
      }
      if (parts.length) return parts.join(' · ');
      if (pl.detail) return String(pl.detail).slice(0, 80);
      return String(pl.failure_type || pl.reason || rt('reactor.doorbell.meta.failure_default'));
    }
    if (type.includes('session_started')) return rt('reactor.doorbell.meta.session_started');
    if (type.includes('session_completed')) return rt('reactor.doorbell.meta.session_completed');
    if (type.includes('session_cancelled')) return rt('reactor.doorbell.meta.session_cancelled');
    if (pl.message) return String(pl.message).slice(0, 80);
    if (pl.status) return String(pl.status);
    return type;
  }

  function doorbellEventTag(ev) {
    const type = ev.event_type || '';
    const pl = doorbellPayload(ev);
    const lc = lifecycleBucketTransition(type, pl);
    if (lc) return lc.to;
    const taskId = normalizeReplayTaskId(ev);
    if (taskId) {
      const task = _homeTasksCache.find((t) => (t.filename || '').includes(taskId));
      if (task) return normScope(task);
    }
    if (type.includes('session_started')) return 'active';
    if (type.includes('session_completed') || type.includes('session_ended')) return 'review';
    return 'inbox';
  }

  function buildRecentEvents(doorbell) {
    const filtered = doorbell.filter((ev) => !isDoorbellNoise(ev));
    const interesting = filtered.filter(
      (ev) => isLifecycleReplayEvent(ev) || isReplayAncillaryEvent(ev),
    );
    const pool = interesting.length ? interesting : filtered;
    const sorted = pool
      .slice()
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const seen = new Set();
    const merged = [];
    for (const ev of sorted) {
      const key = ev.id || `${ev.event_type}:${ev.ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(ev);
      if (merged.length >= 12) break;
    }
    return merged.map((ev) => ({
        time: formatClock(ev.at || ev.ts),
        title: doorbellEventTitle(ev),
        meta: doorbellEventMeta(ev),
        tag: doorbellEventTag(ev),
        tagClass: doorbellEventTag(ev),
        raw: ev,
      }));
  }

  function extractTaskIdFromPayload(pl) {
    if (!pl || typeof pl !== 'object') return '';
    const pick = (obj) => {
      const cand =
        obj.task_id || obj.root_task_id || obj.subject_id || obj.filename || obj.taskId || '';
      const m = String(cand).match(/TASK-\d{8}-\d{3,}/);
      return m ? m[0] : '';
    };
    const direct = pick(pl);
    if (direct) return direct;
    const inner = pl.payload;
    if (inner && typeof inner === 'object') return pick(inner);
    return '';
  }

  /** 归一化 task_id（门铃根字段 + payload + 短前缀）。 */
  function normalizeReplayTaskId(ev) {
    if (!ev) return '';
    const root = ev.task_id;
    if (root) {
      const m = String(root).match(/TASK-\d{8}-\d{3,}/);
      if (m) return m[0];
    }
    return extractTaskIdFromPayload(doorbellPayload(ev));
  }

  const REPLAY_SEAT_RE = /^(PM|DEV|QA|OPS|ADMIN|ME)(-\d+)?$/i;
  const REPLAY_ROLE_CODES = ['PM', 'DEV', 'QA', 'OPS'];
  const REPLAY_TIMELINE_CAP = 64;

  function isReplayAgentSeat(id) {
    return REPLAY_SEAT_RE.test(String(id || ''));
  }

  function isChatReplayTaskId(tid) {
    return String(tid || '').startsWith('CHAT-');
  }

  function defaultSeatForRole(roleCode) {
    const rc = String(roleCode || '').split('.')[0].toUpperCase();
    if (rc === 'ADMIN' || rc === 'SYSTEM') return rc;
    if (REPLAY_ROLE_CODES.includes(rc)) return `${rc}-01`;
    return rc || 'Agent';
  }

  function taskFilenameForReplayId(taskId) {
    if (!taskId) return '';
    const task = _homeTasksCache.find((t) => (t.filename || '').includes(taskId));
    return task?.filename || taskId;
  }

  function replayRouteLabel(taskId) {
    if (!taskId || isChatReplayTaskId(taskId)) return '';
    const route = callGlobal('taskRouteFromFn', taskFilenameForReplayId(taskId));
    if (!route) return '';
    return `${route.sender} → ${route.recipient}`;
  }

  /** 将 PM/DEV/QA/OPS 裸角色码统一为 *-01 席位（中心球与时间线一致）。 */
  function normalizeReplaySeatLabel(seatOrRole) {
    const s = String(seatOrRole || '').trim();
    if (!s) return s;
    const bareTeam = s.match(/^(PM|DEV|QA|OPS)$/i);
    if (bareTeam) return defaultSeatForRole(bareTeam[1]);
    if (isReplayAgentSeat(s)) return s;
    if (/^(ADMIN|ME|SYSTEM)$/i.test(s)) return defaultSeatForRole(s);
    return s;
  }

  function replaySeatLabel(ev, taskId) {
    const pl = doorbellPayload(ev);
    const type = ev.event_type || '';
    const direct = ev.agent_id || pl.agent_id || pl.actor || '';
    if (direct) {
      const normalized = normalizeReplaySeatLabel(direct);
      if (normalized !== direct || isReplayAgentSeat(direct)) return normalized;
    }
    if (taskId && !isChatReplayTaskId(taskId)) {
      const route = callGlobal('taskRouteFromFn', taskFilenameForReplayId(taskId));
      if (route) {
        if (isLifecycleReplayEvent(ev)) {
          if (type.includes('review_to_done') || type.includes('review_to_active')) {
            return defaultSeatForRole(pl.actor || route.sender);
          }
          if (type.includes('done_to_archive')) {
            return defaultSeatForRole(pl.actor || route.recipient);
          }
          return defaultSeatForRole(route.recipient);
        }
        if (/runtime\.session_|wake_agent\./.test(type)) {
          return defaultSeatForRole(route.recipient);
        }
        if (type.includes('report_detected')) {
          return defaultSeatForRole(pl.sender_role || route.sender);
        }
        if (type.includes('failure')) {
          return defaultSeatForRole(route.recipient);
        }
        return defaultSeatForRole(route.recipient);
      }
    }
    if (pl.sender_role) return defaultSeatForRole(pl.sender_role);
    if (pl.role) return defaultSeatForRole(pl.role);
    return direct || 'System';
  }

  function replayActionWithRoute(ev, taskId, baseMeta) {
    const meta = baseMeta || doorbellEventMeta(ev);
    const route = replayRouteLabel(taskId);
    if (!route) return meta;
    return `${meta} · ${route}`;
  }

  function reportIdFromPayload(pl) {
    const fn = pl?.filename || pl?.filepath || pl?.report_id || '';
    const m = String(fn).match(/REPORT-\d{8}-\d{3,}/);
    return m ? m[0] : '';
  }

  function senderRoleFromReportPl(pl, reportKey) {
    if (pl?.sender_role) return String(pl.sender_role).split('.')[0].toUpperCase();
    const full = pl?.filename || pl?.filepath || reportKey || '';
    const m = String(full).match(/REPORT-\d{8}-\d{3,}-([A-Z][A-Z0-9_-]*)-to-/i);
    return m ? m[1].split('.')[0].toUpperCase() : '';
  }

  function taskIdFromReportKey(reportKey, pl) {
    if (!reportKey) return '';
    const rep = (_homeReportsCache || []).find((r) => {
      const id = r.filename || r.report_id || '';
      return String(id).includes(reportKey);
    });
    if (rep) {
      let m = String(rep.task_id || '').match(/TASK-\d{8}-\d{3,}/);
      if (m) return m[0];
      for (const ref of rep.references || []) {
        m = String(ref).match(/TASK-\d{8}-\d{3,}/);
        if (m) return m[0];
      }
    }
    const role = senderRoleFromReportPl(pl, reportKey);
    for (const row of global.ledgerThreads || []) {
      const reportIds = (row.report_ids || []).map((r) => reportIdFromPayload({ filename: r }));
      if (!reportIds.includes(reportKey)) continue;
      for (const tid of row.task_ids || []) {
        const norm = normalizeLedgerTaskId(tid);
        if (!norm) continue;
        if (!role) return norm;
        const route = callGlobal('taskRouteFromFn', taskFilenameForReplayId(norm));
        const sender = route?.sender
          ? String(route.sender).split('.')[0].toUpperCase()
          : '';
        const rcpt = route?.recipient
          ? String(route.recipient).split('.')[0].toUpperCase()
          : '';
        if (sender === role || rcpt === role) return norm;
      }
    }
    return '';
  }

  function extractReportDetectedTaskId(ev) {
    const pl = doorbellPayload(ev);
    let cand = pl.task_id || pl.report_task_id || '';
    let m = String(cand).match(/TASK-\d{8}-\d{3,}/);
    if (m) return m[0];
    const reportKey = reportIdFromPayload(pl);
    if (reportKey) return taskIdFromReportKey(reportKey, pl);
    return '';
  }

  function reportDetectedInReplayThread(ev, taskIdSet) {
    const pl = doorbellPayload(ev);
    const reportKey = reportIdFromPayload(pl);
    if (!reportKey) return false;
    for (const row of global.ledgerThreads || []) {
      const reportIds = (row.report_ids || []).map((r) => reportIdFromPayload({ filename: r }));
      if (!reportIds.includes(reportKey)) continue;
      const rowTasks = (row.task_ids || []).map(normalizeLedgerTaskId).filter(Boolean);
      if (rowTasks.some((id) => taskIdSet.has(id))) return true;
    }
    return false;
  }

  function normalizeLedgerTaskId(raw) {
    const m = String(raw || '').match(/TASK-\d{8}-\d{3,}/);
    return m ? m[0] : '';
  }

  /** 从 lifecycle 种子 + parent 链 + ledger 线程展开整条协作链 task_id。 */
  function collectReplayTaskIds(seedIds) {
    const ids = new Set((seedIds || []).filter(Boolean));
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of _homeTasksCache || []) {
        const id = taskIdPrefix(t.filename || '');
        if (!id) continue;
        const parent = taskParentPrefix(t);
        if (parent && ids.has(parent) && !ids.has(id)) {
          ids.add(id);
          changed = true;
        }
      }
      for (const row of global.ledgerThreads || []) {
        const rowIds = (row.task_ids || [])
          .map((tid) => normalizeLedgerTaskId(tid))
          .filter(Boolean);
        if (!rowIds.some((id) => ids.has(id))) continue;
        for (const id of rowIds) {
          if (!ids.has(id)) {
            ids.add(id);
            changed = true;
          }
        }
      }
    }
    return ids;
  }

  function ancillaryBelongsToReplay(ev, taskIdSet) {
    if (!isReplayAncillaryEvent(ev)) return false;
    let tid = normalizeReplayTaskId(ev);
    if (!tid && (ev.event_type || '').includes('report_detected')) {
      tid = extractReportDetectedTaskId(ev);
      if (!tid && reportDetectedInReplayThread(ev, taskIdSet)) return true;
    }
    if (tid && !isChatReplayTaskId(tid) && taskIdSet.has(tid)) return true;
    const seat = ev.agent_id || doorbellPayload(ev).agent_id;
    if (isReplayAgentSeat(seat)) {
      const evTid = normalizeReplayTaskId(ev);
      if (evTid && !isChatReplayTaskId(evTid) && taskIdSet.has(evTid)) return true;
    }
    return false;
  }

  /** 标准 lifecycle 段（用于补全磁盘上缺失的中间步骤）。 */
  const REPLAY_STAGE_ORDER = ['inbox', 'active', 'review', 'done', 'archive'];
  const STANDARD_LIFECYCLE_TRANSITIONS = [
    { type: 'codeflowmu.lifecycle.inbox_to_active', from: 'inbox', to: 'active' },
    { type: 'codeflowmu.lifecycle.task_to_review', from: 'active', to: 'review' },
    { type: 'codeflowmu.lifecycle.review_to_done', from: 'review', to: 'done' },
    { type: 'codeflowmu.lifecycle.done_to_archive', from: 'done', to: 'archive' },
  ];

  function lifecycleTransitionKey(from, to) {
    return `${from}:${to}`;
  }

  function lifecycleTransitionFromEvent(ev) {
    const pl = doorbellPayload(ev);
    const lc = lifecycleBucketTransition(ev.event_type || '', pl);
    return lc ? lifecycleTransitionKey(lc.from, lc.to) : '';
  }

  function inferReplayTargetStage(taskId) {
    if (!taskId) return 'archive';
    const task = _homeTasksCache.find((t) => (t.filename || '').includes(taskId));
    if (task) return normScope(task);
    return 'archive';
  }

  function makeSyntheticLifecycleEvent(taskId, tr, ts, templateEv) {
    const pl = templateEv ? doorbellPayload(templateEv) : {};
    const synthEv = {
      event_type: tr.type,
      agent_id: templateEv?.agent_id || pl.actor || '',
      task_id: taskId,
      payload: {
        from_stage: tr.from,
        to_stage: tr.to,
        task_id: taskId,
        actor: pl.actor || templateEv?.agent_id,
        _inferred: true,
      },
    };
    return {
      id: `synthetic-${tr.from}-${tr.to}-${taskId}-${ts}`,
      ts,
      at:
        typeof callGlobal('safeIsoString', ts) === 'string'
          ? callGlobal('safeIsoString', ts)
          : callGlobal('toLocalIsoStringOffset', ts),
      event_type: tr.type,
      agent_id: replaySeatLabel(synthEv, taskId),
      task_id: taskId,
      payload: {
        from_stage: tr.from,
        to_stage: tr.to,
        task_id: taskId,
        actor: pl.actor || templateEv?.agent_id,
        _inferred: true,
      },
      _synthetic: true,
    };
  }

  /** 单任务 lifecycle 链缺段时，按任务当前舱位补全前置 transition。 */
  function expandLifecycleGapsForChain(chain, targetStage) {
    if (!chain.length) return chain;
    const taskId = normalizeReplayTaskId(chain[0]);
    if (!taskId || taskId === '__unknown__') return chain;

    const recorded = new Set();
    for (const ev of chain) {
      const key = lifecycleTransitionFromEvent(ev);
      if (key) recorded.add(key);
    }

    const targetIdx = REPLAY_STAGE_ORDER.indexOf(targetStage);
    if (targetIdx < 0) return chain;

    const anchorTs = chain[chain.length - 1]?.ts || Date.now();
    const synthetics = [];
    for (const tr of STANDARD_LIFECYCLE_TRANSITIONS) {
      const toIdx = REPLAY_STAGE_ORDER.indexOf(tr.to);
      if (toIdx < 0 || toIdx > targetIdx) continue;
      const key = lifecycleTransitionKey(tr.from, tr.to);
      if (recorded.has(key)) continue;
      const offsetMs = (targetIdx - toIdx + 1) * 1200;
      synthetics.push(makeSyntheticLifecycleEvent(taskId, tr, anchorTs - offsetMs, chain[chain.length - 1]));
      recorded.add(key);
    }

    if (!synthetics.length) return chain;
    return [...synthetics, ...chain].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  function expandAllLifecycleEvents(lifecycleEvents) {
    const byTask = new Map();
    for (const ev of lifecycleEvents) {
      const tid = normalizeReplayTaskId(ev) || '__unknown__';
      if (!byTask.has(tid)) byTask.set(tid, []);
      byTask.get(tid).push(ev);
    }

    const expanded = [];
    for (const [tid, chain] of byTask) {
      if (tid === '__unknown__') {
        expanded.push(...chain);
        continue;
      }
      const sorted = chain.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const target = inferReplayTargetStage(tid);
      expanded.push(...expandLifecycleGapsForChain(sorted, target));
    }
    return expanded.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  function mergeReplayTimeline(primary, ancillary, limit) {
    const cap = limit || REPLAY_TIMELINE_CAP;
    const seen = new Set();
    const merged = [];
    for (const ev of [...primary, ...ancillary].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
      const key = ev.id || `${ev.event_type}:${ev.ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(ev);
    }
    return merged.slice(-cap);
  }

  /**
   * 重播队列：展开每条 lifecycle 链（缺段则推断），并合并同任务辅助动作；
   * 始终输出多步时间线，避免仅「完成→归档」单步动画。
   */
  function buildReplayQueue(events) {
    const filtered = events.filter((ev) => !isDoorbellNoise(ev));
    let lifecycle = filtered
      .filter(isLifecycleReplayEvent)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));

    lifecycle = expandAllLifecycleEvents(lifecycle);

    if (lifecycle.length) {
      const anchorTid = normalizeReplayTaskId(lifecycle[lifecycle.length - 1]);
      const taskIdSet = collectReplayTaskIds(anchorTid ? [anchorTid] : []);
      const threadLifecycle = lifecycle.filter((ev) => {
        const tid = normalizeReplayTaskId(ev);
        return tid && taskIdSet.has(tid);
      });
      const ancillary = filtered.filter((ev) => ancillaryBelongsToReplay(ev, taskIdSet));
      return mergeReplayTimeline(threadLifecycle, ancillary, REPLAY_TIMELINE_CAP).map(
        doorbellToReplayStep,
      );
    }

    const ancillaryOnly = filtered
      .filter(isReplayAncillaryEvent)
      .filter((ev) => {
        const tid = normalizeReplayTaskId(ev);
        if (isChatReplayTaskId(tid)) return false;
        return isReplayAgentSeat(ev.agent_id) || tid;
      })
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .slice(-REPLAY_TIMELINE_CAP);

    return ancillaryOnly.map(doorbellToReplayStep);
  }

  /**
   * 门铃 lifecycle 事件 → 重播 from/to（优先于 taskId 当前桶早退）。
   * 含 review→done（完成舱）与 done→archive（归档舱）。
   */
  function lifecycleBucketTransition(type, payload) {
    const pl = payload || {};
    const fromStage = String(pl.from_stage || '').toLowerCase();
    const toStage = String(pl.to_stage || '').toLowerCase();
    const pick = (from, to, status) => ({ from, to, status: status || 'normal' });

    if (type.includes('inbox_to_active') || (fromStage === 'inbox' && toStage === 'active')) {
      return pick('inbox', 'active');
    }
    if (type.includes('task_to_review') || (fromStage === 'active' && toStage === 'review')) {
      return pick('active', 'review');
    }
    if (type.includes('review_to_done') || (fromStage === 'review' && toStage === 'done')) {
      return pick('review', 'done');
    }
    if (type.includes('done_to_archive') || (fromStage === 'done' && toStage === 'archive')) {
      return pick('done', 'archive');
    }
    if (type.includes('review_to_active') || (fromStage === 'review' && toStage === 'active')) {
      return pick('review', 'active', 'blocked');
    }
    if (type.includes('done_to_active') || (fromStage === 'done' && toStage === 'active')) {
      return pick('done', 'active', 'blocked');
    }
    if (type.includes('root_review_blocked')) {
      return pick('review', 'review', 'admin');
    }
    return null;
  }

  function syncPanelGlobals(tasks, reports, approvals, seqs) {
    global.tasks = tasks;
    global.reports = reports;
    global.approvals = approvals;
    if (global._doneSeqs && typeof global._doneSeqs.clear === 'function') {
      global._doneSeqs.clear();
      (seqs || []).forEach((s) => global._doneSeqs.add(s));
    } else {
      global._doneSeqs = new Set(seqs || []);
    }
  }

  function parseTasksApiResponse(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.tasks)) return payload.tasks;
    return [];
  }

  function parseReportsApiResponse(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.reports)) return payload.reports;
    return [];
  }

  /** 首屏核心：任务 / 报告(ledger) / 线程总线 / 门铃 / 审批 — 不拉 usage / PM planner。 */
  async function loadHomeReactorCoreData() {
    _loading = true;
    _loadError = null;
    setHomeStatus(_loading ? rt('reactor.toolbar.loadingEllipsis') : '');
    try {
      const [tasksRes, reportsRes, seqsRes, apprRes, dbRes, threadsRes] = await Promise.all([
        fetch('/api/v2/tasks?limit=500'),
        fetch('/api/v2/reports?limit=500'),
        fetch('/api/v2/reports/done-seqs'),
        fetch('/api/v2/approvals'),
        fetch('/api/v2/doorbell/system?limit=500'),
        fetch('/api/v2/ledger/threads'),
      ]);

      if (!tasksRes.ok) throw new Error(rt('reactor.load.tasksFailed', { status: tasksRes.status }));
      if (!reportsRes.ok) throw new Error(rt('reactor.load.reportsFailed', { status: reportsRes.status }));

      const tasks = parseTasksApiResponse(await tasksRes.json());
      const reports = parseReportsApiResponse(await reportsRes.json());
      const seqsPayload = seqsRes.ok ? await seqsRes.json() : { seqs: [] };
      const approvals = apprRes.ok ? await apprRes.json() : [];
      const doorbellRaw = dbRes.ok ? await dbRes.json() : [];
      const threadsPayload = threadsRes.ok ? await threadsRes.json() : { threads: [] };

      _homeTasksCache = tasks;
      _homeReportsCache = reports;
      global.ledgerThreads = Array.isArray(threadsPayload)
        ? threadsPayload
        : (Array.isArray(threadsPayload?.threads) ? threadsPayload.threads : []);
      const seqs = Array.isArray(seqsPayload?.seqs) ? seqsPayload.seqs : [];
      const appr = Array.isArray(approvals) ? approvals : [];
      _homeApprovalsCache = appr;

      syncPanelGlobals(_homeTasksCache, _homeReportsCache, appr, seqs);

      if (typeof global.autoSubmitPmPendingReviews === 'function') {
        try {
          const autoRes = await global.autoSubmitPmPendingReviews();
          if (autoRes && autoRes.submitted > 0) {
            _homeTasksCache = Array.isArray(global.tasks) ? global.tasks : _homeTasksCache;
            _homeReportsCache = Array.isArray(global.reports) ? global.reports : _homeReportsCache;
            _homeApprovalsCache = appr;
            syncPanelGlobals(_homeTasksCache, _homeReportsCache, appr, seqs);
            _bucketDefs = buildBucketDefs(_homeTasksCache, _homeReportsCache);
            _adminItems = buildAdminItems(_homeTasksCache, appr, global.ledgerThreads);
          }
        } catch (autoErr) {
          console.warn('home-reactor autoSubmitPmPendingReviews', autoErr);
        }
      }

      _doorbellEvents = parseDoorbellResponse(doorbellRaw);
      _bucketDefs = buildBucketDefs(_homeTasksCache, _homeReportsCache);
      _adminItems = buildAdminItems(_homeTasksCache, appr, global.ledgerThreads);
      _recentEvents = buildRecentEvents(_doorbellEvents);
      _lastRefreshAt = new Date();
      _loadError = null;
    } catch (err) {
      _loadError = err.message || String(err);
      _bucketDefs = BUCKET_KEYS.map((key) => {
        const m = bucketMeta(key);
        return {
          key,
          name: m.name,
          sub: m.sub,
          color: COLORS[key],
          stats: emptyStats(),
          orbs: [],
          taskCount: 0,
          reportCount: 0,
        };
      });
      _adminItems = [];
      _recentEvents = [];
    } finally {
      _loading = false;
    }
  }

  function setHomeStatus(msg) {
    const el = document.getElementById('homeStatus');
    const label = document.getElementById('homeStatusLabel');
    const card = document.getElementById('homeStatusCard');
    if (!el) return;
    card?.classList.remove('home-kpi-err');
    el.removeAttribute('title');
    if (_loadError) {
      if (label) label.textContent = rt('reactor.kpi.load');
      el.textContent = '⚠';
      el.title = _loadError;
      card?.classList.add('home-kpi-err');
      return;
    }
    if (msg) {
      if (label) label.textContent = rt('reactor.toolbar.status');
      el.textContent = msg;
      return;
    }
    if (_lastRefreshAt) {
      if (label) label.textContent = rt('reactor.toolbar.refreshed');
      el.textContent = formatClock(_lastRefreshAt);
      return;
    }
    if (label) label.textContent = rt('reactor.toolbar.status');
    el.textContent = '';
  }

  function renderKpis(st) {
    return `
<div class="home-kpi"><small>${esc(rt('reactor.kpi.total'))}</small><strong>${st.total}</strong></div>
<div class="home-kpi"><small>${esc(rt('reactor.kpi.tasks'))}</small><strong>${st.tasks}</strong></div>
<div class="home-kpi"><small>${esc(rt('reactor.kpi.reports'))}</small><strong>${st.reports}</strong></div>
<div class="home-kpi"><small>${esc(rt('reactor.kpi.normal'))}</small><strong>${st.normal}</strong></div>
<div class="home-kpi waiting"><small>${esc(rt('reactor.kpi.waiting'))}</small><strong>${st.waiting}</strong></div>
<div class="home-kpi blocked"><small>${esc(rt('reactor.kpi.blocked'))}</small><strong>${st.blocked}</strong></div>
<div class="home-kpi admin"><small>${esc(rt('reactor.kpi.admin'))}</small><strong>${st.admin}</strong></div>`;
  }

  function renderToolbarActions() {
    return `
<button type="button" class="home-kpi home-kpi-btn" id="homeRefreshBtn" title="${esc(rt('reactor.toolbar.refreshTitle'))}">
  <small>${esc(rt('reactor.toolbar.refresh'))}</small>
  <strong aria-hidden="true">↻</strong>
</button>
<button type="button" class="home-kpi home-kpi-btn primary" id="homeReplayBtn" title="${esc(rt('reactor.toolbar.replayTitle'))}">
  <small>${esc(rt('reactor.toolbar.replay'))}</small>
  <strong aria-hidden="true">▶</strong>
</button>
<button type="button" class="home-kpi home-kpi-btn" id="homeFullscreenBtn" title="${esc(rt('reactor.toolbar.fullscreenTitle'))}">
  <small>${esc(rt('reactor.toolbar.fullscreen'))}</small>
  <strong aria-hidden="true">⛶</strong>
</button>
<div class="home-kpi home-kpi-meta" id="homeStatusCard">
  <small id="homeStatusLabel">${esc(rt('reactor.toolbar.status'))}</small>
  <strong id="homeStatus">${esc(rt('reactor.toolbar.loadingEllipsis'))}</strong>
</div>`;
  }

  function vesselSvg(b) {
    const c = b.color;
    return `
<svg viewBox="0 0 230 190" aria-hidden="true">
  <defs>
    <linearGradient id="hr-glass-${b.key}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#213047" stop-opacity=".70"/>
      <stop offset=".45" stop-color="#0d1728" stop-opacity=".50"/>
      <stop offset="1" stop-color="#08111f" stop-opacity=".82"/>
    </linearGradient>
    <radialGradient id="hr-base-${b.key}" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="${c}" stop-opacity=".55"/>
      <stop offset=".72" stop-color="${c}" stop-opacity=".24"/>
      <stop offset="1" stop-color="${c}" stop-opacity=".02"/>
    </radialGradient>
    <filter id="hr-glow-${b.key}" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <ellipse cx="115" cy="56" rx="82" ry="30" fill="rgba(15,26,44,.72)" stroke="${c}" stroke-opacity=".72" stroke-width="1.5"/>
  <path d="M33 56 C38 88 40 121 47 141 C57 171 173 171 183 141 C190 121 192 88 197 56"
    fill="url(#hr-glass-${b.key})" stroke="${c}" stroke-opacity=".28"/>
  <ellipse cx="115" cy="142" rx="76" ry="27" fill="url(#hr-base-${b.key})" stroke="${c}" stroke-opacity=".55" filter="url(#hr-glow-${b.key})"/>
  <ellipse cx="115" cy="56" rx="82" ry="30" fill="none" stroke="rgba(255,255,255,.18)"/>
  <ellipse cx="115" cy="142" rx="76" ry="27" fill="none" stroke="rgba(255,255,255,.12)"/>
</svg>`;
  }

  function agentRoleFromId(agentId) {
    const id = String(agentId || '').toUpperCase();
    for (const slot of AGENT_THINK_SLOTS) {
      if (id === slot.role || id.startsWith(slot.role + '-') || id.includes(slot.role)) {
        return slot.role;
      }
    }
    const m = id.match(/^(PM|DEV|QA|OPS|EVAL)/);
    return m ? m[1] : '';
  }

  function bucketForAgent(agentId) {
    const role = agentRoleFromId(agentId);
    const slot = AGENT_THINK_SLOTS.find((s) => s.role === role);
    return slot ? slot.bucket : null;
  }

  function slotMetaForBucket(bucketKey) {
    return AGENT_THINK_SLOTS.find((s) => s.bucket === bucketKey) || null;
  }

  function applyThinkDemoArchive() {
    if ((_thinkByBucket.archive || []).length) return;
    try {
      if (localStorage.getItem('codeflowmu_home_think_demo') === '0') return;
    } catch (_) {}
    const base = Date.now() - 30 * 60 * 1000;
    const list = [];
    for (const row of THINK_DEMO_ARCHIVE) {
      const enriched = enrichThinkEntry('PM-01', row.kind, row.text, row.text);
      if (row.iconId) {
        enriched.govIcon = row.iconId;
        const meta = govIconMeta(row.iconId);
        enriched.govZone = meta.zone;
        enriched.govGlyph = meta.glyph;
        enriched.govCn = meta.cn;
        enriched.govLabel = meta.cn;
        enriched.text = formatGovCaption(row.iconId, row.kind, row.text, row.text);
      }
      if (row.status) enriched.govStatus = row.status;
      enriched.time = base + (row.gapMin || 0) * 60 * 1000;
      list.push(enriched);
    }
    list.sort((a, b) => b.time - a.time);
    _thinkByBucket.archive = list.slice(0, THINK_MAX_LINES);
  }

  function fmtThinkTime(ts) {
    const d = new Date(ts || Date.now());
    const locale = getPanelLang() === 'en' ? 'en-US' : 'zh-CN';
    return d.toLocaleTimeString(locale, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function classifyGovIcon(kind, raw) {
    const t = String(raw || '').toLowerCase();
    const toolMatch = String(raw || '').match(/⚙\s*(\w+)/i);
    const tool = toolMatch ? toolMatch[1].toLowerCase() : '';

    if (kind === 'think') {
      if (/用户|user\s+(wants|ask)|inquir|想知道|询问/.test(t)) return 'insight';
      if (/路由|route|分流|dispatcher|治理路由/.test(t)) return 'route';
      if (/权限|auth|recipient|合规|review|判定|分析|reason|无法|失败|error|冲突/.test(t)) {
        return 'reason';
      }
      if (/闭环|完成|resolve|summary|汇总|归档/.test(t)) return 'resolve';
      return 'reason';
    }

    if (tool === 'glob') return 'scan';
    if (tool === 'grep') return 'scan';
    if (tool === 'read') return 'fetch';
    if (tool === 'list_tasks' || tool === 'fcop_report' || tool === 'fcop_check') return 'observe';
    if (tool === 'write_report') return /success|✓|done/.test(t) ? 'verify' : 'resolve';
    if (tool === 'write_task') return 'deploy';
    if (tool === 'shell') {
      if (/sleep|start-sleep|wait/.test(t)) return 'retry';
      if (/utf-8|encoding|乱码|纠偏/.test(t)) return 'patch';
      if (/ledger_cli|resolve_report/.test(t)) return 'sync';
      if (/invoke-restmethod|governance|api|review-check|close-draft/.test(t)) return 'invoke';
      return 'invoke';
    }

    if (/glob|扫描|scan/.test(t)) return 'scan';
    if (/read|读取|fetch|获取|\.todo\.md/.test(t)) return 'fetch';
    if (/map|映射|依赖|skills|知识结构/.test(t)) return 'map';
    if (/ledger|inbox|observe|监控|pm\.todo/.test(t)) return 'observe';
    if (/judge|auth|鉴权|权限|review-check|合规|authorized/.test(t)) return 'judge';
    if (/route|路由|dispatcher|分流/.test(t)) return 'route';
    if (/insight|发现|潜在|优化/.test(t)) return 'insight';
    if (/invoke|api|governance|restmethod|review-check/.test(t)) return 'invoke';
    if (/retry|限流|throttl|等待|sleep/.test(t)) return 'retry';
    if (/patch|纠偏|encoding|utf-8|乱码/.test(t)) return 'patch';
    if (/sync|ledger_cli|resolve_report|对齐/.test(t)) return 'sync';
    if (/resolve|close-draft|闭环|完成/.test(t)) return 'resolve';
    if (/verify|success|确认|审计/.test(t)) return 'verify';
    if (/archive|归档|report-/.test(t)) return 'archive';
    if (/deploy|写任务/.test(t)) return 'deploy';

    return 'sync';
  }

  function detectGovStatus(raw, iconId) {
    const t = String(raw || '').toLowerCase();
    if (/block|权限受限|not recipient|拒绝|failed|✗|冲突|error/.test(t)) return 'blocked';
    if (/throttl|限流|start-sleep|retry-after|429/.test(t) || iconId === 'retry') return 'throttled';
    if (/sync|ledger_cli|resolve_report|对齐|encoding/.test(t)) return 'syncing';
    if (/success|✓|authorized|healthy/.test(t)) return 'healthy';
    return null;
  }

  function splitGovCaption(text) {
    const parts = String(text || '').split('·');
    if (parts.length < 2) return { cn: String(text || '').trim(), detail: '' };
    return { cn: parts[0].trim(), detail: parts.slice(1).join('·').trim() };
  }

  function formatGovCaption(iconId, kind, raw, shortText) {
    const meta = govIconMeta(iconId);
    const short = shortText || shortenThinkText(kind, raw);
    return `${meta.cn} · ${short}`;
  }

  function enrichThinkEntry(agent, kind, text, raw) {
    const k = kind === 'think' ? 'think' : 'tool';
    const iconId = classifyGovIcon(k, raw || text);
    const meta = govIconMeta(iconId);
    const status = detectGovStatus(raw || text, iconId);
    return {
      kind: k,
      agent: String(agent || ''),
      text: formatGovCaption(iconId, k, raw || text, text),
      raw: String(raw || text || ''),
      time: Date.now(),
      govIcon: iconId,
      govZone: meta.zone,
      govGlyph: meta.glyph,
      govLabel: meta.cn,
      govCn: meta.cn,
      govStatus: status,
    };
  }

  function pickAggregateGovStatus(lines) {
    const rank = { blocked: 4, throttled: 3, syncing: 2, healthy: 1 };
    let best = null;
    let score = 0;
    for (const ln of lines.slice(0, 14)) {
      const st = ln.govStatus;
      if (!st || !GOV_STATUS[st]) continue;
      const r = rank[st] || 0;
      if (r > score) {
        score = r;
        best = st;
      }
    }
    return best || (lines.length ? 'healthy' : null);
  }

  function buildGovChainSummary(lines) {
    const sorted = lines.slice().sort((a, b) => a.time - b.time).slice(-8);
    return sorted
      .map((ln) => ln.govGlyph || govIconMeta(ln.govIcon || classifyGovIcon(ln.kind, ln.raw)).glyph)
      .join(' → ');
  }

  function buildGovDisplayRows(lines, opts) {
    if (!lines.length) return [];
    const maxSteps = opts && opts.maxSteps != null ? opts.maxSteps : 12;
    const omitZones = !!(opts && opts.omitZones);
    const sorted = lines
      .slice()
      .sort((a, b) => a.time - b.time)
      .slice(-maxSteps);
    const rows = [];
    let lastZone = null;
    for (const ln of sorted) {
      const iconId = ln.govIcon || classifyGovIcon(ln.kind, ln.raw || ln.text);
      const meta = govIconMeta(iconId);
      const zone = ln.govZone || meta.zone;
      if (!omitZones && zone !== lastZone) {
        rows.push({ type: 'zone', zone, time: ln.time, text: govZoneTitle(zone) || zone });
        lastZone = zone;
      } else if (omitZones) {
        lastZone = zone;
      }
      const cap = splitGovCaption(ln.text);
      rows.push({
        type: 'step',
        kind: ln.kind,
        time: ln.time,
        iconId,
        zone,
        glyph: ln.govGlyph || meta.glyph,
        cn: meta.cn,
        label: meta.cn,
        agent: ln.roleLabel || agentRoleFromId(ln.agent) || String(ln.agent || '').split('-')[0] || '',
        detail: polishThinkDetail(
          cap.detail || shortenThinkText(ln.kind, ln.raw || ln.text),
          meta.cn
        ),
        status: ln.govStatus,
      });
    }
    return rows;
  }

  function renderGovThinkLineHtml(row) {
    if (row.type === 'zone') {
      const zoneGlyph =
        row.zone === 'perceive' ? '🔍' : row.zone === 'judge' ? '⚖️' : row.zone === 'drive' ? '⚡' : '🏁';
      return `<div class="home-v-think-zone zone-${esc(row.zone)}"><span class="hz-g">${zoneGlyph}</span><span class="hz-tag">${esc(row.text)}</span></div>`;
    }
    const st = row.status ? govStatusMeta(row.status) : null;
    const cls = `gov zone-${row.zone} ${row.kind === 'think' ? 'think' : 'tool'}${st ? ` st-${row.status}` : ''}`;
    const stHtml = st ? `<span class="hs" title="${esc(st.label)}">${st.glyph}</span>` : '';
    const roleHtml = row.agent
      ? `<span class="ha" title="${esc(rt('reactor.think.roleTitle'))}">${esc(row.agent)}</span>`
      : '';
    const detail = String(row.detail || '').trim();
    const detailHtml = detail
      ? `<div class="ht-detail"><span class="hd">${esc(detail)}</span></div>`
      : '';
    return (
      `<div class="home-v-think-line ${cls}">` +
      `<div class="ht-meta">${roleHtml}<span class="ht">${fmtThinkTime(row.time)}</span></div>` +
      `<div class="ht-action"><span class="hi" title="${esc(row.cn)}">${row.glyph}</span>` +
      `<span class="hx"><b class="hn">${esc(row.cn)}</b>${stHtml}</span></div>` +
      `${detailHtml}</div>`
    );
  }

  const THINK_TOOL_CN = {
    read: '读取文件',
    shell: '执行命令',
    grep: '检索代码',
    glob: '扫描目录',
    list_tasks: '列出任务',
    write_report: '写回执',
    write_task: '写任务',
    fcop_report: '协议汇报',
    fcop_check: '协议体检',
    write_review: '写评审',
    archive_task: '归档任务',
  };

  /** 英文残留 → 中文展示（归纳侧栏）；英文模式下仅做轻量清理 */
  function polishThinkDetail(text, cnLabel) {
    let s = String(text || '').trim();
    if (getPanelLang() === 'en') {
      s = s.replace(/⚙\s*(\w+)\s*→\s*/gi, (_, tool) => {
        const label = thinkToolLabel(tool);
        return label ? `${label}: ` : '';
      });
      s = s.replace(/⚙\s*(\w+)/gi, (_, tool) => thinkToolLabel(tool) || '');
      const cn = String(cnLabel || '').trim();
      if (cn) {
        const dup = new RegExp(`^${cn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[·：:]\\s*`, 'i');
        s = s.replace(dup, '').trim();
      }
      return s;
    }
    s = s.replace(/⚙\s*(\w+)\s*→\s*/gi, (_, tool) => {
      const key = String(tool || '').toLowerCase();
      const label = THINK_TOOL_CN[key];
      return label ? `${label}：` : '';
    });
    s = s.replace(/⚙\s*(\w+)/gi, (_, tool) => THINK_TOOL_CN[String(tool || '').toLowerCase()] || '');
    Object.keys(THINK_TOOL_CN).forEach((key) => {
      const cn = THINK_TOOL_CN[key];
      const re = new RegExp(`\\b${key}\\b`, 'gi');
      s = s.replace(re, cn);
    });
    s = s
      .replace(/\bInvoke-RestMethod\b/gi, 'REST 请求')
      .replace(/\bAuthorized\b/gi, '已授权')
      .replace(/\bSUCCESS\b/g, '成功')
      .replace(/\bStart-Sleep\b/gi, '等待')
      .replace(/\bTHROTTLED\b/gi, '限流')
      .replace(/\bHEALTHY\b/gi, '正常')
      .replace(/\bObserve\b/g, '感知')
      .replace(/\btool\s+/gi, '工具 ')
      .trim();
    const cn = String(cnLabel || '').trim();
    if (cn) {
      const dup = new RegExp(`^${cn}(文件)?\\s*[·：:]\\s*`, 'i');
      s = s.replace(dup, '').trim();
    }
    return s;
  }

  function normalizeThinkLine(ln) {
    if (!ln) return enrichThinkEntry('', 'think', '', '');
    if (ln.govIcon) {
      const meta = govIconMeta(ln.govIcon);
      ln.govCn = meta.cn;
      ln.govLabel = meta.cn;
      const raw = ln.raw || ln.text || '';
      const cap = splitGovCaption(raw);
      const fromText = splitGovCaption(ln.text);
      const detail = polishThinkDetail(
        cap.detail || fromText.detail || shortenThinkText(ln.kind, raw),
        meta.cn
      );
      ln.text = detail ? `${meta.cn} · ${detail}` : meta.cn;
      return ln;
    }
    return enrichThinkEntry(ln.agent, ln.kind, ln.text, ln.raw || ln.text);
  }

  function summarizeLatestLine(ln) {
    const iconId = ln.govIcon || classifyGovIcon(ln.kind, ln.raw || ln.text);
    const meta = govIconMeta(iconId);
    const cap = splitGovCaption(ln.text);
    const detail = polishThinkDetail(
      cap.detail || shortenThinkText(ln.kind, ln.raw || ln.text),
      meta.cn
    );
    return detail ? `${meta.cn} · ${detail}` : meta.cn;
  }

  /** 四路思考流按角色归纳（顶栏卡片） */
  function buildAgentThinkSummaries() {
    return AGENT_THINK_SLOTS.map((slot) => {
      const lines = (_thinkByBucket[slot.bucket] || []).map(normalizeThinkLine);
      const sorted = lines.slice().sort((a, b) => (b.time || 0) - (a.time || 0));
      const statusKey = pickAggregateGovStatus(sorted);
      const st = statusKey ? govStatusMeta(statusKey) : null;
      return {
        role: slot.role,
        label: slot.label,
        hint: thinkSlotHint(slot.role),
        bucket: slot.bucket,
        count: sorted.length,
        chain: sorted.length ? buildGovChainSummary(sorted) : '—',
        status: st,
        latest: sorted.length ? summarizeLatestLine(sorted[0]) : null,
      };
    });
  }

  function renderMergedSummaryHtml() {
    const sums = buildAgentThinkSummaries();
    return sums
      .map((s) => {
        const color = COLORS[s.bucket] || '#8ca1bd';
        const stTxt = s.status ? `${s.status.glyph} ${s.status.label}` : '—';
        const latest = s.latest || s.hint || rt('reactor.think.standby');
        const n = s.count ? rt('reactor.think.steps', { n: s.count }) : '—';
        return `<div class="home-think-sum-card" data-role="${esc(s.role)}">
      <div class="home-think-sum-hdr">
        <span class="home-think-sum-role" style="color:${color}">${esc(s.label)}</span>
        <span class="home-think-sum-st">${esc(stTxt)}</span>
        <span class="home-think-sum-n">${esc(n)}</span>
      </div>
      <div class="home-think-sum-chain" title="${esc(rt('reactor.think.chainTitleAttr'))}">${esc(s.chain)}</div>
      <div class="home-think-sum-latest" title="${esc(rt('reactor.think.latestTitle'))}">${esc(latest)}</div>
    </div>`;
      })
      .join('');
  }

  /** 四桶全量合并，按时间混排（单条滚动带） */
  function collectMergedThinkLines() {
    const out = [];
    for (const slot of AGENT_THINK_SLOTS) {
      for (const ln of (_thinkByBucket[slot.bucket] || []).map(normalizeThinkLine)) {
        ln.roleLabel = slot.label;
        ln.bucketKey = slot.bucket;
        out.push(ln);
      }
    }
    return out.sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 48);
  }

  function renderThinkRoleBandHtml(s) {
    const color = COLORS[s.bucket] || '#8ca1bd';
    const stTxt = s.status ? `${s.status.glyph} ${s.status.label}` : '—';
    const n = s.count ? rt('reactor.think.steps', { n: s.count }) : '—';
    const chain = s.chain && s.chain !== '—' ? s.chain : '';
    return `<div class="home-think-role-band" data-role="${esc(s.role)}">
      <span class="hrb-role" style="color:${color}">${esc(s.label)}</span>
      <span class="hrb-st">${esc(stTxt)}</span>
      <span class="hrb-n">${esc(n)}</span>
      ${chain ? `<span class="hrb-chain" title="${esc(rt('reactor.think.chainTitleAttr'))}">${esc(chain)}</span>` : ''}
    </div>`;
  }

  /** 单滚动区：按时间序播放，角色切换时插入归纳条 */
  function buildMergedScrollBody(lines) {
    let displayRows = buildGovDisplayRows(lines, { maxSteps: 36, omitZones: true });
    if (!displayRows.length) {
      displayRows = [
        {
          type: 'step',
          kind: 'think',
          time: Date.now(),
          iconId: 'observe',
          zone: 'perceive',
          glyph: '👁️',
          cn: rt('reactor.think.idleLabel'),
          label: rt('reactor.gov.icon.observe'),
          agent: '',
          detail: rt('reactor.think.idleDetail'),
          status: null,
        },
      ];
    }
    const sumsByRole = {};
    buildAgentThinkSummaries().forEach((s) => {
      sumsByRole[s.role] = s;
    });
    let lastRole = null;
    const parts = [];
    for (const row of displayRows) {
      if (row.type === 'step' && row.agent && row.agent !== lastRole) {
        const sum = sumsByRole[row.agent];
        if (sum) parts.push(renderThinkRoleBandHtml(sum));
        lastRole = row.agent;
      }
      parts.push(renderGovThinkLineHtml(row));
    }
    return parts.join('');
  }

  function renderMergedThinkFeed() {
    const scrollEl = document.getElementById('homeThinkScroll');
    if (!scrollEl) return;

    const lines = collectMergedThinkLines();
    const body = buildMergedScrollBody(lines);
    scrollEl.innerHTML = body + body;
    scrollEl.classList.remove('home-v-think-static');
    scrollEl.classList.add('home-v-think-animate');
  }

  /** @deprecated 四角已移除，兼容旧调用 */
  function renderThinkTape(_bucketKey) {
    renderMergedThinkFeed();
  }

  function shortenThinkText(kind, raw) {
    let t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t) return kind === 'think' ? rt('reactor.think.thinkingEllipsis') : rt('reactor.think.executingAction');
    if (kind === 'think') {
      return t.length > 96 ? `${t.slice(0, 96)}…` : t;
    }
    const toolMatch = t.match(/⚙\s*(\w+)/);
    const tool = toolMatch ? toolMatch[1] : '';
    const arrow = t.includes('→') ? t.split('→').slice(1).join('→').trim() : '';
    const path = arrow.replace(/^[^:]+:\s*/, '').slice(0, 80);
    const verb = tool ? thinkToolLabel(tool) : rt('reactor.tool.invoke');
    return path ? `${verb} · ${path}` : verb;
  }

  function normalizeHomeThinkText(text) {
    if (typeof global.normalizeThinkText === 'function') return global.normalizeThinkText(text);
    return String(text || '')
      .replace(/^\s*(?:💭|\[思\])\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function appendHomeThinkText(base, next) {
    if (typeof global.appendThinkText === 'function') return global.appendThinkText(base, next);
    const a = normalizeHomeThinkText(base);
    const b = normalizeHomeThinkText(next);
    if (!a) return b;
    if (!b) return a;
    if (a.endsWith(b)) return a;
    const glue = /[\s([{`"']$/.test(a) || /^[\s.,;:!?)}\]'"`]/.test(b) ? '' : ' ';
    return a + glue + b;
  }

  function trimHomeThinkText(text) {
    const s = String(text || '');
    return s.length > THINK_MAX_TEXT_CHARS ? `…${s.slice(-THINK_MAX_TEXT_CHARS)}` : s;
  }

  function pushThinkLine(bucketKey, entry) {
    if (!bucketKey || !CORNER_THINK_BUCKETS.includes(bucketKey)) return;
    const list = _thinkByBucket[bucketKey];
    const prev = list[0];
    if (
      entry.kind === 'think' &&
      prev &&
      prev.kind === 'think' &&
      String(prev.agent || '') === String(entry.agent || '') &&
      Date.now() - (prev.time || 0) <= THINK_MERGE_WINDOW_MS
    ) {
      const merged = trimHomeThinkText(appendHomeThinkText(prev.raw || prev.text, entry.raw || entry.text));
      const row = enrichThinkEntry(entry.agent, 'think', merged, merged);
      row.time = Date.now();
      list[0] = row;
      renderMergedThinkFeed();
      return;
    }
    list.unshift(entry);
    if (list.length > THINK_MAX_LINES) list.length = THINK_MAX_LINES;
    renderMergedThinkFeed();
  }

  function renderAllThinkTapes() {
    renderMergedThinkFeed();
  }

  function ingestThink(agentId, kind, text) {
    const bucketKey = bucketForAgent(agentId);
    if (!bucketKey) return;
    const k = kind === 'think' ? 'think' : kind === 'tool' ? 'tool' : 'text';
    const clean = k === 'think' ? normalizeHomeThinkText(text) : text;
    if (k === 'think' && !clean) return;
    pushThinkLine(bucketKey, enrichThinkEntry(agentId, k, clean, clean));
  }

  function seedThinkFromStored() {
    let entries = [];
    try {
      if (typeof global.getThinkEntries === 'function') entries = global.getThinkEntries() || [];
      else if (typeof global.tcEntries !== 'undefined') entries = global.tcEntries || [];
    } catch (_) {
      entries = [];
    }
    _thinkByBucket = { archive: [], active: [], done: [], review: [] };
    const sorted = entries.slice().sort((a, b) => (b.time || 0) - (a.time || 0));
    for (const e of sorted.slice(0, 80)) {
      const bucketKey = bucketForAgent(e.agent);
      if (!bucketKey) continue;
      const k = e.cls === 'think' ? 'think' : e.cls === 'tool' ? 'tool' : 'text';
      const list = _thinkByBucket[bucketKey];
      const row = enrichThinkEntry(e.agent, k, e.text, e.text);
      row.time = e.time || Date.now();
      list.push(row);
      if (list.length > THINK_MAX_LINES) list.pop();
    }
    applyThinkDemoArchive();
    renderAllThinkTapes();
  }

  /** FCoP/干净初始化后：清空四路桶并刷新侧栏合并流（不注入演示归档） */
  function resetThinkStream(opts) {
    const skipDemo = !opts || opts.skipDemo !== false;
    _thinkByBucket = { archive: [], active: [], done: [], review: [] };
    if (!skipDemo) applyThinkDemoArchive();
    renderAllThinkTapes();
    renderMergedThinkFeed();
  }

  function startThinkTicker() {
    if (_thinkRenderTimer) return;
    _thinkRenderTimer = setInterval(() => {
      if (!isHomeReactorPage()) return;
      renderAllThinkTapes();
    }, 4000);
  }

  function stopThinkTicker() {
    if (_thinkRenderTimer) {
      clearInterval(_thinkRenderTimer);
      _thinkRenderTimer = null;
    }
  }

  function renderVesselHtml(b) {
    const count = bucketCount(b);
    const s = b.stats;
    return `
<section class="home-vessel ${b.key}" data-bucket="${b.key}">
  ${vesselSvg(b)}
  <div class="home-v-title" style="color:${b.color}">${esc(b.name)}<small>${esc(b.sub)}</small></div>
  <div class="home-v-num">${count}</div>
  <div class="home-v-base-stats">
    <span><i style="background:var(--hr-normal)"></i>${s.normal}</span>
    <span><i style="background:var(--hr-waiting)"></i>${s.waiting}</span>
    <span><i style="background:var(--hr-blocked)"></i>${s.blocked}</span>
    <span><i style="background:var(--hr-admin)"></i>${s.admin}</span>
  </div>
</section>`;
  }

  function renderAdminPanel() {
    if (!_adminItems.length) {
      return `<div class="home-meta">${esc(rt('reactor.sidebar.adminEmpty'))}</div>`;
    }
    return _adminItems.map(
      (a) => `
<div class="home-item" data-fn="${esc(a.filename || '')}">
  <b>${esc(a.name)}</b><span class="home-tag ${a.tagClass}">${esc(a.tag)}</span>
  <div class="home-meta">${esc(a.reason)}<br/>${esc(a.meta)}</div>
</div>`
    ).join('');
  }

  function renderEventRow(e) {
    return `
<div class="home-event-row">
  <div class="home-event-time">${esc(e.time)}</div>
  <div><b>${esc(e.title)}</b><div class="home-meta">${esc(e.meta)}</div></div>
  <span class="home-tag ${e.tagClass || ''}">${esc(e.tag)}</span>
</div>`;
  }

  function wireBucketClicks() {
    _bucketEls = {};
    BUCKET_KEYS.forEach((key) => {
      const el = _reactorEl && _reactorEl.querySelector(`.home-vessel.${key}`);
      if (el) {
        _bucketEls[key] = el;
        el.onclick = () => homeSelectBucket(key);
      }
    });
    renderMergedThinkFeed();
  }

  function applyHomeDataToDOM() {
    const st = globalStats();
    const stats = document.getElementById('homeToolbarStats');
    if (stats) stats.innerHTML = renderKpis(st);

    _bucketDefs.forEach((b) => {
      const el = _bucketEls[b.key];
      if (!el) return;
      el.querySelector('.home-v-num').textContent = String(bucketCount(b));
      const statsEl = el.querySelector('.home-v-base-stats');
      if (statsEl) {
        const s = b.stats;
        statsEl.innerHTML = `
    <span><i style="background:var(--hr-normal)"></i>${s.normal}</span>
    <span><i style="background:var(--hr-waiting)"></i>${s.waiting}</span>
    <span><i style="background:var(--hr-blocked)"></i>${s.blocked}</span>
    <span><i style="background:var(--hr-admin)"></i>${s.admin}</span>`;
      }
    });

    const adminEl = document.querySelector('#page-home .admin-panel');
    if (adminEl) {
      const h3 = adminEl.querySelector('h3');
      adminEl.innerHTML = `${h3 ? h3.outerHTML : `<h3>${esc(rt('reactor.sidebar.adminTitle'))}</h3>`}${renderAdminPanel()}`;
    }

    renderMergedThinkFeed();

    if (_selectedBucket) homeSelectBucket(_selectedBucket);
    homeSeedOrbs();
    setHomeStatus('');
  }

  async function homeRefresh() {
    homeStopReplay();
    await loadHomeReactorCoreData();
    applyHomeDataToDOM();
  }

  function renderHomePage() {
    homeTeardown();
    const root = document.getElementById('page-home');
    if (!root) return;

    const st = { total: 0, tasks: 0, reports: 0, normal: 0, waiting: 0, blocked: 0, admin: 0 };

    root.innerHTML = `
<div class="home-root">
  <div class="home-layout">
    <div class="home-stage" id="homeStage">
      <div class="home-toolbar">
        <div class="home-toolbar-stats" id="homeToolbarStats">${renderKpis(st)}</div>
        <div class="home-toolbar-actions">${renderToolbarActions()}</div>
      </div>
      <div class="home-reactor-scaler">
        <div class="home-reactor" id="homeReactor">
          <div class="home-energy-line l-inbox"></div>
          <div class="home-energy-line l-active"></div>
          <div class="home-energy-line l-review"></div>
          <div class="home-energy-line l-done"></div>
          <div class="home-energy-line l-archive"></div>
          <div class="home-core" id="homeCore">
            <div class="home-core-waves" aria-hidden="true">
              <div class="home-core-waves-layer home-core-waves-a">
                <svg viewBox="0 0 400 120" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="homeWaveGradA" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stop-color="var(--core-wave-a-top, rgba(90,200,255,0.55))"/>
                      <stop offset="100%" stop-color="var(--core-wave-a-bottom, rgba(25,95,180,0.85))"/>
                    </linearGradient>
                  </defs>
                  <path fill="url(#homeWaveGradA)"
                    d="M0,52 C33,32 67,72 100,52 S167,32 200,52 S267,72 300,52 S367,32 400,52 L400,120 L0,120 Z"/>
                </svg>
              </div>
              <div class="home-core-waves-layer home-core-waves-b">
                <svg viewBox="0 0 400 120" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="homeWaveGradB" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stop-color="var(--core-wave-b-top, rgba(57,163,255,0.35))"/>
                      <stop offset="100%" stop-color="var(--core-wave-b-bottom, rgba(18,48,90,0.75))"/>
                    </linearGradient>
                  </defs>
                  <path fill="url(#homeWaveGradB)"
                    d="M0,62 C40,78 60,46 100,62 S160,78 200,62 S260,46 300,62 S360,78 400,62 L400,120 L0,120 Z"/>
                </svg>
              </div>
            </div>
            <div class="home-core-default">
              <h2>${esc(rt('reactor.core.title'))}</h2>
              <p class="home-core-sub">${rt('reactor.core.subHtml')}</p>
            </div>
            <div class="home-core-event" id="homeCoreEvent">
              <div class="home-core-role" id="homeRoleLine"></div>
              <div class="home-core-action" id="homeActionLine"></div>
            </div>
          </div>
          ${BUCKET_KEYS.map((key) => {
            const m = bucketMeta(key);
            return renderVesselHtml({
              key,
              name: m.name,
              sub: m.sub,
              color: COLORS[key],
              stats: emptyStats(),
            });
          }).join('')}
        </div>
      </div>
      <div class="home-rule">${rt('reactor.rule.flowHtml')}</div>
      <div class="home-legend">
        <span>${esc(rt('reactor.legend.normal'))}</span>
        <span class="waiting">${esc(rt('reactor.legend.waiting'))}</span>
        <span class="blocked">${esc(rt('reactor.legend.blocked'))}</span>
        <span class="admin">${esc(rt('reactor.legend.admin'))}</span>
        <span style="opacity:.8">${esc(rt('reactor.legend.orbHint'))}</span>
      </div>
    </div>
    <aside class="home-sidebar">
      <section class="home-panel admin-panel">
        <h3>${esc(rt('reactor.sidebar.adminTitle'))}</h3>
        <div class="home-meta">${esc(rt('reactor.sidebar.adminLoading'))}</div>
      </section>
      <section class="home-panel home-panel-think">
        <h3>${esc(rt('reactor.sidebar.thinkTitle'))}</h3>
        <p class="home-think-feed-hint">${esc(rt('reactor.sidebar.thinkHint'))}</p>
        <div class="home-think-feed" id="homeThinkFeed">
          <div class="home-think-feed-track">
            <div class="home-v-think-scroll home-v-think-animate" id="homeThinkScroll"></div>
          </div>
        </div>
      </section>
      <section class="home-panel">
        <h3>${esc(rt('reactor.sidebar.bucketDetailTitle'))}</h3>
        <div class="home-explain" id="homeBucketInfo">${esc(rt('reactor.sidebar.bucketPlaceholder'))}</div>
      </section>
    </aside>
  </div>
</div>`;

    _reactorEl = document.getElementById('homeReactor');
    wireBucketClicks();
    applyHomeReactorI18n();
    homeWatchReactorResize();
    const core = document.getElementById('homeCore');
    applyCoreBucketTheme(core, _selectedBucket || DEFAULT_CORE_BUCKET);

    document.getElementById('homeRefreshBtn')?.addEventListener('click', () => { homeRefresh(); });
    document.getElementById('homeReplayBtn')?.addEventListener('click', () => { homeReplayRecent(); });
    document.getElementById('homeFullscreenBtn')?.addEventListener('click', () => { toggleBigScreenFullscreen(); });

    requestAnimationFrame(() => {
      homeStartJiggle();
      seedThinkFromStored();
      startThinkTicker();
      homeRefresh();
    });
  }

  function homeTeardown() {
    exitBigScreenFullscreen();
    homeStopReplay();
    stopThinkTicker();
    if (_jiggleTimer) { clearInterval(_jiggleTimer); _jiggleTimer = null; }
    if (_coreTimer) { clearTimeout(_coreTimer); _coreTimer = null; }
    if (_resizeObs) { _resizeObs.disconnect(); _resizeObs = null; }
    if (_resizeRaf) { cancelAnimationFrame(_resizeRaf); _resizeRaf = null; }
    _bucketEls = {};
    _cornerThinkEls = Object.create(null);
    _reactorEl = null;
    _selectedBucket = null;
    _thinkByBucket = { archive: [], active: [], done: [], review: [] };
  }

  function orbPixelSize(orb) {
    if (!orb) return 0;
    const w = orb.getBoundingClientRect().width;
    if (w > 0) return w;
    const rr = _reactorEl ? _reactorEl.getBoundingClientRect().width : DESIGN_W;
    const scale = rr / DESIGN_W;
    return orb.classList.contains('task') ? 24 * scale : 10 * scale;
  }

  function homeRelayoutOrbs() {
    if (!_reactorEl) return;
    _reactorEl.querySelectorAll('.home-orb:not(.flying)').forEach((orb) => {
      const key = orb.dataset.bucket;
      if (key && _bucketEls[key]) placeOrbInBucket(orb, key);
    });
  }

  function homeSyncStageLayout() {
    const stage = document.getElementById('homeStage');
    const pageHome = document.getElementById('page-home');
    if (!stage || !pageHome) return;
    const stageRect = stage.getBoundingClientRect();
    const gap = 10;
    const toolbar = stage.querySelector('.home-toolbar');
    const rule = stage.querySelector('.home-rule');
    const legend = stage.querySelector('.home-legend');
    let toolbarReserve = 88;
    if (toolbar) {
      toolbarReserve = Math.ceil(toolbar.getBoundingClientRect().bottom - stageRect.top + gap);
    }
    let footerTop = stageRect.bottom;
    if (legend) footerTop = Math.min(footerTop, legend.getBoundingClientRect().top);
    if (rule) footerTop = Math.min(footerTop, rule.getBoundingClientRect().top);
    const footerReserve = Math.ceil(stageRect.bottom - footerTop + gap);
    const toolbarPx = `${toolbarReserve}px`;
    const footerPx = `${footerReserve}px`;
    stage.style.setProperty('--home-toolbar-reserve', toolbarPx);
    stage.style.setProperty('--home-footer-reserve', footerPx);
    pageHome.style.setProperty('--home-toolbar-reserve', toolbarPx);
    pageHome.style.setProperty('--home-footer-reserve', footerPx);
  }

  function homeWatchReactorResize() {
    if (_resizeObs) { _resizeObs.disconnect(); _resizeObs = null; }
    const stage = document.getElementById('homeStage');
    const scaler = document.querySelector('.home-reactor-scaler');
    if (!scaler || typeof ResizeObserver === 'undefined') return;
    const onResize = () => {
      if (_resizeRaf) cancelAnimationFrame(_resizeRaf);
      _resizeRaf = requestAnimationFrame(() => {
        _resizeRaf = null;
        homeSyncStageLayout();
        homeRelayoutOrbs();
      });
    };
    _resizeObs = new ResizeObserver(onResize);
    _resizeObs.observe(scaler);
    if (stage) _resizeObs.observe(stage);
    const toolbar = stage?.querySelector('.home-toolbar');
    const rule = stage?.querySelector('.home-rule');
    const legend = stage?.querySelector('.home-legend');
    if (toolbar) _resizeObs.observe(toolbar);
    if (rule) _resizeObs.observe(rule);
    if (legend) _resizeObs.observe(legend);
    homeSyncStageLayout();
  }

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function vesselRect(bucketKey) {
    const vessel = _bucketEls[bucketKey];
    if (!vessel || !_reactorEl) {
      const rr = _reactorEl ? _reactorEl.getBoundingClientRect() : { width: DESIGN_W, height: DESIGN_H };
      return {
        left: 0,
        top: 0,
        width: rr.width * (230 / DESIGN_W),
        height: rr.height * (190 / DESIGN_H),
      };
    }
    const r = vessel.getBoundingClientRect();
    const rr = _reactorEl.getBoundingClientRect();
    return { left: r.left - rr.left, top: r.top - rr.top, width: r.width, height: r.height };
  }

  function makeOrb(status, type) {
    const el = document.createElement('div');
    const health = status === 'admin' ? 'admin' : status;
    el.className = `home-orb ${health} ${type}`;
    return el;
  }

  function placeOrbInBucket(orb, bucketKey) {
    const r = vesselRect(bucketKey);
    const size = orbPixelSize(orb);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height * ORB_CY_RATIO;
    const rx = r.width * ORB_RX_RATIO;
    const ry = r.height * ORB_RY_RATIO;
    const angle = rand(0, Math.PI * 2);
    const radius = Math.sqrt(Math.random());
    orb.dataset.bucket = bucketKey;
    orb.style.left = `${cx + Math.cos(angle) * rx * radius - size / 2}px`;
    orb.style.top = `${cy + Math.sin(angle) * ry * radius - size / 2}px`;
  }

  function homeSeedOrbs() {
    if (!_reactorEl) return;
    _reactorEl.querySelectorAll('.home-orb').forEach((o) => o.remove());
    _bucketDefs.forEach((b) => {
      const picked = pickRepresentativeOrbs(b.orbs, b.key);
      picked.forEach((o) => {
        const orb = makeOrb(o.health, o.type);
        if (o.file && o.file.filename) orb.dataset.fn = o.file.filename;
        orb.title = displayTitle(o.file);
        orb.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const fn = orb.dataset.fn;
          if (!fn) return;
          if (typeof global.openDetail === 'function') {
            global.openDetail({ filename: fn }, o.type === 'task' ? 'T' : 'R');
          }
        });
        _reactorEl.appendChild(orb);
        placeOrbInBucket(orb, b.key);
      });
    });
  }

  function homeStartJiggle() {
    if (_jiggleTimer) clearInterval(_jiggleTimer);
    _jiggleTimer = setInterval(() => {
      if (!_reactorEl) return;
      _reactorEl.querySelectorAll('.home-orb.admin:not(.flying)').forEach((o) => {
        o.style.transform = `translate(${rand(-2.5, 2.5)}px,${rand(-2, 2)}px)`;
      });
      _reactorEl.querySelectorAll('.home-orb:not(.admin):not(.need_admin):not(.flying)').forEach((o) => {
        o.style.transform = `translate(${rand(-2, 2)}px,${rand(-1.5, 1.5)}px)`;
      });
    }, 1100);
  }

  function centerOf(el) {
    const a = el.getBoundingClientRect();
    const r = _reactorEl.getBoundingClientRect();
    return { x: a.left - r.left + a.width / 2, y: a.top - r.top + a.height / 2 };
  }

  function bucketCenter(key) {
    return centerOf(_bucketEls[key]);
  }

  function coreCenter() {
    return centerOf(document.getElementById('homeCore'));
  }

  function addTrail(x1, y1, x2, y2, color) {
    const trail = document.createElement('div');
    trail.className = 'home-trail';
    const hex = color || COLORS.inbox;
    trail.style.background = `linear-gradient(90deg, ${rgbaHex(hex, 0)}, ${rgbaHex(hex, 0.78)}, ${rgbaHex(hex, 0)})`;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    trail.style.left = `${x1}px`;
    trail.style.top = `${y1}px`;
    trail.style.width = `${len}px`;
    trail.style.transform = `rotate(${angle}deg)`;
    _reactorEl.appendChild(trail);
    setTimeout(() => trail.remove(), 1000);
  }

  function fly(from, to, status, type) {
    if (!_reactorEl) return;
    if (from !== 'core' && !_bucketEls[from]) return;
    if (to !== 'core' && !_bucketEls[to]) return;
    const p1 = from === 'core' ? coreCenter() : bucketCenter(from);
    const p2 = to === 'core' ? coreCenter() : bucketCenter(to);
    const orb = makeOrb(status, type);
    orb.classList.add('flying');
    _reactorEl.appendChild(orb);
    const size = orbPixelSize(orb);
    orb.style.left = `${p1.x - size / 2}px`;
    orb.style.top = `${p1.y - size / 2}px`;
    const trailColor = to !== 'core' && COLORS[to] ? COLORS[to] : (from !== 'core' && COLORS[from] ? COLORS[from] : COLORS.inbox);
    addTrail(p1.x, p1.y, p2.x, p2.y, trailColor);
    requestAnimationFrame(() => {
      orb.style.left = `${p2.x - size / 2}px`;
      orb.style.top = `${p2.y - size / 2}px`;
      orb.style.transform = 'scale(1.08)';
    });
    setTimeout(() => {
      orb.classList.remove('flying');
      const dest = to === 'core' ? 'inbox' : to;
      if (_bucketEls[dest]) placeOrbInBucket(orb, dest);
      else orb.remove();
    }, 980);
  }

  function showCoreEvent(roleHtml, actionHtml, bucketKey) {
    const core = document.getElementById('homeCore');
    const roleLine = document.getElementById('homeRoleLine');
    const actionLine = document.getElementById('homeActionLine');
    if (!core) return;
    applyCoreBucketTheme(core, resolveEventBucketKey(bucketKey));
    if (roleLine) roleLine.innerHTML = roleHtml;
    if (actionLine) actionLine.innerHTML = actionHtml;
    core.classList.add('event');
    if (_coreTimer) clearTimeout(_coreTimer);
    _coreTimer = setTimeout(() => {
      core.classList.remove('event');
      applyCoreBucketTheme(core, _selectedBucket || DEFAULT_CORE_BUCKET);
    }, 1700);
  }

  function doorbellToReplayStep(ev) {
    const type = ev.event_type || '';
    const pl = doorbellPayload(ev);
    const taskId =
      normalizeReplayTaskId(ev) ||
      extractReportDetectedTaskId(ev) ||
      extractTaskIdFromPayload(pl);
    let from = 'core';
    let to = 'inbox';
    let status = 'normal';
    let typeOrb = 'task';
    let role = replaySeatLabel(ev, taskId);
    const actionMeta = replayActionWithRoute(ev, taskId, doorbellEventMeta(ev));

    const lc = lifecycleBucketTransition(type, pl);
    if (lc) {
      from = lc.from;
      to = lc.to;
      status = lc.status;
      role = replaySeatLabel(ev, taskId);
      return {
        role,
        action: actionMeta,
        from,
        to,
        status,
        type: typeOrb,
        tag: to,
        time: formatClock(ev.at || ev.ts),
        title: doorbellEventTitle(ev),
      };
    }

    if (taskId && !isLifecycleReplayEvent(ev)) {
      const task = _homeTasksCache.find((t) => (t.filename || '').includes(taskId));
      if (task) {
        to = normScope(task);
        from = PREV_BUCKET[to] || 'core';
        status = taskHealth(task);
        role = replaySeatLabel(ev, taskId);
        return {
          role,
          action: actionMeta,
          from,
          to,
          status,
          type: typeOrb,
          tag: to,
          time: formatClock(ev.at || ev.ts),
          title: doorbellEventTitle(ev),
        };
      }
    }

    if (type.includes('session_started')) {
      from = 'inbox';
      to = 'active';
    } else if (type.includes('session_completed') || type.includes('session_ended')) {
      from = 'active';
      to = 'review';
    } else     if (type.includes('session_cancelled')) {
      from = 'active';
      to = 'inbox';
      status = 'blocked';
    } else if (type.includes('task_dispatched')) {
      from = 'core';
      to = 'inbox';
    } else if (type.includes('report_detected')) {
      from = 'active';
      to = 'review';
    } else if (type.includes('failure')) {
      from = 'active';
      to = 'active';
      status = 'blocked';
    } else if (type.includes('heartbeat')) {
      from = 'core';
      to = 'core';
    }

    return {
      role: replaySeatLabel(ev, taskId),
      action: actionMeta,
      from,
      to,
      status,
      type: typeOrb,
      tag: doorbellEventTag(ev),
      time: formatClock(ev.at || ev.ts),
      title: doorbellEventTitle(ev),
    };
  }

  function prependEventRow(_ev) {
    /* 重播仅驱动中央核心动画；侧栏已改为合并思考流 */
  }

  function homeSelectBucket(key) {
    _selectedBucket = key;
    Object.values(_bucketEls).forEach((v) => v.classList.remove('selected'));
    if (_bucketEls[key]) _bucketEls[key].classList.add('selected');
    const core = document.getElementById('homeCore');
    if (core && !core.classList.contains('event')) {
      applyCoreBucketTheme(core, key);
    }
    const b = _bucketDefs.find((x) => x.key === key);
    const info = document.getElementById('homeBucketInfo');
    if (!b || !info) return;
    info.innerHTML = renderBucketInfoHtml(b);
  }

  function homeStopReplay() {
    if (_replayTimer) {
      clearTimeout(_replayTimer);
      _replayTimer = null;
    }
    _replayIndex = 0;
    _replayQueue = [];
  }

  function homeReplayRecent() {
    homeStopReplay();
    if (!_doorbellEvents.length) {
      setHomeStatus(rt('reactor.replay.noEvents'));
      return;
    }
    _replayQueue = buildReplayQueue(_doorbellEvents);
    _replayIndex = 0;
    setHomeStatus(rt('reactor.replay.playing'));
    const step = () => {
      if (_replayIndex >= _replayQueue.length) {
        setHomeStatus('');
        homeStopReplay();
        return;
      }
      const ev = _replayQueue[_replayIndex];
      _replayIndex += 1;
      showCoreEvent(ev.role, ev.action, ev.to);
      if (ev.from !== ev.to && !(ev.from === 'core' && ev.to === 'core')) {
        fly(ev.from, ev.to, ev.status, ev.type);
      }
      prependEventRow(ev);
      if (ev.to !== 'core') homeSelectBucket(ev.to);
      _replayTimer = setTimeout(step, 1500);
    };
    step();
  }

  global.renderHomePage = renderHomePage;
  global.applyHomeReactorI18n = applyHomeReactorI18n;
  global.homeSelectBucket = homeSelectBucket;
  global.homeRefresh = homeRefresh;
  global.homeReplayRecent = homeReplayRecent;
  global.homeStopReplay = homeStopReplay;
  global.homeTeardown = homeTeardown;
  global.enterBigScreenFullscreen = enterBigScreenFullscreen;
  global.exitBigScreenFullscreen = exitBigScreenFullscreen;
  global.toggleBigScreenFullscreen = toggleBigScreenFullscreen;
  global.HomeReactorThink = {
    ingest: ingestThink,
    seed: seedThinkFromStored,
    reset: resetThinkStream,
    renderAll: renderMergedThinkFeed,
    renderMerged: renderMergedThinkFeed,
  };
  /** 报告/任务归档舱投影（与首页 reactor 一致，供报告页 archive 过滤） */
  global.panelRebuildScopeProjection = rebuildThreadScopeProjection;
  global.panelNormScope = normScope;
})(typeof window !== 'undefined' ? window : globalThis);
