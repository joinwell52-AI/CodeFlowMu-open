(function initLogCenterCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodeFlowMuLogCenterCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLogCenterCore() {
  'use strict';

  const DEFAULT_FAILURE_WINDOW_MS = 30 * 1000;

  function finiteTs(value) {
    const ts = Number(value);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  }

  function pad(value, size) {
    return String(value).padStart(size || 2, '0');
  }

  function formatIsoWithOffset(ts, offsetMinutes) {
    const stableTs = finiteTs(ts);
    if (stableTs == null) return '';
    const source = new Date(stableTs);
    const eastMinutes = Number.isFinite(offsetMinutes)
      ? Number(offsetMinutes)
      : -source.getTimezoneOffset();
    const local = new Date(stableTs + eastMinutes * 60 * 1000);
    const sign = eastMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(eastMinutes);
    return (
      local.getUTCFullYear() +
      '-' + pad(local.getUTCMonth() + 1) +
      '-' + pad(local.getUTCDate()) +
      'T' + pad(local.getUTCHours()) +
      ':' + pad(local.getUTCMinutes()) +
      ':' + pad(local.getUTCSeconds()) +
      '.' + pad(local.getUTCMilliseconds(), 3) +
      sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
    );
  }

  function dateKey(ts, timeZone) {
    const stableTs = finiteTs(ts);
    if (stableTs == null) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      ...(timeZone ? { timeZone } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(stableTs));
    const values = {};
    for (const part of parts) values[part.type] = part.value;
    return `${values.year || ''}-${values.month || ''}-${values.day || ''}`;
  }

  function rowTimestamp(row) {
    if (!row || row.legacy_time_unknown === true) return null;
    const ts = finiteTs(row.ts);
    if (ts != null) return ts;
    if (typeof row.at === 'string' && row.at.trim()) {
      const parsed = Date.parse(row.at);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  function parseLegacyDateTime(dateText, timeText, offsetMinutes) {
    const date = String(dateText || '').trim();
    const time = String(timeText || '').trim();
    const tm = time.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d{1,3}))?$/);
    if (!date || !tm) return null;

    let year;
    let month;
    let day;
    let match = date.match(/^(\d{4})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})(?:日)?$/);
    if (match) {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    } else {
      match = date.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
      if (!match) return null;
      month = Number(match[1]);
      day = Number(match[2]);
      year = Number(match[3]);
    }

    const hour = Number(tm[1]);
    const minute = Number(tm[2]);
    const second = Number(tm[3] || 0);
    const millis = Number(String(tm[4] || '0').padEnd(3, '0'));
    if (
      year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59
    ) return null;

    let result;
    if (Number.isFinite(offsetMinutes)) {
      result = Date.UTC(year, month - 1, day, hour, minute, second, millis) -
        Number(offsetMinutes) * 60 * 1000;
      const check = new Date(result + Number(offsetMinutes) * 60 * 1000);
      if (
        check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day || check.getUTCHours() !== hour ||
        check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second
      ) return null;
    } else {
      const check = new Date(year, month - 1, day, hour, minute, second, millis);
      if (
        check.getFullYear() !== year || check.getMonth() !== month - 1 ||
        check.getDate() !== day || check.getHours() !== hour ||
        check.getMinutes() !== minute || check.getSeconds() !== second
      ) return null;
      result = check.getTime();
    }
    return result;
  }

  function nestedObjects(value, maxDepth) {
    const out = [];
    const seen = new Set();
    function visit(current, depth) {
      if (!current || typeof current !== 'object' || Array.isArray(current) || seen.has(current)) return;
      seen.add(current);
      out.push(current);
      if (depth >= maxDepth) return;
      for (const key of ['payload', 'raw', 'error', 'details', 'result']) visit(current[key], depth + 1);
    }
    visit(value, 0);
    return out;
  }

  function pickNested(value, keys) {
    const objects = nestedObjects(value, 3);
    for (const obj of objects) {
      for (const key of keys) {
        const item = obj[key];
        if (item != null && String(item).trim()) return String(item).trim();
      }
    }
    return '';
  }

  function normalizeCode(value) {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120);
  }

  function normalizedErrorCode(row) {
    const direct = pickNested(row, [
      'normalized_error_code', 'error_code', 'failure_code', 'code', 'reason_code', 'reason',
    ]);
    if (direct) return normalizeCode(direct);
    const text = `${row && row.event_type || ''} ${row && row.message || ''}`;
    const known = text.match(/CODEFLOWMU_[A-Z0-9_]+|[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+/i);
    if (known) return normalizeCode(known[0]);
    if (/policy\s*blocked|策略阻止|策略拦截/i.test(text)) return 'CODEFLOWMU_POLICY_BLOCKED';
    return 'UNKNOWN';
  }

  function terminalStatus(row) {
    const raw = pickNested(row, ['terminal_status', 'status', 'state', 'outcome']).toLowerCase();
    if (/fail|error|block|denied|reject/.test(raw)) return 'failed';
    if (/cancel|abort|interrupt/.test(raw)) return 'cancelled';
    if (/success|succeed|complete|done|ok/.test(raw)) return 'succeeded';
    return row && row.level === 'ERROR' ? 'failed' : raw || 'unknown';
  }

  function callId(row) {
    return pickNested(row, ['call_id', 'tool_call_id', 'tool_use_id']);
  }

  function normalizeLocalAlert(entry, index, options) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const opts = options || {};
    let ts = finiteTs(source.ts);
    let legacyUnknown = source.legacy_time_unknown === true;
    if (ts == null && typeof source.ts === 'string') {
      ts = parseLegacyDateTime(source.date, source.ts, opts.offsetMinutes);
      if (ts == null) legacyUnknown = true;
    }
    if (ts == null && typeof source.at === 'string' && source.at.trim()) {
      const parsed = Date.parse(source.at);
      if (Number.isFinite(parsed) && parsed > 0) ts = parsed;
    }
    if (ts == null) legacyUnknown = true;

    const context = { ...source, payload: source.payload };
    const level = source.level === 'ERROR' ? 'ERROR' : source.level === 'WARN' ? 'WARN' : 'INFO';
    const eventType = String(source.event_type || 'panel.local');
    const message = String(source.message != null ? source.message : source.msg || '');
    const agent = String(source.agent_id || source.agent || '—');
    const stableAt = ts != null ? formatIsoWithOffset(ts, opts.offsetMinutes) : '';
    return {
      id: String(source.id || `local-${index || 0}-${ts != null ? ts : 'legacy-unknown'}`),
      ...(ts != null ? { ts } : {}),
      at: stableAt,
      tab: 'alerts',
      event_type: eventType,
      level,
      agent_id: agent,
      session_id: String(source.session_id || pickNested(context, ['session_id']) || ''),
      call_id: String(source.call_id || callId(context) || ''),
      status: String(source.status || pickNested(context, ['status']) || ''),
      normalized_error_code: String(
        source.normalized_error_code || pickNested(context, ['error_code', 'failure_code', 'code']) || '',
      ),
      message,
      local_alert: true,
      legacy_time_unknown: legacyUnknown,
      payload: source.payload,
    };
  }

  function toLocalAlertRecord(level, agent, message, context, now, options) {
    const meta = context && typeof context === 'object' ? context : {};
    const parsedAt = typeof meta.at === 'string' ? Date.parse(meta.at) : NaN;
    const ts = finiteTs(meta.ts) ||
      (Number.isFinite(parsedAt) && parsedAt > 0 ? parsedAt : null) ||
      finiteTs(now) || Date.now();
    return {
      at: formatIsoWithOffset(ts, options && options.offsetMinutes),
      ts,
      level: level === 'ERROR' ? 'ERROR' : level === 'WARN' ? 'WARN' : 'INFO',
      agent: String(agent || meta.agent_id || '—'),
      session_id: String(meta.session_id || pickNested(meta, ['session_id']) || ''),
      call_id: String(meta.call_id || callId(meta) || ''),
      event_type: String(meta.event_type || meta.type || 'panel.local'),
      status: String(meta.status || pickNested(meta, ['status']) || ''),
      normalized_error_code: String(
        meta.normalized_error_code || pickNested(meta, ['error_code', 'failure_code', 'code', 'reason']) || '',
      ),
      message: String(message || '').slice(0, 500),
    };
  }

  function isToday(row, now, timeZone) {
    const ts = rowTimestamp(row);
    return ts != null && dateKey(ts, timeZone) === dateKey(finiteTs(now) || Date.now(), timeZone);
  }

  function rangeStart(range, now, timeZone) {
    const nowTs = finiteTs(now) || Date.now();
    if (String(range) === 'today') {
      const key = dateKey(nowTs, timeZone);
      if (timeZone) {
        let lo = nowTs - 36 * 3600 * 1000;
        let hi = nowTs;
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (dateKey(mid, timeZone) < key) lo = mid + 1;
          else hi = mid;
        }
        return hi;
      }
      const d = new Date(nowTs);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }
    const hours = Number(range);
    return Number.isFinite(hours) && hours > 0 ? nowTs - hours * 3600 * 1000 : null;
  }

  function filterRowsByRange(rows, range, now, timeZone) {
    const list = Array.isArray(rows) ? rows : [];
    const start = rangeStart(range, now, timeZone);
    if (start == null) return list.slice();
    return list.filter((row) => {
      const ts = rowTimestamp(row);
      return ts != null && ts >= start && ts <= (finiteTs(now) || Date.now());
    });
  }

  function matchesLocalFilters(row, filters) {
    const f = filters || {};
    if (f.agent && !String(row.agent_id || '').toUpperCase().includes(String(f.agent).toUpperCase())) return false;
    if (f.task_id && !String(row.task_id || '').toUpperCase().includes(String(f.task_id).toUpperCase())) return false;
    if (f.session_id && String(row.session_id || '') !== String(f.session_id)) return false;
    if (f.event_type && !String(row.event_type || '').toLowerCase().includes(String(f.event_type).toLowerCase())) return false;
    if (f.status && String(row.status || '').toLowerCase() !== String(f.status).toLowerCase()) return false;
    if (f.reason) {
      const reason = `${row.reason || ''} ${row.normalized_error_code || ''}`.toUpperCase();
      if (!reason.includes(String(f.reason).toUpperCase())) return false;
    }
    return true;
  }

  function aggregateFailures(rows, options) {
    const list = Array.isArray(rows) ? rows : [];
    const windowMs = Number(options && options.windowMs) || DEFAULT_FAILURE_WINDOW_MS;
    const output = [];
    const byCall = new Map();
    const latestWindowGroup = new Map();
    const sorted = list.slice().sort((a, b) => (rowTimestamp(a) || 0) - (rowTimestamp(b) || 0));

    for (const row of sorted) {
      if (!row || row.level !== 'ERROR') {
        output.push({ ...row, raw_event_count: 1, raw_events: [row] });
        continue;
      }
      const session = String(row.session_id || pickNested(row, ['session_id']) || 'no-session');
      const agent = String(row.agent_id || 'no-agent');
      const status = terminalStatus(row);
      const cid = callId(row);
      let code = normalizedErrorCode(row);
      if (!cid && code === 'UNKNOWN') {
        const signature = normalizeCode(row.message || row.event_type || 'UNKNOWN');
        code = signature ? `MESSAGE_${signature.slice(0, 72)}` : 'UNKNOWN';
      }
      const ts = rowTimestamp(row) || 0;
      let group;
      let key;
      if (cid) {
        key = `call:${session}:${cid}:${status}:${code}`;
        group = byCall.get(key);
      } else {
        const base = `window:${session}:${agent}:${status}:${code}`;
        const previous = latestWindowGroup.get(base);
        if (previous && ts > 0 && previous.lastTs > 0 && ts - previous.lastTs <= windowMs) {
          group = previous.group;
          key = group.fault_key;
        } else {
          key = `${base}:${ts}`;
        }
      }

      if (!group) {
        group = {
          ...row,
          id: `fault-${output.length}-${ts}`,
          fault_key: key,
          independent_fault: true,
          normalized_error_code: code,
          terminal_status: status,
          call_id: cid,
          raw_event_count: 0,
          raw_events: [],
        };
        output.push(group);
        if (cid) byCall.set(key, group);
      }
      group.raw_events.push(row);
      group.raw_event_count = group.raw_events.length;
      if (ts >= (rowTimestamp(group) || 0)) {
        const keep = {
          id: group.id,
          fault_key: group.fault_key,
          independent_fault: true,
          normalized_error_code: code,
          terminal_status: status,
          call_id: cid,
          raw_event_count: group.raw_event_count,
          raw_events: group.raw_events,
        };
        Object.assign(group, row, keep);
      }
      if (!cid) {
        const base = `window:${session}:${agent}:${status}:${code}`;
        latestWindowGroup.set(base, { group, lastTs: ts });
      }
    }
    return output.sort((a, b) => (rowTimestamp(b) || 0) - (rowTimestamp(a) || 0));
  }

  function calculateStats(rows, options) {
    const list = Array.isArray(rows) ? rows : [];
    const opts = options || {};
    const grouped = aggregateFailures(list, opts);
    const errors = grouped.filter((row) => row && row.level === 'ERROR').length;
    const warnings = grouped.filter((row) => row && row.level === 'WARN').length;
    const processStartTs = finiteTs(opts.processStartTs);
    return {
      errors,
      warnings,
      independentFaults: errors,
      rawEvents: list.length,
      todayEvents: list.filter((row) => isToday(row, opts.now, opts.timeZone)).length,
      startupEvents: processStartTs == null
        ? 0
        : list.filter((row) => {
          const ts = rowTimestamp(row);
          return ts != null && ts >= processStartTs;
        }).length,
    };
  }

  return {
    DEFAULT_FAILURE_WINDOW_MS,
    aggregateFailures,
    calculateStats,
    callId,
    dateKey,
    filterRowsByRange,
    formatIsoWithOffset,
    isToday,
    matchesLocalFilters,
    normalizeCode,
    normalizeLocalAlert,
    normalizedErrorCode,
    parseLegacyDateTime,
    rangeStart,
    rowTimestamp,
    terminalStatus,
    toLocalAlertRecord,
  };
});
