/**
 * Runtime Alert Center — 只读轮询 /api/v2/runtime/health 与 /api/v2/runtime/alerts
 * 不触发 wake / ReportGate / lifecycle（设计 2026-06-05）
 */
(function (global) {
  'use strict';

  const POLL_MS = 5000;
  const SEV_STYLE = {
    P0: { color: '#f87171', bg: 'rgba(239,68,68,.12)', border: 'rgba(239,68,68,.35)' },
    P1: { color: '#fbbf24', bg: 'rgba(251,191,36,.1)', border: 'rgba(251,191,36,.3)' },
    P2: { color: '#93c5fd', bg: 'rgba(59,130,246,.08)', border: 'rgba(59,130,246,.25)' },
    P3: { color: 'var(--text3)', bg: 'var(--card2)', border: 'var(--bd2)' },
  };

  let timer = null;
  let categoryLabels = {};
  let currentBannerKey = '';

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function isDashboardVisible() {
    const page = typeof curPage !== 'undefined' ? curPage : '';
    const dash = document.getElementById('page-dashboard');
    if (page === 'dashboard') return true;
    if (dash && dash.style.display !== 'none') return true;
    return false;
  }

  function applyBanner(banner) {
    const el = document.getElementById('dash-fault-banner');
    const msg = document.getElementById('dash-fault-msg');
    const tm = document.getElementById('dash-fault-time');
    if (!el || !msg) return;
    if (!banner) {
      currentBannerKey = '';
      el.style.display = 'none';
      return;
    }
    currentBannerKey = banner.alert_key || '';
    const sev = banner.severity || 'P1';
    const st = SEV_STYLE[sev] || SEV_STYLE.P1;
    el.style.display = 'flex';
    el.style.background = st.bg;
    el.style.borderColor = st.border;
    msg.style.color = st.color;
    msg.textContent = banner.message || banner.title || '';
    if (tm) {
      tm.textContent = banner.last_seen
        ? new Date(banner.last_seen).toLocaleTimeString(
            typeof _localeTag === 'function' ? _localeTag() : undefined,
            { hour12: false },
          )
        : '';
    }
  }

  async function resolveAlert(alertKey) {
    if (!alertKey) return;
    const res = await fetch('/api/v2/runtime/alerts/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alert_key: alertKey }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await pollOnce();
  }

  async function resolveBanner() {
    try {
      if (currentBannerKey) await resolveAlert(currentBannerKey);
      else {
        const el = document.getElementById('dash-fault-banner');
        if (el) el.style.display = 'none';
      }
    } catch (_) {
      if (typeof showToast === 'function') showToast('确认告警失败', '#ef4444');
    }
  }

  function openLogCenter() {
    if (typeof global.openLogCenterForSession === 'function') {
      global.openLogCenterForSession({ tab: 'runtime-alerts', returnPage: 'dashboard' });
      return;
    }
    if (typeof global.navTo === 'function') global.navTo('errorlog');
  }

  function showP0Toasts(items) {
    if (!Array.isArray(items) || !items.length) return;
    if (typeof showToast !== 'function') return;
    for (const t of items) {
      const title = t.title || t.code || 'P0';
      const body = (t.message || '').slice(0, 120);
      showToast(`${title}${body ? ' · ' + body : ''}`, '#ef4444', 6000);
    }
  }

  function renderCenter(data) {
    const root = document.getElementById('runtime-alert-center-body');
    if (!root) return;
    const grouped = data.grouped_by_category || {};
    const labels = data.category_labels || categoryLabels || {};
    const cats = Object.keys(grouped);
    if (!cats.length) {
      root.innerHTML =
        '<div style="font-size:13px;color:var(--text3);text-align:center;padding:8px 0">暂无活跃告警</div>';
      return;
    }
    cats.sort();
    let html = '';
    for (const cat of cats) {
      const rows = grouped[cat] || [];
      const active = rows.filter((a) => a.status !== 'resolved');
      if (!active.length) continue;
      const label = labels[cat] || cat;
      html += `<div class="rac-cat" style="margin-bottom:10px">
        <div style="font-size:13px;font-weight:600;color:var(--text2);margin-bottom:4px">${esc(label)} <span style="color:var(--text3);font-weight:400">(${active.length})</span></div>`;
      for (const a of active.slice(0, 8)) {
        const st = SEV_STYLE[a.severity] || SEV_STYLE.P2;
        const cnt = a.count > 1 ? ` ×${a.count}` : '';
        const agent = a.affected_agent ? ` · ${esc(a.affected_agent)}` : '';
        const task = a.affected_task ? ` · ${esc(a.affected_task)}` : '';
        html += `<div class="rac-row" style="font-size:12px;padding:6px 8px;margin-bottom:4px;border-radius:6px;border:1px solid ${st.border};background:${st.bg}">
          <div style="color:${st.color};font-weight:600">${esc(a.severity)} ${esc(a.code)}${cnt}</div>
          <div style="color:var(--text2);margin-top:2px;line-height:1.35">${esc(a.title || a.message)}${agent}${task}</div>
          ${a.current_action ? `<div style="color:var(--text3);margin-top:2px;font-size:11px">${esc(a.current_action)}</div>` : ''}
        </div>`;
      }
      if (active.length > 8) {
        html += `<div style="font-size:11px;color:var(--text3)">… 另有 ${active.length - 8} 条</div>`;
      }
      html += '</div>';
    }
    root.innerHTML = html || '<div style="font-size:13px;color:var(--text3)">暂无活跃告警</div>';
  }

  async function pollOnce() {
    if (!isDashboardVisible()) return;
    try {
      const [healthRes, alertsRes] = await Promise.all([
        fetch('/api/v2/runtime/health'),
        fetch('/api/v2/runtime/alerts?status=active&group_by=category'),
      ]);
      if (healthRes.ok) {
        const h = await healthRes.json();
        if (h.category_labels) categoryLabels = h.category_labels;
        applyBanner(h.banner);
        showP0Toasts(h.p0_toast);
        const badge = document.getElementById('runtime-alert-overall');
        if (badge) {
          const st = h.overall_status || 'ok';
          badge.textContent = st === 'ok' ? '正常' : st === 'critical' ? '严重' : '降级';
          badge.style.color =
            st === 'critical' ? '#f87171' : st === 'degraded' ? '#fbbf24' : '#6ee7b7';
        }
      }
      if (alertsRes.ok) {
        const a = await alertsRes.json();
        if (a.category_labels) categoryLabels = a.category_labels;
        renderCenter(a);
      }
    } catch {
      /* 只读轮询，失败静默 */
    }
  }

  function start() {
    if (timer) return;
    pollOnce();
    timer = setInterval(pollOnce, POLL_MS);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  global.RuntimeAlertCenter = { start, stop, pollOnce, resolveAlert, resolveBanner, openLogCenter };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (isDashboardVisible()) start();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (isDashboardVisible()) start();
    });
  } else if (isDashboardVisible()) {
    start();
  }

  const origNav = global.navTo;
  if (typeof origNav === 'function') {
    global.navTo = function (page, ...rest) {
      const r = origNav.apply(this, [page, ...rest]);
      if (page === 'dashboard') start();
      else stop();
      return r;
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
