/**
 * 团队配置 · PM技能与审批规则策略 (Sprint-H7)
 * API: /api/v2/pm/skills/enabled, /api/v2/pm/governance/cycle/recent
 *      /api/v2/team/review-decision-policy
 */
(function (global) {
  'use strict';

  let _pmSkills = null;
  let _pmDecisions = null;
  let _policy = null;
  let _policyLoadError = '';
  let _loading = false;
  let _loadInflight = null;
  const TAP_FETCH_TIMEOUT_MS = 15000;

  function fetchWithTimeout(url, opts, timeoutMs) {
    timeoutMs = timeoutMs || TAP_FETCH_TIMEOUT_MS;
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
  /** 审批规则折叠态：teamRules 默认折叠 */
  const _tapFoldState = {
    invariants: true,
    teamRules: false
  };

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderPmSkillsPanel() {
    if (!_pmSkills || !Array.isArray(_pmSkills.skills) || !_pmSkills.skills.length) {
      return '<div class="home-meta">暂无 PM 内置技能数据</div>';
    }
    return _pmSkills.skills
      .map((s) => {
        const id = esc(s.skill_id || '');
        const name = esc(s.display_name || s.skill_id || '');
        const desc = esc(s.description || '');
        return `<div class="home-pm-skill"><strong>${name}</strong><span class="home-pm-skill-id">${id}</span><p>${desc}</p></div>`;
      })
      .join('');
  }

  function renderPmDecisionsPanel() {
    const rows =
      _pmDecisions && Array.isArray(_pmDecisions.decisions) ? _pmDecisions.decisions : [];
    if (!rows.length) {
      return '<div class="home-meta">暂无 PM 自动治理判断（PM wake/patrol 后会写入 cycle journal）</div>';
    }
    return rows
      .map((d) => {
        const thread = esc(d.thread_key || '—');
        const state = esc(d.detected_state || 'unknown');
        const skill = esc(d.suggested_skill || '—');
        const reason = esc(d.reason || d.summary || '');
        const needConfirm = d.requires_confirmation ? '是' : '否';
        const persisted = d.persisted ? '是' : '否';
        const taskHint = d.task_id
          ? `<span class="home-pm-decision-task">${esc(d.task_id)}</span>`
          : '';
        const logBtn =
          d.task_id && (state === 'missing_report' || state === 'stalled')
            ? `<button type="button" class="hbtn pm-lc-session-btn" data-task="${esc(d.task_id)}" style="font-size:12px;margin-left:6px">查看会话日志</button>`
            : '';
        return `<div class="home-pm-decision">
  <div class="home-pm-decision-head"><strong>${thread}</strong>${taskHint}<span class="home-tag review">${state}</span>${logBtn}</div>
  <div class="home-pm-decision-skill">${skill}</div>
  <p class="home-pm-decision-reason">${reason}</p>
  <div class="home-pm-decision-meta">需确认：${needConfirm} · 已落盘：${persisted}</div>
</div>`;
      })
      .join('');
  }

  function bindPmLogCenterButtons(root) {
    if (!root) return;
    root.querySelectorAll('.pm-lc-session-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const taskId = btn.getAttribute('data-task') || '';
        if (taskId && typeof global.openLogCenterForSession === 'function') {
          global.openLogCenterForSession({ task_id: taskId, tab: 'sessions' });
        }
      });
    });
  }

  function renderTeamIdentityPanel(policy) {
    if (!policy) {
      const err = _policyLoadError
        ? esc(_policyLoadError)
        : '暂无团队身份配置。';
      return '<div class="home-meta" style="color:var(--text3)">' + err + '</div>';
    }

    const name = esc(policy.team_name || '');
    const type = esc(policy.team_type || '');
    const mode = esc(policy.approval_mode || '');
    const version = policy.version || 1;
    const desc = esc(policy.description || '开发团队 AI 审批规则。用于指导 REVIEW agent 判断哪些开发动作需要 ADMIN 人工审批。');
    const policyFile = esc(policy.policy_file || 'fcop/shared/policies/review-decision-policy.yaml');

    return `
      <div class="tc-git-row" style="margin-bottom:12px">
        <label class="tc-git-label" style="font-weight:600;margin-bottom:4px;display:block">团队名称 (team_name)</label>
        <input type="text" id="policy-team-name" class="tc-git-input" value="${name}" placeholder="如：开发团队">
      </div>
      <div class="tc-git-row" style="margin-bottom:12px">
        <label class="tc-git-label" style="font-weight:600;margin-bottom:4px;display:block">团队类型 (team_type)</label>
        <select id="policy-team-type" class="tc-model-select">
          <option value="software_dev" ${type === 'software_dev' ? 'selected' : ''}>software_dev (软件开发)</option>
          <option value="devops" ${type === 'devops' ? 'selected' : ''}>devops (运维)</option>
          <option value="secops" ${type === 'secops' ? 'selected' : ''}>secops (安全)</option>
          <option value="general" ${type === 'general' ? 'selected' : ''}>general (通用)</option>
        </select>
      </div>
      <div class="tc-git-row" style="margin-bottom:12px">
        <label class="tc-git-label" style="font-weight:600;margin-bottom:4px;display:block">审批模式 (approval_mode)</label>
        <select id="policy-approval-mode" class="tc-model-select">
          <option value="semi_auto" ${mode === 'semi_auto' ? 'selected' : ''}>semi_auto (半自动)</option>
          <option value="manual" ${mode === 'manual' ? 'selected' : ''}>manual (人工)</option>
          <option value="auto" ${mode === 'auto' ? 'selected' : ''}>auto (全自动)</option>
        </select>
      </div>
      <div class="tc-git-row" style="margin-bottom:12px">
        <label class="tc-git-label" style="font-weight:600;margin-bottom:4px;display:block">版本</label>
        <div style="font-size:14px;color:var(--text3);padding:2px 0">v${version}</div>
      </div>
      <div class="tc-git-row" style="margin-bottom:12px">
        <label class="tc-git-label" style="font-weight:600;margin-bottom:4px;display:block">策略描述</label>
        <div style="font-size:14px;color:var(--text3);line-height:1.4">${desc}</div>
      </div>
      <div class="tc-git-row" style="margin-bottom:16px">
        <label class="tc-git-label" style="font-weight:600;margin-bottom:4px;display:block">策略文件</label>
        <div style="font-size:13px;color:var(--text3);word-break:break-all;font-family:monospace">${policyFile}</div>
      </div>
      <div style="display:flex;justify-content:flex-end">
        <button type="button" class="hbtn blue" id="save-identity-btn" style="font-size:14px;padding:5px 16px">保存团队身份</button>
      </div>
    `;
  }

  function bindTeamIdentityEvents(root) {
    const btn = root.querySelector('#save-identity-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const nameInput = root.querySelector('#policy-team-name');
      const typeSelect = root.querySelector('#policy-team-type');
      const modeSelect = root.querySelector('#policy-approval-mode');

      const team_name = nameInput ? nameInput.value.trim() : '';
      const team_type = typeSelect ? typeSelect.value : '';
      const approval_mode = modeSelect ? modeSelect.value : '';

      if (!team_name) {
        alert('团队名称不能为空');
        return;
      }

      btn.disabled = true;
      btn.innerText = '保存中…';
      try {
        const res = await fetch('/api/v2/team/review-decision-policy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            team_name,
            team_type,
            approval_mode
          })
        });
        if (res.ok) {
          _policy = await res.json();
          const savedHint = document.getElementById('ts-saved-hint');
          if (savedHint) {
            savedHint.innerText = '团队身份保存成功！';
            savedHint.style.color = '#4ade80';
            setTimeout(() => { savedHint.innerText = ''; }, 3000);
          }
          applyTeamPmPanelToDOM();
        } else {
          const err = await res.text();
          alert('保存失败: ' + err);
        }
      } catch (err) {
        console.error('Failed to save team identity:', err);
        alert('保存出错，请查看控制台');
      } finally {
        btn.disabled = false;
        btn.innerText = '保存团队身份';
      }
    });
  }

  function renderTeamApprovalPolicyPanel(policy) {
    if (!policy) {
      const err = _policyLoadError
        ? esc(_policyLoadError)
        : '暂无审批规则。';
      return '<div class="home-meta" style="color:var(--text3)">' + err + '</div>';
    }

    const invariants = policy.system_invariants ? (policy.system_invariants.rules || []) : [];
    const teamRules = policy.team_rules ? (policy.team_rules.rules || []) : [];

    const renderInvariantsHtml = invariants.map((r) => {
      const id = esc(r.id);
      const name = esc(r.name);
      const desc = esc(r.description);
      const action = esc(r.action);
      return `
        <div style="padding:10px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);border-radius:6px;margin-bottom:8px;opacity:0.7">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="font-weight:600;font-size:14px;color:var(--text2)">${name}</span>
            <span style="font-size:12px;background:rgba(148,163,184,0.15);color:var(--text3);padding:1px 6px;border-radius:4px;border:1px solid rgba(148,163,184,0.25)">系统底线 · 始终开启</span>
          </div>
          <div style="font-size:13px;color:var(--text3);line-height:1.35;margin-bottom:4px">${desc}</div>
          <div style="font-size:12px;color:var(--text3);font-family:monospace">action: ${action} · id: ${id}</div>
        </div>
      `;
    }).join('') || '<div class="home-meta">无系统底线规则</div>';

    const renderTeamRulesHtml = teamRules.map((r) => {
      const id = esc(r.id);
      const name = esc(r.name);
      const desc = esc(r.description);
      const action = esc(r.action);
      const isEnabled = r.enabled !== false;

      return `
        <div style="padding:10px;background:rgba(59,130,246,0.02);border:1px solid rgba(59,130,246,0.1);border-radius:6px;margin-bottom:8px;transition:all 0.2s">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="font-weight:600;font-size:14px;color:var(--text)">${name}</span>
            <label style="display:inline-flex;align-items:center;cursor:pointer">
              <input type="checkbox" class="rule-toggle-chk" data-rule-id="${id}" ${isEnabled ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--blue)">
            </label>
          </div>
          <div style="font-size:13px;color:var(--text2);line-height:1.35;margin-bottom:4px">${desc}</div>
          <div style="font-size:12px;color:var(--text3);font-family:monospace">action: ${action} · id: ${id}</div>
        </div>
      `;
    }).join('') || '<div class="home-meta">无可配置团队规则</div>';

    return `
      ${renderTapFoldSection(
        'invariants',
        '⚙️ 系统底线规则 (只读)',
        `<div style="max-height:220px;overflow-y:auto;padding-right:4px">${renderInvariantsHtml}</div>`
      )}
      ${renderTapFoldSection(
        'teamRules',
        '🛠️ 团队可配置规则',
        `<div style="max-height:300px;overflow-y:auto;padding-right:4px">${renderTeamRulesHtml}</div>`
      )}
      <div style="display:flex;justify-content:flex-end">
        <button type="button" class="hbtn blue" id="save-rules-btn" style="font-size:14px;padding:5px 16px">保存规则设置</button>
      </div>
    `;
  }

  function renderTapFoldSection(key, title, innerHtml) {
    const expanded = _tapFoldState[key] !== false;
    const arrowClass = expanded ? 'ts-arrow' : 'ts-arrow collapsed';
    const bodyClass = expanded ? 'tap-fold-body' : 'tap-fold-body is-collapsed';
    return `
      <div class="tap-fold" data-tap-fold="${esc(key)}">
        <div class="tap-fold-hd" role="button" tabindex="0" aria-expanded="${expanded ? 'true' : 'false'}">
          <span class="${arrowClass}">▼</span>
          <h4>${title}</h4>
        </div>
        <div class="${bodyClass}">${innerHtml}</div>
      </div>
    `;
  }

  function bindTapFoldEvents(root) {
    root.querySelectorAll('.tap-fold-hd').forEach((hd) => {
      const toggle = () => {
        const wrap = hd.closest('.tap-fold');
        if (!wrap) return;
        const key = wrap.getAttribute('data-tap-fold');
        const body = wrap.querySelector('.tap-fold-body');
        const arrow = hd.querySelector('.ts-arrow');
        if (!body || !key) return;
        const willCollapse = !body.classList.contains('is-collapsed');
        body.classList.toggle('is-collapsed', willCollapse);
        if (arrow) arrow.classList.toggle('collapsed', willCollapse);
        hd.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
        _tapFoldState[key] = !willCollapse;
      };
      hd.addEventListener('click', toggle);
      hd.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });
  }

  function bindTeamApprovalPolicyEvents(root) {
    bindTapFoldEvents(root);
    const btn = root.querySelector('#save-rules-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const toggles = root.querySelectorAll('.rule-toggle-chk');
      const team_rules = [];
      toggles.forEach((chk) => {
        const id = chk.getAttribute('data-rule-id');
        const enabled = chk.checked;
        team_rules.push({ id, enabled });
      });

      btn.disabled = true;
      btn.innerText = '保存中…';
      try {
        const res = await fetch('/api/v2/team/review-decision-policy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            team_rules
          })
        });
        if (res.ok) {
          _policy = await res.json();
          const savedHint = document.getElementById('ts-saved-hint');
          if (savedHint) {
            savedHint.innerText = '审批规则保存成功！';
            savedHint.style.color = '#4ade80';
            setTimeout(() => { savedHint.innerText = ''; }, 3000);
          }
          applyTeamPmPanelToDOM();
        } else {
          const err = await res.text();
          alert('保存失败: ' + err);
        }
      } catch (err) {
        console.error('Failed to save rules:', err);
        alert('保存出错，请查看控制台');
      } finally {
        btn.disabled = false;
        btn.innerText = '保存规则设置';
      }
    });
  }

  function applyTeamPmPanelToDOM() {
    const skillsEl = document.getElementById('teamPmSkills');
    if (skillsEl) skillsEl.innerHTML = renderPmSkillsPanel();
    const decisionsEl = document.getElementById('teamPmDecisions');
    if (decisionsEl) {
      decisionsEl.innerHTML = renderPmDecisionsPanel();
      bindPmLogCenterButtons(decisionsEl);
    }

    const identityEl = document.getElementById('teamIdentitySection');
    if (identityEl) {
      identityEl.innerHTML = renderTeamIdentityPanel(_policy);
      bindTeamIdentityEvents(identityEl);
    }

    const policyEl = document.getElementById('teamApprovalPolicySection');
    if (policyEl) {
      policyEl.innerHTML = renderTeamApprovalPolicyPanel(_policy);
      bindTeamApprovalPolicyEvents(policyEl);
    }
  }

  function renderTeamIdentity(policy) {
    if (policy !== undefined) _policy = policy;
    const identityEl = document.getElementById('teamIdentitySection');
    if (!identityEl) return;
    identityEl.innerHTML = renderTeamIdentityPanel(_policy);
    bindTeamIdentityEvents(identityEl);
  }

  function renderApprovalPolicy(policy) {
    if (policy !== undefined) _policy = policy;
    const policyEl = document.getElementById('teamApprovalPolicySection');
    if (!policyEl) return;
    policyEl.innerHTML = renderTeamApprovalPolicyPanel(_policy);
    bindTeamApprovalPolicyEvents(policyEl);
  }

  async function loadTeamPmPanel() {
    if (_loadInflight) return _loadInflight;
    _loadInflight = (async () => {
    _loading = true;
    _policyLoadError = '';
    const skillsEl = document.getElementById('teamPmSkills');
    const decisionsEl = document.getElementById('teamPmDecisions');
    if (skillsEl) skillsEl.innerHTML = '<div class="home-meta">加载中…</div>';
    if (decisionsEl) decisionsEl.innerHTML = '<div class="home-meta">加载中…</div>';

    const identityEl = document.getElementById('teamIdentitySection');
    const policyEl = document.getElementById('teamApprovalPolicySection');
    if (identityEl) identityEl.innerHTML = '<div class="home-meta">加载中…</div>';
    if (policyEl) policyEl.innerHTML = '<div class="home-meta">加载中…</div>';

    try {
      const pmSection = document.querySelector('.team-pm-section');
      if (pmSection) {
        pmSection.style.display = 'none';
      }

      const [pmSkillsRes, pmDecisionsRes, policyRes] = await Promise.all([
        fetchWithTimeout('/api/v2/pm/skills/enabled'),
        fetchWithTimeout('/api/v2/pm/governance/cycle/recent?limit=20'),
        fetchWithTimeout('/api/v2/team/review-decision-policy'),
      ]);

      if (pmSkillsRes.ok) {
        _pmSkills = await pmSkillsRes.json();
      } else {
        _pmSkills = null;
      }
      if (pmDecisionsRes.ok) {
        _pmDecisions = await pmDecisionsRes.json();
      } else {
        _pmDecisions = null;
      }
      if (policyRes.ok) {
        _policy = await policyRes.json();
      } else {
        _policy = null;
        _policyLoadError = '审批策略加载失败（HTTP ' + policyRes.status + '）';
      }
    } catch (err) {
      _pmSkills = null;
      _pmDecisions = null;
      _policy = null;
      const msg = String((err && err.message) || err || '');
      _policyLoadError = /abort|timeout/i.test(msg)
        ? '请求超时，请检查 Panel 服务是否运行。'
        : '加载失败：' + msg;
    } finally {
      _loading = false;
      applyTeamPmPanelToDOM();
    }
    })().finally(() => {
      _loadInflight = null;
    });
    return _loadInflight;
  }

  global.loadTeamPmPanel = loadTeamPmPanel;
  global.renderTeamIdentity = renderTeamIdentity;
  global.renderApprovalPolicy = renderApprovalPolicy;

  console.log('[team-pm-panel] loaded restore-v3 2026-06-10');
})(typeof window !== 'undefined' ? window : globalThis);
