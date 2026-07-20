/**
 * CodeFlowMu Mobile PWA — TASK-010R-D-FIX
 * 旧 PWA UI + Gateway/Mobile API；聊天与任务分离，禁止聊天转 TASK。
 */
(function () {
  "use strict";

  /** 本机当前运行的 PWA 包版本（发版时与 version.json / index.html ?v= 对齐） */
  var BUNDLE_VERSION = "V1.0.53";
  var PWA_CACHE_BUST = "1.0.53";
  var PWA_VERSION_STORAGE_KEY = "cfm_pwa_installed_version";
  var PWA_LEGACY_CACHE_NAMES = [
    "codeflowmu-pwa-v1.0.52",
    "codeflowmu-pwa-v1.0.51",
    "codeflowmu-pwa-v1.0.50",
    "codeflowmu-pwa-v1.0.49",
    "codeflowmu-pwa-v1.0.48",
    "codeflowmu-pwa-v1.0.47",
    "codeflowmu-pwa-v1.0.45",
    "codeflowmu-pwa-v1.0.44",
    "codeflowmu-pwa-v1.0.28",
    "codeflowmu-pwa-v1.0.27",
    "codeflowmu-pwa-v1.0.25",
    "codeflowmu-pwa-v1.0.19",
    "codeflowmu-pwa-v1.0.18",
    "codeflowmu-pwa-v1.0.17",
    "codeflowmu-pwa-v1.0.15",
    "codeflowmu-pwa-v1.0.14",
    "codeflowmu-pwa-v1.0.13",
    "codeflowmu-pwa-v1.0.12",
    "codeflowmu-pwa-v1.0.11",
    "codeflowmu-pwa-v1.0.10",
    "codeflowmu-pwa-v1.0.9",
    "codeflowmu-pwa-v1.0.8",
    "cfm-mobile-v26",
  ];
  var appVersion = BUNDLE_VERSION;
  var EMPTY_STATS = { today_tasks: 0, today_reports: 0, in_progress: 0, done: 0 };
  var ROLES = ["PM", "DEV", "QA", "OPS"];
  var TASK_FILTERS = ["all", "pending", "active", "review", "done", "archive", "exception"];
  var REPORT_FILTERS = ["all", "main_report", "sub_report", "record"];
  var APPROVAL_FILTERS = ["all", "pending", "approved", "rejected", "needs_eval", "exception"];
  var ACTIVITY_FILTERS = ["all", "PM", "DEV", "QA", "OPS", "exception"];
  var bindingInProgress = false;
  /** bind 成功后短时内不因 refresh 401/403 清 session（毫秒时间戳） */
  var bindGraceUntil = 0;
  /** 与 localStorage cfm_mobile_session_token 同步的内存 token，避免 bind 后首包请求仍读旧态 */
  var sessionMemoryToken = "";
  var AUTH_TOKEN_KEY = "cfm_mobile_session_token";

  var state = {
    tab: "home",
    tasks: [],
    reports: [],
    approvals: [],
    bootstrap: null,
    selectedRole: "PM",
    tasksRoleFilter: null,
    currentDetail: null,
    detailKind: "task",
    relationPickerTasks: [],
    apiErrors: {},
    taskFilter: "all",
    reportFilter: "all",
    approvalFilter: "all",
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    chatMessages: [],
    chatPollTimer: null,
    chatPollDelay: 3000,
    chatSending: false,
    activityEvents: [],
    activityLoadError: null,
    activityFilter: "all",
    activityPollTimer: null,
    activityPollDelay: 3000,
    chatMessagesFingerprint: null,
    activityRenderFingerprint: null,
    // 图片上传（仅前端待上传态；刷新后会清空，服务端持久化后会重新从接口加载）
    pendingTaskAttachments: [],
    pendingChatAttachments: [],
    chatAttachmentPreviewCache: {},
    taskAttachmentPreviewCache: {},
    tasksListCollapsed: false,
  };

  var CHAT_LOCAL_KEY = "cfm_mobile_chat_log";
  var SELECTED_ROLE_KEY = "codeflow_selected_role";
  var TASKS_LIST_COLLAPSED_KEY = "cfm_tasks_list_collapsed";

  function getToken() {
    if (sessionMemoryToken) return sessionMemoryToken;
    try {
      return localStorage.getItem(AUTH_TOKEN_KEY) || "";
    } catch (e) {
      return "";
    }
  }
  function extractBindSessionToken(data) {
    if (!data || typeof data !== "object") return "";
    return (
      data.mobile_session_token ||
      data.session_token ||
      data.access_token ||
      data.mobile_token ||
      data.token ||
      ""
    );
  }
  function applyAuthSession(token, deviceId, apiBase) {
    sessionMemoryToken = token ? String(token) : "";
    if (sessionMemoryToken) bindGraceUntil = Date.now() + 5000;
    try {
      if (sessionMemoryToken) localStorage.setItem(AUTH_TOKEN_KEY, sessionMemoryToken);
      else localStorage.removeItem(AUTH_TOKEN_KEY);
      if (deviceId) localStorage.setItem("cfm_mobile_device_id", deviceId);
      if (apiBase) localStorage.setItem("cfm_mobile_api_base", apiBase);
    } catch (e) {}
    try {
      document.documentElement.setAttribute("data-bound", sessionMemoryToken ? "1" : "0");
    } catch (e2) {}
    updateTabBoundState();
  }
  function setSession(token, deviceId, apiBase) {
    applyAuthSession(token, deviceId, apiBase);
  }
  function clearSession() {
    sessionMemoryToken = "";
    try {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem("cfm_mobile_device_id");
      localStorage.removeItem("cfm_mobile_api_base");
    } catch (e) {}
    try {
      document.documentElement.setAttribute("data-bound", "0");
    } catch (e2) {}
  }
  function isPrivateOrLocalHost(hostname) {
    var h = String(hostname || "").toLowerCase();
    if (!h || h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^10\./.test(h)) return true;
    var m = /^172\.(\d+)\./.exec(h);
    if (m) {
      var second = Number(m[1]);
      if (second >= 16 && second <= 31) return true;
    }
    return false;
  }
  function isLanDirectApiBase(u, loc) {
    var path = u.pathname.replace(/\/$/, "");
    if (path && path !== "") return false;
    if (isPrivateOrLocalHost(u.hostname)) return true;
    return !!(loc && u.hostname === loc.hostname);
  }
  function resolveMobileApiBase() {
    var loc = window.location;
    if (loc.protocol === "file:") return "http://127.0.0.1:3847";
    if (loc.port === "3848" || loc.port === "5173") {
      return loc.protocol + "//" + loc.hostname + ":3847";
    }
    var match = loc.pathname.match(/^(.*\/m\/[^/]+)\/mobile\/?/);
    if (match) return loc.origin + match[1];
    if (/\/codeflowmu\/mobile\/?/.test(loc.pathname)) return "";
    if (/\/mobile\/?/.test(loc.pathname)) return loc.origin;
    return "";
  }
  function isPlausibleApiBase(base) {
    var s = String(base || "")
      .replace(/\/$/, "")
      .trim();
    if (!s) return false;
    try {
      var u = new URL(s);
      if (!/^https?:$/i.test(u.protocol)) return false;
      var loc = window.location;
      if (u.port === "3847" && (u.hostname === "127.0.0.1" || u.hostname === loc.hostname)) return true;
      if (/\/m\/[^/]+$/.test(u.pathname.replace(/\/$/, ""))) return true;
      return isLanDirectApiBase(u, loc);
    } catch (e) {
      return false;
    }
  }
  function isGatewayApiBase(base) {
    try {
      var u = new URL(String(base || "").replace(/\/$/, ""));
      return /\/m\/[^/]+$/.test(u.pathname.replace(/\/$/, ""));
    } catch (e) {
      return false;
    }
  }
  function isLanMobileShell() {
    var path = window.location.pathname || "";
    return /\/mobile\/?/.test(path) && !/\/codeflowmu\/mobile\/?/.test(path) && !/\/m\/[^/]+\/mobile\/?/.test(path);
  }
  function lanShellOrigin() {
    if (!isLanMobileShell()) return "";
    return window.location.origin || "";
  }
  function reconcileApiBaseFromServer(apiBase) {
    if (!apiBase || !isPlausibleApiBase(apiBase)) return;
    var normalized = String(apiBase).replace(/\/$/, "");
    var lanOrigin = lanShellOrigin();
    if (lanOrigin && isGatewayApiBase(normalized)) {
      try {
        localStorage.setItem("cfm_mobile_api_base", lanOrigin);
      } catch (e) {}
      return;
    }
    try {
      localStorage.setItem("cfm_mobile_api_base", normalized);
    } catch (e) {}
  }
  function clearInvalidStoredApiBase() {
    var stored = getStoredApiBase();
    if (stored && !isPlausibleApiBase(stored)) {
      try {
        localStorage.removeItem("cfm_mobile_api_base");
      } catch (e) {}
    }
  }
  function getStoredApiBase() {
    try {
      return localStorage.getItem("cfm_mobile_api_base") || "";
    } catch (e) {
      return "";
    }
  }
  function getApiBase() {
    var lanOrigin = lanShellOrigin();
    var stored = getStoredApiBase();
    if (lanOrigin) {
      if (stored && isPlausibleApiBase(stored) && !isGatewayApiBase(stored)) return stored;
      return lanOrigin;
    }
    if (stored && isPlausibleApiBase(stored)) return stored;
    return resolveMobileApiBase();
  }
  function mobileApiBaseFromUrl(u) {
    var pathMatch = u.pathname.match(/^(.*\/m\/[^/]+)\/mobile\/?/);
    if (pathMatch) {
      return { api_base: u.origin + pathMatch[1], missing_instance: false };
    }
    if (/\/codeflowmu\/mobile\/?/.test(u.pathname)) {
      return { api_base: "", missing_instance: true };
    }
    if (/\/mobile\/?/.test(u.pathname)) {
      return { api_base: u.origin, missing_instance: false };
    }
    return { api_base: "", missing_instance: false };
  }
  function currentPublicShellNeedsInstance() {
    var path = window.location.pathname || "";
    return /\/codeflowmu\/mobile\/?/.test(path) && !/\/m\/[^/]+\/mobile\/?/.test(path);
  }
  function bindMissingInstanceMessage() {
    if (currentPublicShellNeedsInstance()) {
      return "Bind link is missing /m/{instance_id}. Refresh the PC Mobile QR and scan the full Gateway link.";
    }
    return t("bindMissingApi");
  }

  function $(id) {
    return document.getElementById(id);
  }
  function parseVersionParts(v) {
    var s = String(v || "")
      .replace(/^V/i, "")
      .trim();
    if (!s) return [0];
    return s.split(".").map(function (p) {
      var n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  }
  function versionLessThan(a, b) {
    var pa = parseVersionParts(a);
    var pb = parseVersionParts(b);
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var da = pa[i] || 0;
      var db = pb[i] || 0;
      if (da < db) return true;
      if (da > db) return false;
    }
    return false;
  }
  function getStoredPwaVersion() {
    try {
      var stored = localStorage.getItem(PWA_VERSION_STORAGE_KEY);
      if (stored && String(stored).trim()) return String(stored).trim();
    } catch (e) {}
    return "";
  }
  /** 实际运行版本：若 localStorage 误标为已更新但 bundle 仍较旧，以 bundle 为准（修复强更失败后的卡死） */
  function getEffectiveInstalledVersion() {
    var stored = getStoredPwaVersion();
    if (!stored) return BUNDLE_VERSION;
    if (versionLessThan(BUNDLE_VERSION, stored)) return BUNDLE_VERSION;
    return stored;
  }
  function setStoredPwaVersion(version) {
    if (!version) return;
    try {
      localStorage.setItem(PWA_VERSION_STORAGE_KEY, String(version).trim());
    } catch (e) {}
  }
  var pwaUpdatePending = false;

  function isPwaUpdatePending() {
    return pwaUpdatePending;
  }

  function syncRefreshBtnUpdateHint() {
    var btn = $("headerRefreshBtn");
    if (!btn) return;
    btn.classList.toggle("update-pending", pwaUpdatePending);
    btn.title = pwaUpdatePending
      ? t("refreshToUpdate")
      : t("refresh");
  }

  function showUpdateBar() {
    pwaUpdatePending = true;
    var bar = $("updateBar");
    if (bar) bar.classList.add("visible");
    syncRefreshBtnUpdateHint();
  }

  function showUpdateBarIfNeeded(remoteVersion) {
    if (!remoteVersion) return;
    var installed = getEffectiveInstalledVersion();
    var needsUpdate =
      versionLessThan(installed, remoteVersion) || versionLessThan(BUNDLE_VERSION, remoteVersion);
    if (!needsUpdate) {
      hideUpdateBar();
      return;
    }
    showUpdateBar();
  }
  function updateVersionDisplay() {
    var el = $("versionInfo");
    if (!el) return;
    el.textContent = BUNDLE_VERSION;
  }
  async function loadMobileVersionManifest() {
    var remoteVersion = BUNDLE_VERSION;
    try {
      var res = await fetch("./version.json?_=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return;
      var data = await res.json();
      if (data && typeof data.app_version === "string" && data.app_version.trim()) {
        remoteVersion = data.app_version.trim();
        appVersion = remoteVersion;
      }
      if (data && typeof data.resource_version === "string" && data.resource_version.trim()) {
        PWA_CACHE_BUST = data.resource_version.trim();
      } else if (data && typeof data.cache_bust === "string" && data.cache_bust.trim()) {
        PWA_CACHE_BUST = data.cache_bust.trim();
      } else {
        var bust = remoteVersion.replace(/^V/i, "").trim();
        if (bust) PWA_CACHE_BUST = bust;
      }
      // 仅当当前运行的 bundle 已追上远程版本时，才写入「已安装」标记
      if (!versionLessThan(BUNDLE_VERSION, remoteVersion)) {
        setStoredPwaVersion(BUNDLE_VERSION);
      }
    } catch (e) {}
    updateVersionDisplay();
    showUpdateBarIfNeeded(remoteVersion);
  }
  function esc(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  var SCROLL_NEAR_BOTTOM_PX = 80;
  var READING_POLL_DELAY_MS = 12000;

  function scrollContainerNearBottom(container, thresholdPx) {
    if (!container) return true;
    var threshold = typeof thresholdPx === "number" ? thresholdPx : SCROLL_NEAR_BOTTOM_PX;
    return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
  }

  function preserveScrollOnMutate(container, mutateFn, stickToBottom) {
    if (!container) {
      mutateFn();
      return;
    }
    var stick =
      stickToBottom === true || (stickToBottom !== false && scrollContainerNearBottom(container));
    var prevTop = container.scrollTop;
    var prevHeight = container.scrollHeight;
    mutateFn();
    if (stick) {
      container.scrollTop = container.scrollHeight;
    } else if (prevHeight > 0) {
      container.scrollTop = prevTop + (container.scrollHeight - prevHeight);
    }
  }

  function adjustScrollAfterContentGrowth(container, prevTop, prevHeight) {
    if (!container || prevHeight == null) return;
    container.scrollTop = prevTop + (container.scrollHeight - prevHeight);
  }

  function isDetailPageOpen() {
    var page = $("taskDetailPage");
    return !!(page && page.classList.contains("open"));
  }

  function isImagePreviewOpen() {
    var modal = $("imagePreviewModal");
    return !!(modal && modal.classList.contains("visible"));
  }

  function shouldPauseBackgroundPoll() {
    return document.hidden || isImagePreviewOpen() || isDetailPageOpen();
  }

  function getChatPollDelay() {
    var box = $("chatMessages");
    if (box && !scrollContainerNearBottom(box, SCROLL_NEAR_BOTTOM_PX + 40)) {
      return Math.max(state.chatPollDelay || 3000, READING_POLL_DELAY_MS);
    }
    return state.chatPollDelay || 3000;
  }

  function getActivityScrollEl() {
    var view = $("viewActivity");
    return view ? view.querySelector(".tab-scroll") : null;
  }

  function getActivityPollDelay() {
    var scrollEl = getActivityScrollEl();
    if (scrollEl && scrollEl.scrollTop > SCROLL_NEAR_BOTTOM_PX) {
      return Math.max(state.activityPollDelay || 3000, READING_POLL_DELAY_MS);
    }
    return state.activityPollDelay || 3000;
  }

  function chatMessagesFingerprint(rows) {
    if (!rows || !rows.length) return "empty";
    return rows
      .map(function (m) {
        var attach = Array.isArray(m.attachments)
          ? m.attachments
              .map(function (a) {
                return String(a.sha256 || a.local_path || a.localPath || a.original_name || "");
              })
              .join(",")
          : "";
        return [m.role, m.created_at, m.content, m.agentId || "", attach].join("|");
      })
      .join("\n");
  }

  function activityDataFingerprint(rows) {
    if (!rows || !rows.length) return "empty";
    return rows
      .map(function (ev) {
        return [ev.id, ev.ts || ev.created_at, ev.kind || ev.type, ev.summary || ev.title || ""].join("|");
      })
      .join("\n");
  }

  function activityRenderFingerprint(rows, loadError) {
    return activityDataFingerprint(rows) + "|err:" + (loadError || "");
  }

  /** Inline Markdown: bold, italic, code, links (input escaped first). */
  function inlineMd(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_m, label, url) {
        var u = String(url).trim();
        if (!/^https?:\/\//i.test(u) && !/^mailto:/i.test(u)) {
          return esc("[" + label + "](" + url + ")");
        }
        return (
          '<a class="md-link" href="' +
          esc(u) +
          '" target="_blank" rel="noopener noreferrer">' +
          label +
          "</a>"
        );
      });
  }

  /** Lightweight Markdown → HTML (aligned with desktop panel renderer). */
  function renderMarkdown(text) {
    if (!text) return "";
    var raw = String(text);
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    if (/^---\r?\n/.test(raw)) {
      var fmEnd = raw.indexOf("\n---", 4);
      if (fmEnd !== -1) raw = raw.slice(fmEnd + 4).replace(/^\r?\n/, "");
    }
    var lines = raw.split("\n");
    var out = "";
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) {
        var lang = line.slice(3).trim();
        var codeLines = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;
        var codeText = codeLines.join("\n");
        out +=
          '<pre class="md-pre"' +
          (lang ? ' data-lang="' + esc(lang) + '"' : "") +
          "><code>" +
          esc(codeText) +
          "</code></pre>\n";
        continue;
      }
      if (/^#{1,4}\s/.test(line)) {
        var level = line.match(/^(#+)/)[1].length;
        out += "<h" + level + ' class="md-h' + level + '">' + inlineMd(line.replace(/^#+\s*/, "")) + "</h" + level + ">\n";
        i++;
        continue;
      }
      if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) {
        var isOrdered = /^\d+\.\s/.test(line);
        var tag = isOrdered ? "ol" : "ul";
        out += "<" + tag + ' class="md-list">\n';
        while (i < lines.length && (/^[-*]\s/.test(lines[i]) || /^\d+\.\s/.test(lines[i]))) {
          var item = lines[i].replace(/^[-*]\s*/, "").replace(/^\d+\.\s*/, "");
          out += "<li>" + inlineMd(item) + "</li>\n";
          i++;
        }
        out += "</" + tag + ">\n";
        continue;
      }
      if (/^>\s/.test(line)) {
        out += '<blockquote class="md-quote">';
        while (i < lines.length && /^>\s/.test(lines[i])) {
          out += "<p>" + inlineMd(lines[i].replace(/^>\s*/, "")) + "</p>";
          i++;
        }
        out += "</blockquote>\n";
        continue;
      }
      if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
        out += '<hr class="md-hr" />\n';
        i++;
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && /^\|?[\s\-:|]+\|/.test(lines[i + 1])) {
        var tableLines = [];
        while (i < lines.length && lines[i].includes("|")) {
          tableLines.push(lines[i]);
          i++;
        }
        if (tableLines.length >= 2) {
          var parseRow = function (row) {
            return row
              .replace(/^\|/, "")
              .replace(/\|$/, "")
              .split("|")
              .map(function (c) {
                return c.trim();
              });
          };
          var headers = parseRow(tableLines[0]);
          var bodyRows = tableLines.slice(2);
          out += '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
          headers.forEach(function (h) {
            out += "<th>" + inlineMd(h) + "</th>";
          });
          out += "</tr></thead><tbody>";
          bodyRows.forEach(function (row) {
            out += "<tr>";
            parseRow(row).forEach(function (c) {
              out += "<td>" + inlineMd(c) + "</td>";
            });
            out += "</tr>";
          });
          out += "</tbody></table></div>\n";
        }
        continue;
      }
      if (!line.trim()) {
        out += "<br class=\"md-br\" />\n";
        i++;
        continue;
      }
      out += '<p class="md-p">' + inlineMd(line) + "</p>\n";
      i++;
    }
    return out;
  }

  function setFpMarkdown(raw) {
    var el = $("fpMarkdown");
    if (!el) return;
    var src = raw == null ? "" : String(raw);
    if (!src.trim()) {
      el.innerHTML = '<p class="md-empty">(empty)</p>';
      return;
    }
    el.innerHTML = renderMarkdown(src);
  }

  function showToast(msg, ms, kind) {
    var c = $("toastContainer");
    if (!c) return;
    var el = document.createElement("div");
    el.className = "toast-item";
    if (kind === "error") el.classList.add("toast-item-error");
    else if (kind === "ok") el.classList.add("toast-item-ok");
    el.textContent = msg;
    c.appendChild(el);
    var duration = ms != null ? ms : kind === "error" ? 6000 : 2600;
    setTimeout(function () {
      el.classList.add("fade-out");
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 320);
    }, duration);
  }

  function parseApiErrorText(errText, status) {
    try {
      var j = JSON.parse(errText);
      return j.error || j.message || errText;
    } catch (e) {
      return status + " " + (errText || "").slice(0, 120);
    }
  }

  function parseApiErrorPayload(errText, status) {
    try {
      var j = JSON.parse(errText);
      return {
        error: j.error || j.message || "",
        layer: j.layer || "",
        actual_bytes: j.actual_bytes,
        max_bytes: j.max_bytes,
        status: status,
      };
    } catch (e) {
      return { error: String(errText || ""), layer: "", status: status };
    }
  }

  function format413Error(payload) {
    if (!payload) return "";
    if (payload.error === "ATTACHMENT_TOO_LARGE" && payload.layer === "shell") {
      return t("errorAttachmentTooLarge");
    }
    if (payload.error === "BODY_TOO_LARGE") {
      return t("errorGatewayBodyTooLarge");
    }
    if (payload.error) {
      var detail = payload.error;
      if (payload.actual_bytes != null && payload.max_bytes != null) {
        detail += " (" + payload.actual_bytes + "/" + payload.max_bytes + ")";
      }
      return detail;
    }
    return "";
  }

  function userFacingError(err) {
    if (err && err.apiError && err.apiError.status === 413) {
      var formatted = format413Error(err.apiError);
      if (formatted) return formatted;
    }
    var raw = String(err && err.message ? err.message : err || "");
    if (raw.indexOf("UNSUPPORTED_IMAGE_MIME") >= 0 || /:\s*415\b/.test(raw)) {
      return t("errorUnsupportedImageMime");
    }
    if (raw.indexOf("UPLOAD_FAILED") >= 0) {
      return t("errorUploadFailed");
    }
    if (raw.indexOf("CHILD_TASKS_OPEN") >= 0) {
      return t("childTasksOpen");
    }
    var stripped = raw.replace(/^\/api\/[^\s]+:\s*\d+\s*/, "");
    if (stripped && stripped !== raw) return stripped;
    return raw;
  }

  function showErrorToast(errOrMsg, ms) {
    var msg =
      errOrMsg && typeof errOrMsg === "object" && errOrMsg.message
        ? userFacingError(errOrMsg)
        : userFacingError({ message: String(errOrMsg || "") });
    showToast(msg, ms != null ? ms : 6500, "error");
  }
  function t(key, vars) {
    if (window.CFM_I18N && window.CFM_I18N.t) return window.CFM_I18N.t(key, vars);
    return key;
  }
  function applyI18n() {
    if (window.CFM_I18N && window.CFM_I18N.applyI18n) window.CFM_I18N.applyI18n(document);
    var activeLang = window.CFM_I18N && window.CFM_I18N.getLang ? window.CFM_I18N.getLang() : "zh";
    if ($("langZhBtn")) $("langZhBtn").classList.toggle("active", activeLang === "zh");
    if ($("langEnBtn")) $("langEnBtn").classList.toggle("active", activeLang === "en");
    syncTasksListCollapsedUI();
  }

  function isBound() {
    return !!getToken();
  }

  async function api(path, opts) {
    opts = opts || {};
    var method = String(opts.method || "GET").toUpperCase();
    var base = getApiBase().replace(/\/$/, "");
    var uiLang = window.CFM_I18N && window.CFM_I18N.getLang ? window.CFM_I18N.getLang() : "zh";
    var headers = Object.assign({
      Accept: "application/json",
      "Accept-Language": uiLang === "en" ? "en" : "zh-CN",
      "X-CodeFlowMu-UI-Lang": uiLang,
    }, opts.headers || {});
    if (opts.body && !headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
    var token = getToken();
    if (token) headers.Authorization = "Bearer " + token;
    var res;
    try {
      res = await fetch(base + path, {
        method: method,
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
      });
    } catch (e) {
      throw new Error(t("toastNetwork"));
    }
    if (res.status === 401) {
      if (!bindingInProgress && Date.now() > bindGraceUntil) {
        clearSession();
        state.bootstrap = unboundBootstrap();
        state.tasks = [];
        state.reports = [];
        state.approvals = [];
        updateTabBoundState();
        showToast(t("authExpired"));
      }
      throw new Error(method + " " + path + ": 401");
    }
    if (!res.ok) {
      var errText = await res.text().catch(function () {
        return "";
      });
      var code = String(parseApiErrorText(errText, res.status) || "");
      var errMsg = method + " " + path + ": " + res.status + " " + (code || "HTTP_ERROR");
      if (
        res.status === 403 &&
        (code === "MOBILE_AUTH_REQUIRED" || code === "MOBILE_AUTH_FORBIDDEN")
      ) {
        if (!bindingInProgress && Date.now() > bindGraceUntil) {
          clearSession();
          state.bootstrap = unboundBootstrap();
          state.tasks = [];
          state.reports = [];
          state.approvals = [];
          updateTabBoundState();
          showToast(t("authExpired"));
        }
        throw new Error(method + " " + path + ": 401");
      }
      if (res.status === 403 && (code === "FORBIDDEN" || String(code).indexOf("FORBIDDEN") >= 0)) {
        throw new Error(
          t("gatewayDenied", {
            method: method,
            path: path,
            version: state.bootstrap && state.bootstrap.gateway_allowlist_version,
          }),
        );
      }
      var err = new Error(errMsg);
      if (res.status === 413) {
        err.apiError = parseApiErrorPayload(errText, res.status);
      }
      throw err;
    }
    var ct = res.headers.get("content-type") || "";
    if (ct.indexOf("application/json") >= 0) return res.json();
    return res.text();
  }

  async function fileToBase64(file) {
    if (!file) throw new Error("NO_FILE");
    return new Promise(function (resolve, reject) {
      try {
        var reader = new FileReader();
        reader.onerror = function () {
          reject(new Error("FILE_READER_ERROR"));
        };
        reader.onload = function () {
          var result = reader.result || "";
          // result is usually: data:<mime>;base64,<base64>
          var s = String(result);
          var idx = s.indexOf("base64,");
          resolve(idx >= 0 ? s.slice(idx + "base64,".length) : s);
        };
        reader.readAsDataURL(file);
      } catch (e) {
        reject(e);
      }
    });
  }

  function getAllowedImageMime(mime, filename) {
    var m = String(mime || "").toLowerCase().trim();
    if (m === "image/jpg" || m === "image/pjpeg") m = "image/jpeg";
    if (!m && filename) {
      var lower = String(filename).toLowerCase();
      if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) m = "image/jpeg";
      else if (lower.endsWith(".png")) m = "image/png";
      else if (lower.endsWith(".webp")) m = "image/webp";
    }
    if (m === "image/jpeg" || m === "image/png" || m === "image/webp") return m;
    return "";
  }

  var MOBILE_UPLOAD_MAX_IMAGES = 3;
  var MOBILE_UPLOAD_MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
  var MOBILE_UPLOAD_TARGET_BYTES = 1024 * 1024;
  var MOBILE_IMAGE_MAX_EDGE = 1600;
  var MOBILE_IMAGE_JPEG_QUALITY = 0.75;

  function formatFileSize(bytes) {
    var n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n < 1024) return n + "B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + "KB";
    var mb = n / (1024 * 1024);
    var s = mb.toFixed(1);
    if (s.endsWith(".0")) s = s.slice(0, -2);
    return s + "MB";
  }

  function jpegFilenameFromOriginal(name) {
    var base = String(name || "image").split(/[/\\]/).pop() || "image";
    var dot = base.lastIndexOf(".");
    var stem = dot > 0 ? base.slice(0, dot) : base;
    return stem + ".jpg";
  }

  function isImageFileForMobileUpload(file) {
    if (!file) return false;
    if (getAllowedImageMime(file.type, file.name)) return true;
    return String(file.type || "").toLowerCase().indexOf("image/") === 0;
  }

  function loadImageElementFromFile(file) {
    return new Promise(function (resolve, reject) {
      var url = "";
      try {
        url = URL.createObjectURL(file);
      } catch (e) {
        reject(e);
        return;
      }
      var img = new Image();
      img.onload = function () {
        try {
          URL.revokeObjectURL(url);
        } catch (e2) {}
        resolve(img);
      };
      img.onerror = function () {
        try {
          URL.revokeObjectURL(url);
        } catch (e2) {}
        reject(new Error("IMAGE_DECODE_FAILED"));
      };
      img.src = url;
    });
  }

  async function loadBitmapFromFile(file) {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(file);
      } catch (e) {
        /* fall through to Image */
      }
    }
    var img = await loadImageElementFromFile(file);
    return { width: img.naturalWidth, height: img.naturalHeight, _img: img };
  }

  function canvasToJpegBlob(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(
        function (blob) {
          if (!blob) reject(new Error("BLOB_FAILED"));
          else resolve(blob);
        },
        "image/jpeg",
        quality,
      );
    });
  }

  async function compressImageForMobileUpload(file) {
    var originalBytes = file && file.size != null ? file.size : 0;
    var bitmap = await loadBitmapFromFile(file);
    var w = bitmap.width;
    var h = bitmap.height;
    var imgEl = bitmap._img || null;
    var maxEdge = MOBILE_IMAGE_MAX_EDGE;
    var scale = 1;
    if (w > maxEdge || h > maxEdge) {
      scale = maxEdge / Math.max(w, h);
    }
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));
    var allowedMime = getAllowedImageMime(file.type, file.name);
    if (originalBytes < MOBILE_UPLOAD_TARGET_BYTES && allowedMime === "image/jpeg" && scale >= 1) {
      var passUrl = "";
      try {
        passUrl = URL.createObjectURL(file);
      } catch (e) {}
      return {
        file: file,
        originalBytes: originalBytes,
        compressedBytes: originalBytes,
        previewUrl: passUrl,
        skippedCompression: true,
      };
    }
    var canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("NO_CANVAS_CTX");
    if (imgEl) {
      ctx.drawImage(imgEl, 0, 0, cw, ch);
    } else {
      ctx.drawImage(bitmap, 0, 0, cw, ch);
      if (typeof bitmap.close === "function") {
        try {
          bitmap.close();
        } catch (e) {}
      }
    }
    var quality = MOBILE_IMAGE_JPEG_QUALITY;
    var blob = await canvasToJpegBlob(canvas, quality);
    while (blob.size > MOBILE_UPLOAD_TARGET_BYTES && quality > 0.45) {
      quality -= 0.1;
      blob = await canvasToJpegBlob(canvas, quality);
    }
    var outName = jpegFilenameFromOriginal(file.name);
    var outFile = new File([blob], outName, {
      type: "image/jpeg",
      lastModified: file.lastModified || Date.now(),
    });
    var previewUrl = "";
    try {
      previewUrl = URL.createObjectURL(outFile);
    } catch (e) {}
    return {
      file: outFile,
      originalBytes: originalBytes,
      compressedBytes: outFile.size,
      previewUrl: previewUrl,
      skippedCompression: false,
    };
  }

  function revokePendingAttachPreviews(arr) {
    if (!Array.isArray(arr)) return;
    arr.forEach(function (p) {
      if (p && p.previewUrl) {
        try {
          URL.revokeObjectURL(p.previewUrl);
        } catch (e) {}
      }
    });
  }

  function buildPendingAttachItemHtml(p, idx) {
    var url = p && p.previewUrl ? p.previewUrl : "";
    var name = (p && p.file && p.file.name) || "image";
    var orig = formatFileSize(
      p && p.originalBytes != null ? p.originalBytes : p && p.file ? p.file.size : 0,
    );
    var comp = formatFileSize(
      p && p.compressedBytes != null ? p.compressedBytes : p && p.file ? p.file.size : 0,
    );
    return (
      '<div class="pending-attach-item">' +
      '<img src="' +
      esc(url) +
      '" alt="' +
      esc(name) +
      '" />' +
      '<div class="pending-attach-size">' +
      '<span class="pending-attach-size-line">' +
      esc(t("imageAttachOriginal")) +
      orig +
      "</span>" +
      '<span class="pending-attach-size-line">' +
      esc(t("imageAttachCompressed")) +
      comp +
      "</span>" +
      "</div>" +
      '<button type="button" class="pending-attach-del" data-index="' +
      idx +
      '" aria-label="remove">×</button>' +
      "</div>"
    );
  }

  async function syncMobileAttachFilesFromInput(inputId, stateKey, renderFn) {
    var input = $(inputId);
    if (!input) return;
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return;
    if (files.length > MOBILE_UPLOAD_MAX_IMAGES) {
      showErrorToast(t("errorImageMaxCount"));
      files = files.slice(0, MOBILE_UPLOAD_MAX_IMAGES);
    }
    revokePendingAttachPreviews(state[stateKey]);
    var pending = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f) continue;
      if (!isImageFileForMobileUpload(f)) {
        showErrorToast(t("errorUnsupportedImageMime"));
        continue;
      }
      try {
        var result = await compressImageForMobileUpload(f);
        if (result.compressedBytes > MOBILE_UPLOAD_MAX_COMPRESSED_BYTES) {
          showErrorToast(t("errorImageStillTooLarge"));
          if (result.previewUrl) {
            try {
              URL.revokeObjectURL(result.previewUrl);
            } catch (e) {}
          }
          continue;
        }
        pending.push({
          file: result.file,
          previewUrl: result.previewUrl,
          originalBytes: result.originalBytes,
          compressedBytes: result.compressedBytes,
        });
      } catch (e) {
        showErrorToast(t("errorImageProcessFailed"));
      }
    }
    state[stateKey] = pending;
    renderFn();
  }

  async function uploadPendingAttachments(pendingAttachments) {
    if (!Array.isArray(pendingAttachments) || pendingAttachments.length === 0) return [];
    var out = [];
    for (var i = 0; i < pendingAttachments.length; i++) {
      var p = pendingAttachments[i];
      var file = p && p.file ? p.file : p;
      if (!file) continue;
      var allowedMime = getAllowedImageMime(file.type, file.name);
      if (!allowedMime) throw new Error("UNSUPPORTED_IMAGE_MIME");
      var base64 = await fileToBase64(file);
      var resp = await api("/api/v2/mobile/attachments/upload", {
        method: "POST",
        body: { filename: file.name || "image", mime: allowedMime, data_base64: base64 },
      });
      if (!resp || resp.ok !== true || !resp.attachment) throw new Error(String(resp && resp.error ? resp.error : "UPLOAD_FAILED"));
      out.push(resp.attachment);
    }
    return out;
  }

  function setApiError(key, msg) {
    if (msg) state.apiErrors[key] = msg;
    else delete state.apiErrors[key];
    renderApiErrorBanner();
  }
  function clearApiError(key) {
    delete state.apiErrors[key];
    renderApiErrorBanner();
  }
  function renderApiErrorBanner() {
    var el = $("apiErrorBanner");
    if (!el) return;
    var msgs = Object.keys(state.apiErrors)
      .filter(function (k) {
        return state.apiErrors[k];
      })
      .map(function (k) {
        return state.apiErrors[k];
      });
    if (!msgs.length) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    el.textContent = t("apiLoadFailed") + ": " + msgs.join(" · ");
  }
  function updateOfflineBanner() {
    var el = $("offlineBanner");
    if (!el) return;
    el.classList.toggle("hidden", state.online !== false);
  }
  /* ── normalizers ── */
  function normalizeBootstrap(raw) {
    if (!raw) return unboundBootstrap();
    return {
      bound: true,
      instance_id: raw.instance_id || raw.device_id || "—",
      pc_online: raw.status ? raw.status.pc_online === true : raw.pc_online === true,
      gateway_online: raw.status ? raw.status.gateway_online === true : raw.gateway_online === true,
      access_mode: raw.access_mode || (getApiBase().indexOf("3847") >= 0 ? "LAN" : "Gateway"),
      stats: Object.assign({}, EMPTY_STATS),
      summary: raw.summary && typeof raw.summary === "object" ? raw.summary : {},
      roles: normalizeTeamRoles(raw.roles),
      leader: String(raw.leader || raw.team_leader || "PM").toUpperCase(),
    };
  }

  function normalizeTeamRoles(rawRoles) {
    var byCode = {};
    if (Array.isArray(rawRoles)) {
      rawRoles.forEach(function (r) {
        var code = String(r.code || r.role || r).toUpperCase();
        if (ROLES.indexOf(code) >= 0) {
          byCode[code] = String(r.state || r.status || "offline").toLowerCase();
        }
      });
    }
    return ROLES.map(function (code) {
      return { code: code, state: byCode[code] || "offline" };
    });
  }

  function localYmdFromDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function parseIsoDay(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return localYmdFromDate(d);
  }

  function todayLocalIso() {
    return localYmdFromDate(new Date());
  }

  function todayLocalYmdCompact() {
    return todayLocalIso().replace(/-/g, "");
  }

  function mergeBootstrapSummaryStats(stats, summary) {
    if (!summary || typeof summary !== "object") return stats;
    if (typeof summary.reports_today === "number") stats.today_reports = summary.reports_today;
    return stats;
  }

  function computeStatsFromLists(tasks, reports) {
    var today = todayLocalIso();
    var todayCompact = todayLocalYmdCompact();
    var todayTasks = 0;
    var inProgress = 0;
    var done = 0;
    (tasks || []).forEach(function (task) {
      var created = parseIsoDay(task.created_at);
      var updated = parseIsoDay(task.updated_at);
      if (created === today || updated === today) todayTasks++;
      var st = String(task.status || "").toLowerCase();
      var bucket = String(task.bucket || "").toLowerCase();
      if (
        st === "active" ||
        st === "running" ||
        st === "in_progress" ||
        st === "doing" ||
        bucket === "active"
      ) {
        inProgress++;
      }
      if (
        st === "done" ||
        st === "completed" ||
        st === "archived" ||
        bucket === "done" ||
        bucket === "archive"
      ) {
        done++;
      }
    });
    var todayReports = 0;
    (reports || []).forEach(function (report) {
      var fn = String(report.filename || report.id || "");
      if (todayCompact && fn.indexOf(todayCompact) >= 0) {
        todayReports++;
        return;
      }
      if (parseIsoDay(report.updated_at || report.created_at) === today) todayReports++;
    });
    return {
      today_tasks: todayTasks,
      today_reports: todayReports,
      in_progress: inProgress,
      done: done,
    };
  }
  function unboundBootstrap() {
    return {
      bound: false,
      instance_id: "—",
      pc_online: false,
      gateway_online: false,
      access_mode: "Unbound",
      stats: Object.assign({}, EMPTY_STATS),
      roles: [],
      leader: "PM",
    };
  }
  function normalizeTask(row) {
    if (!row) return row;
    var fn = row.filename || row.id || row.task_id || "";
    return {
      kind: "task",
      id: fn,
      filename: fn,
      task_id: row.task_id || fn,
      title: row.title || row.subject || fn,
      status: String(row.status || row.display_status || row.bucket || "todo").toLowerCase(),
      sender: row.from || row.sender || "—",
      recipient: row.to || row.recipient || "—",
      owner_role: row.owner_role || row.owner || "",
      bucket: row.bucket || row.scope || row.stage || "—",
      review_status: row.review_status || row.reviewStatus || "",
      priority: row.priority || "",
      created_at: row.created_at || row.ctime || "",
      updated_at: row.updated_at || row.mtime || "",
      parent: row.parent || row.parent_task_id || (row.yaml && row.yaml.parent) || "",
      parent_task_id: row.parent_task_id || row.parent || (row.yaml && row.yaml.parent) || "",
      body: row.body || "",
    };
  }
  function normalizeReport(row) {
    if (!row) return row;
    var fn = row.filename || row.report_id || "";
    return {
      kind: "report",
      id: fn,
      filename: fn,
      report_id: row.report_id || fn,
      title: row.title || row.subject || row.preview || fn,
      status: String(row.status || "done").toLowerCase(),
      sender: row.from || row.sender || row.reporter || "—",
      recipient: row.to || row.recipient || "—",
      priority: row.priority || "",
      task_id: row.task_id || "",
      summary: row.summary || row.preview || "",
      report_type: row.report_type || "",
      report_kind: row.report_kind || "",
      updated_at: row.updated_at || row.created_at || "",
      created_at: row.created_at || "",
      body: row.body || "",
    };
  }
  function normalizeApproval(row) {
    if (!row) return row;
    var fn = row.filename || row.approval_id || "";
    var kind = "approval";
    var resolved = String(row.resolved_decision || row.status || row.decision || "pending").toLowerCase();
    if (resolved === "approve") resolved = "approved";
    if (resolved === "reject") resolved = "rejected";
    return {
      kind: kind,
      id: fn,
      filename: fn,
      title: row.title || row.summary || row.preview || fn,
      status: resolved,
      sender: row.from || row.sender || row.reviewer || "—",
      recipient: row.to || row.recipient || "ADMIN",
      approval_type: row.approval_type || row.decision || "",
      can_approve: row.can_approve !== false,
      material_missing: !!row.material_missing,
      execution_status: row.execution_status || (row.execution && row.execution.status) || "not_started",
      updated_at: row.updated_at || "",
      body: row.body || "",
      preview: row.preview || "",
      summary: row.summary || "",
    };
  }

  function clearBoundData() {
    state.bootstrap = unboundBootstrap();
    state.tasks = [];
    state.reports = [];
    state.approvals = [];
    state.activityEvents = [];
    state.activityLoadError = null;
    Object.keys(state.apiErrors).forEach(function (k) {
      delete state.apiErrors[k];
    });
  }

  function setLight(el, on) {
    if (!el) return;
    el.classList.toggle("ok", !!on);
  }
  function updateStatusLights(bs) {
    bs = bs || state.bootstrap || {};
    if (!isBound()) {
      setLight($("dotPc"), false);
      setLight($("dotGw"), false);
      return;
    }
    setLight($("dotPc"), bs.pc_online === true);
    setLight($("dotGw"), bs.gateway_online === true);
  }

  function updateTabBoundState() {
    var bound = isBound();
    var tab = state.tab || "home";
    var banner = $("bindBanner");
    if (banner) banner.classList.toggle("hidden", bound || tab !== "home");
    [
      ["tasksUnboundPanel", "tasksBoundContent"],
      ["reportsUnboundPanel", "reportsBoundContent"],
      ["approvalsUnboundPanel", "approvalsBoundContent"],
      ["activityUnboundPanel", "activityBoundContent"],
    ].forEach(function (pair) {
      var panel = $(pair[0]);
      var main = $(pair[1]);
      if (panel) panel.classList.toggle("hidden", bound);
      if (main) main.classList.toggle("hidden", !bound);
    });
    try {
      document.documentElement.setAttribute("data-bound", bound ? "1" : "0");
      document.documentElement.setAttribute("data-tab", tab);
    } catch (e) {}
  }

  function updateStats(tasks, bs) {
    if (!isBound()) {
      $("todayTasks").textContent = "0";
      $("todayReplies").textContent = "0";
      $("inProgressThreads").textContent = "0";
      $("repliedThreads").textContent = "0";
      return;
    }
    var stats = (bs && bs.stats) || computeStatsFromLists(tasks || state.tasks, state.reports);
    if (bs) bs.stats = stats;
    $("todayTasks").textContent = String(stats.today_tasks);
    $("todayReplies").textContent = String(stats.today_reports);
    $("inProgressThreads").textContent = String(stats.in_progress);
    $("repliedThreads").textContent = String(stats.done);
  }

  function roleStateLabel(st) {
    st = String(st || "offline").toLowerCase();
    if (st === "online" || st === "idle") return t("roleOnline");
    if (st === "busy" || st === "running" || st === "active") return t("roleBusy");
    if (st === "blocked" || st === "waiting" || st === "waiting_pm_attention") return t("roleWaiting");
    if (st === "offline" || st === "missing" || st === "unknown") return t("roleOffline");
    return t("roleOffline");
  }
  function roleCodeFromField(val) {
    return String(val || "")
      .split(".")[0]
      .toUpperCase();
  }

  function parseTaskFilenameParts(filename) {
    var base = String(filename || "").replace(/^.*[\\/]/, "");
    var m = base.match(/^TASK-(\d{8})-(\d{3})-([A-Z][A-Z0-9_-]*)-to-([A-Z][A-Z0-9_.-]*)(?:\.md)?$/i);
    if (!m) return null;
    return {
      date: m[1],
      seq: m[2],
      sender: m[3].toUpperCase(),
      recipient: m[4].toUpperCase(),
    };
  }

  function taskRecipientCode(item) {
    if (!item) return "";
    var fromFields = roleCodeFromField(item.recipient || item.to);
    if (fromFields && fromFields !== "—") return fromFields;
    var parsed = parseTaskFilenameParts(item.filename || item.task_id || item.id);
    if (!parsed) return "";
    var recipient = parsed.recipient;
    var dot = recipient.indexOf(".");
    return dot >= 0 ? recipient.slice(0, dot) : recipient;
  }

  function taskSenderCode(item) {
    if (!item) return "";
    var fromFields = roleCodeFromField(item.sender || item.from);
    if (fromFields && fromFields !== "—") return fromFields;
    var parsed = parseTaskFilenameParts(item.filename || item.task_id || item.id);
    return parsed ? parsed.sender : "";
  }

  function formatTaskTimeMinute(value, item) {
    var raw = String(value || "").trim();
    if (!raw && item) {
      var parts = parseTaskFilenameParts(item.filename || item.task_id || item.id);
      if (parts) {
        return (
          parts.date.slice(0, 4) +
          "-" +
          parts.date.slice(4, 6) +
          "-" +
          parts.date.slice(6, 8) +
          " " +
          parts.seq
        );
      }
    }
    if (!raw) return "—";
    var d = new Date(raw);
    if (isNaN(d.getTime())) return raw.length > 16 ? raw.slice(0, 16) : raw;
    var pad = function (n) {
      return n < 10 ? "0" + n : String(n);
    };
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }

  function taskSortKey(item) {
    if (!item) return "";
    var updated = String(item.updated_at || item.mtime || "").trim();
    if (updated) return updated;
    var created = String(item.created_at || item.ctime || "").trim();
    if (created) return created;
    var parts = parseTaskFilenameParts(item.filename || item.task_id || item.id);
    if (parts) return parts.date + "T" + parts.seq;
    return String(item.filename || item.id || "");
  }

  function sortTasksNewestFirst(rows) {
    return rows.slice().sort(function (a, b) {
      return taskSortKey(b).localeCompare(taskSortKey(a));
    });
  }
  function loadSelectedRole() {
    try {
      var saved = localStorage.getItem(SELECTED_ROLE_KEY);
      if (saved && String(saved).trim()) {
        state.selectedRole = String(saved).trim().toUpperCase();
      }
    } catch (_e) {
      /* ignore */
    }
  }

  function persistSelectedRole(role) {
    var r = roleCodeFromField(role || state.selectedRole || "PM");
    state.selectedRole = r;
    try {
      localStorage.setItem(SELECTED_ROLE_KEY, r);
    } catch (_e2) {
      /* ignore */
    }
    var target = $("targetRole");
    if (target && Array.from(target.options).some(function (o) { return o.value === r; })) {
      target.value = r;
    }
    updateHomeViewAllLabel();
    renderTeam(state.bootstrap);
    renderTaskLists();
  }

  function getTeamLeader() {
    var b = state.bootstrap || {};
    return roleCodeFromField(b.leader || "PM");
  }

  function taskRolesForItem(task) {
    if (!task) return [];
    var roles = [];
    var sender = roleCodeFromField(task.sender);
    var recipient = roleCodeFromField(task.recipient);
    var owner = roleCodeFromField(task.owner_role);
    if (sender) roles.push(sender);
    if (recipient) roles.push(recipient);
    if (owner) roles.push(owner);
    return roles;
  }

  function tasksForRole(role) {
    var r = roleCodeFromField(role);
    if (!r) return [];
    return state.tasks.filter(function (task) {
      return taskRecipientCode(task) === r;
    });
  }

  function itemMatchesSelectedRole(item, role) {
    var r = roleCodeFromField(role || state.selectedRole || "PM");
    if (!item || !r) return false;
    if ((item.kind || "task") === "report") {
      var to = roleCodeFromField(item.recipient);
      var from = roleCodeFromField(item.sender);
      return to === r || from === r;
    }
    return taskRecipientCode(item) === r;
  }

  function homePreviewItems() {
    if (!isBound()) return [];
    var role = roleCodeFromField(state.selectedRole || "PM");
    var items = state.tasks.filter(function (t) {
      if (!itemMatchesSelectedRole(t, role)) return false;
      if (role === "PM") return isTopLevelListTask(t, state.tasks);
      return true;
    });
    items.sort(function (a, b) {
      return String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""));
    });
    return items.slice(0, 2);
  }

  function updateHomeViewAllLabel() {
    var btn = $("homeViewAllBtn");
    if (!btn) return;
    var role = roleCodeFromField(state.selectedRole || "PM");
    btn.textContent = role + " ›";
  }

  function selectHomeRole(role) {
    var r = roleCodeFromField(role || state.selectedRole || "PM");
    persistSelectedRole(r);
    state.selectedRole = r;
    renderTeam(state.bootstrap);
    renderTaskLists();
    syncTaskSendRecipient(state.bootstrap);
  }

  async function openTasksForSelectedRole(role) {
    var r = roleCodeFromField(role || state.selectedRole || "PM");
    persistSelectedRole(r);
    state.tasksRoleFilter = r;
    updateTasksRoleFilterLabel();
    switchTab("tasks", { keepRoleFilter: true });
    if (isBound()) {
      await loadTasks();
      renderTaskLists();
    }
  }

  function updateTasksRoleFilterLabel() {
    var el = $("tasksRoleFilterLabel");
    if (!el) return;
    var filter = state.tasksRoleFilter;
    if (!filter) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    el.classList.remove("hidden");
    el.textContent = roleCodeFromField(filter) + " ›";
  }

  function refreshTargetOptions() {
    var sel = $("targetRole");
    if (!sel) return;
    var roles = normalizeTeamRoles(state.bootstrap && state.bootstrap.roles);
    var current = roleCodeFromField(state.selectedRole || "PM");
    sel.innerHTML = "";
    roles.forEach(function (role) {
      var code = role.code;
      var o = document.createElement("option");
      o.value = code;
      o.textContent = code;
      sel.appendChild(o);
    });
    if (Array.from(sel.options).some(function (o) { return o.value === current; })) {
      sel.value = current;
    } else if (sel.options.length) {
      sel.selectedIndex = 0;
      state.selectedRole = sel.value;
    }
  }

  function syncTaskSendRecipient(bs) {
    refreshTargetOptions();
    updateHomeViewAllLabel();
  }

  function renderTeam(bs) {
    var host = $("teamList");
    var tc = $("teamCount");
    if (!host) return;
    if (!isBound()) {
      host.innerHTML = "";
      if (tc) tc.textContent = "0";
      return;
    }
    var roles = normalizeTeamRoles(bs && bs.roles);
    if (tc) tc.textContent = t("teamCount", { n: roles.length });
    var leader = getTeamLeader();
    var selected = roleCodeFromField(state.selectedRole || "PM");
    host.innerHTML = roles
      .map(function (r) {
        var code = r.code;
        var st = r.state || "offline";
        var stateCls =
          st === "offline" || st === "missing" || st === "unknown"
            ? " state-offline"
            : st === "busy" || st === "running" || st === "active"
              ? " state-busy"
              : st === "online" || st === "idle"
                ? " state-online"
                : "";
        var activeCls = code === selected ? " active" : "";
        return (
          '<button type="button" class="team-icon-card role-card' +
          stateCls +
          activeCls +
          '" data-role="' +
          esc(code) +
          '">' +
          '<span class="team-icon" data-len="' +
          code.length +
          '">' +
          esc(code) +
          (code === leader ? '<span class="team-leader-star">★</span>' : "") +
          "</span>" +
          '<span class="team-role-name">' +
          esc(code) +
          "</span>" +
          '<span class="team-role-state">' +
          esc(roleStateLabel(st)) +
          "</span></button>"
        );
      })
      .join("");
    host.querySelectorAll(".team-icon-card[data-role]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectHomeRole(btn.getAttribute("data-role"));
      });
    });
    syncTaskSendRecipient(bs);
  }

  function statusBadgeClass(st, kind) {
    st = (st || "todo").toLowerCase();
    if (st === "blocked") return "blocked";
    if (st === "failed") return "failed";
    if (kind === "approval") {
      if (st === "approved") return "done";
      if (st === "rejected") return "failed";
      if (st === "needs_eval") return "doing";
      return "todo";
    }
    if (st === "done" || st === "completed") return "done";
    if (st === "doing" || st === "active" || st === "in_progress") return "doing";
    return "todo";
  }

  function taskIdFromItem(item) {
    var fn = String(item.task_id || item.filename || item.id || "").replace(/\.md$/i, "");
    var m = fn.match(/TASK-\d{8}-\d{3}/);
    return m ? m[0] : "";
  }
  function taskParentIdFromItem(item) {
    var raw = String(item.parent_task_id || item.parent || "").trim();
    var m = raw.match(/TASK-\d{8}-\d{3}/);
    return m ? m[0] : "";
  }
  /** Pull parent-linked children into visible pool (parent_task_id chain, not thread_key). */
  function expandTasksWithParentLinkedChildren(visibleTasks, fullList) {
    var src = fullList || state.tasks || [];
    var idSet = {};
    var seen = {};
    (visibleTasks || []).forEach(function (t) {
      var id = taskIdFromItem(t);
      if (id) {
        idSet[id] = true;
        seen[id] = true;
      }
    });
    var out = (visibleTasks || []).slice();
    var changed = true;
    while (changed) {
      changed = false;
      src.forEach(function (f) {
        var id = taskIdFromItem(f);
        if (!id || seen[id]) return;
        var pid = taskParentIdFromItem(f);
        if (pid && idSet[pid]) {
          out.push(f);
          seen[id] = true;
          idSet[id] = true;
          changed = true;
        }
      });
    }
    return out;
  }
  /** Hide nested rows when parent is in the same pool (tree shows them indented). */
  function isTopLevelListTask(item, pool) {
    var parentId = taskParentIdFromItem(item);
    if (!parentId) return true;
    var src = pool || state.tasks || [];
    return !src.some(function (t) {
      return taskIdFromItem(t) === parentId;
    });
  }
  function taskSeqNumForItem(item) {
    var parts = parseTaskFilenameParts(item.filename || item.task_id || item.id);
    return parts ? parseInt(parts.seq, 10) || 0 : 0;
  }
  /** parent_task_id tree (not thread_key). Orphans become roots. */
  function buildTaskTreeFromItems(tasks) {
    var byId = {};
    (tasks || []).forEach(function (item) {
      var id = taskIdFromItem(item);
      if (!id) return;
      byId[id] = { task: item, taskId: id, children: [] };
    });
    var roots = [];
    Object.keys(byId).forEach(function (id) {
      var node = byId[id];
      var parentId = taskParentIdFromItem(node.task);
      if (parentId && byId[parentId]) byId[parentId].children.push(node);
      else roots.push(node);
    });
    function sortNodes(nodes) {
      nodes.sort(function (a, b) {
        return taskSeqNumForItem(a.task) - taskSeqNumForItem(b.task);
      });
      nodes.forEach(function (n) {
        if (n.children.length) sortNodes(n.children);
      });
    }
    sortNodes(roots);
    return roots;
  }
  function flattenTaskTreeFromItems(roots, depth, out) {
    var d = depth == null ? 0 : depth;
    var acc = out || [];
    (roots || []).forEach(function (node) {
      acc.push({ task: node.task, depth: d, taskId: node.taskId });
      if (node.children && node.children.length) flattenTaskTreeFromItems(node.children, d + 1, acc);
    });
    return acc;
  }

  function itemCardHtmlFlat(item) {
    return itemCardHtml(item, 0);
  }

  function itemCardHtml(item, depth) {
    depth = depth || 0;
    var kind = item.kind || "task";
    var id = item.filename || item.id || "—";
    var title = item.title || id;
    var st = item.status || item.bucket || "todo";
    var alertCls = st === "blocked" || st === "failed" ? " card-alert" : "";
    var sender = item.sender || taskSenderCode(item) || "—";
    var recipient = item.recipient || taskRecipientCode(item) || "—";
    var timeStr = formatTaskTimeMinute(item.updated_at || item.created_at, item);
    var metaHtml =
      '<div class="task-meta task-meta-route">' +
      '<span class="task-route">' +
      esc(sender) +
      " → " +
      esc(recipient) +
      "</span>" +
      '<span class="task-time">' +
      esc(timeStr) +
      "</span>" +
      (item.priority ? '<span class="badge priority">' + esc(item.priority) + "</span>" : "") +
      (kind === "approval" && item.approval_type
        ? '<span class="badge type">' + esc(item.approval_type) + "</span>"
        : "") +
      "</div>" +
      '<div class="task-line mono">' +
      esc(id) +
      "</div>";
    var depthStyle = depth > 0 ? ' style="margin-left:' + depth * 16 + 'px"' : "";
    var branchPrefix =
      depth > 0 ? '<span class="task-tree-branch" aria-hidden="true">├─ </span>' : "";
    return (
      '<div class="task-card' +
      alertCls +
      (depth > 0 ? " task-card-child" : "") +
      '"' +
      depthStyle +
      ' data-kind="' +
      esc(kind) +
      '" data-filename="' +
      esc(id) +
      '">' +
      '<div class="task-head">' +
      branchPrefix +
      '<span class="task-title">' +
      esc(title) +
      "</span>" +
      '<span class="badge ' +
      statusBadgeClass(st, kind) +
      '">' +
      esc(st) +
      "</span></div>" +
      metaHtml +
      "</div>"
    );
  }

  function bindHomePreviewCards(root) {
    if (!root) return;
    root.querySelectorAll(".task-card").forEach(function (card) {
      card.addEventListener("click", function () {
        openTasksForSelectedRole(state.selectedRole);
      });
    });
  }

  function bindItemCards(root) {
    if (!root) return;
    root.querySelectorAll(".task-card").forEach(function (card) {
      card.addEventListener("click", function () {
        openDetail(card.getAttribute("data-kind") || "task", card.getAttribute("data-filename"));
      });
    });
  }

  function readTasksListCollapsed() {
    try {
      return localStorage.getItem(TASKS_LIST_COLLAPSED_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function persistTasksListCollapsed(collapsed) {
    try {
      localStorage.setItem(TASKS_LIST_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch (e) {}
  }

  function syncTasksListCollapsedUI() {
    var card = $("tasksListCard");
    var btn = $("tasksListCollapseBtn");
    var label = $("tasksListCollapseBtnLabel");
    if (!card) return;
    var collapsed = !!state.tasksListCollapsed;
    card.classList.toggle("tasks-list-collapsed", collapsed);
    if (btn) btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (label) label.textContent = t(collapsed ? "tasksListExpand" : "tasksListCollapse");
  }

  function toggleTasksListCollapsed() {
    state.tasksListCollapsed = !state.tasksListCollapsed;
    persistTasksListCollapsed(state.tasksListCollapsed);
    syncTasksListCollapsedUI();
  }

  function taskMatchesFilter(task, filter) {
    if (filter === "all") return true;
    var st = (task.status || "").toLowerCase();
    var bucket = (task.bucket || "").toLowerCase();
    if (filter === "pending") return bucket === "inbox" || st === "todo" || st === "pending" || st === "inbox";
    if (filter === "active") return st === "doing" || st === "active" || st === "in_progress" || bucket === "active";
    if (filter === "review") return bucket === "review" || st === "review";
    if (filter === "done") return st === "done" || st === "completed" || bucket === "done";
    if (filter === "archive") return bucket === "archive" || bucket === "archived" || st === "archived";
    if (filter === "exception") return st === "blocked" || st === "failed";
    return true;
  }
  function reportRoute(report) {
    var fn = String((report && report.filename) || "");
    var m = fn.match(/^REPORT-\d{8}-\d{3,}-([A-Z]+)-to-([A-Z]+)\.md$/i);
    if (m) return { from: m[1].toUpperCase(), to: m[2].toUpperCase() };
    return {
      from: String((report && report.sender) || "").toUpperCase(),
      to: String((report && report.recipient) || "").toUpperCase(),
    };
  }
  function reportSearchText(report) {
    return [
      report && report.filename,
      report && report.title,
      report && report.summary,
      report && report.status,
      report && report.report_type,
      report && report.report_kind,
      report && report.body,
    ]
      .filter(Boolean)
      .join(" ");
  }
  function isMobileReportRecord(report) {
    var text = reportSearchText(report);
    var st = String((report && report.status) || "").toLowerCase();
    var rt = String((report && report.report_type) || "").toLowerCase();
    var route = reportRoute(report);
    var doneish = /done|pass|ok|complete|completed|finished|success/.test(st);
    var processOnly = /巡检|接单|已接单|确认|进度|催办|等待|无变化|阻塞|无回执|协调|派单|关单|ack|patrol|progress|stall|blocked|waiting/i.test(text);
    if (/ack|acknowledgement|ack_only/.test(rt)) return true;
    if (/^(DEV|QA|OPS)$/.test(route.from) && route.to === "PM") return false;
    if (doneish && route.from === "PM" && route.to === "ADMIN" && hasFinalReportIntent(report) && !processOnly) return false;
    if (/blocked|failed|fail|error|in[_-]?progress|active|waiting/.test(st)) return true;
    return processOnly;
  }
  function hasFinalReportIntent(report) {
    var text = reportSearchText(report);
    var st = String((report && report.status) || "").toLowerCase();
    return /done|pass|ok|complete|completed|finished|success/.test(st) &&
      /最终|终版|总报告|汇总报告|项目汇总|交付完成|验收通过|final|summary|delivery/i.test(text);
  }
  function isMobileMainReport(report) {
    var route = reportRoute(report);
    return route.from === "PM" && route.to === "ADMIN" && !isMobileReportRecord(report) && hasFinalReportIntent(report);
  }
  function isMobileSubReport(report) {
    var route = reportRoute(report);
    return /^(DEV|QA|OPS)$/.test(route.from) && route.to === "PM" && !isMobileReportRecord(report);
  }
  function mobileReportSemanticClass(report) {
    if (isMobileMainReport(report)) return "main_report";
    if (isMobileSubReport(report)) return "sub_report";
    return "record";
  }
  function reportMatchesFilter(report, filter) {
    if (filter === "all") return true;
    if (filter === "main_report" || filter === "sub_report" || filter === "record") {
      return mobileReportSemanticClass(report) === filter;
    }
    return true;
  }
  function approvalMatchesFilter(row, filter) {
    if (filter === "all") return true;
    var st = (row.status || "").toLowerCase();
    if (filter === "pending") return st === "pending";
    if (filter === "approved") return st === "approved";
    if (filter === "rejected") return st === "rejected";
    if (filter === "needs_eval") return st === "needs_eval";
    if (filter === "exception") return row.material_missing || st === "blocked";
    return true;
  }

  function renderFilterRow(hostId, filters, current, i18nPrefix, onChange) {
    var host = $(hostId);
    if (!host) return;
    host.innerHTML = filters
      .map(function (f) {
        return (
          '<button type="button" class="filter-chip' +
          (current === f ? " active" : "") +
          '" data-filter="' +
          esc(f) +
          '">' +
          esc(t(i18nPrefix + f)) +
          "</button>"
        );
      })
      .join("");
    host.querySelectorAll(".filter-chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        onChange(btn.getAttribute("data-filter") || "all");
      });
    });
  }

  function filteredTasks() {
    var rows = state.tasks.filter(function (x) {
      return taskMatchesFilter(x, state.taskFilter);
    });
    if (state.tasksRoleFilter) {
      rows = rows.filter(function (x) {
        return itemMatchesSelectedRole(x, state.tasksRoleFilter);
      });
    }
    return sortTasksNewestFirst(rows);
  }
  function filteredReports() {
    return state.reports.filter(function (x) {
      return reportMatchesFilter(x, state.reportFilter);
    });
  }
  function filteredApprovals() {
    return state.approvals.filter(function (x) {
      return approvalMatchesFilter(x, state.approvalFilter);
    });
  }

  function renderTaskLists() {
    var previewHome = homePreviewItems();
    var list = $("taskList");
    var empty = $("taskListEmpty");
    if (list) {
      list.innerHTML = previewHome.map(itemCardHtmlFlat).join("");
      bindHomePreviewCards(list);
    }
    if (empty) {
      empty.textContent = t("homeTaskEmpty");
      empty.classList.toggle("hidden", !isBound() || previewHome.length > 0);
    }
    updateHomeViewAllLabel();

    var full = $("fullTaskList");
    var fullEmpty = $("fullTaskEmpty");
    var tasks = isBound() ? expandTasksWithParentLinkedChildren(filteredTasks(), state.tasks) : [];
    if (full) {
      if (!isBound()) {
        full.innerHTML = "";
      } else if (state.apiErrors.tasks) {
        full.innerHTML = '<div class="empty-state muted">' + esc(state.apiErrors.tasks) + "</div>";
      } else {
        var treeFlat = flattenTaskTreeFromItems(buildTaskTreeFromItems(tasks));
        full.innerHTML = treeFlat
          .map(function (node) {
            return itemCardHtml(node.task, node.depth);
          })
          .join("");
        bindItemCards(full);
      }
    }
    if (fullEmpty) fullEmpty.classList.toggle("hidden", !isBound() || tasks.length > 0 || !!state.apiErrors.tasks);
  }

  function renderReportsList() {
    var host = $("reportsList");
    var empty = $("reportsListEmpty");
    if (!host) return;
    if (!isBound()) {
      host.innerHTML = "";
      if (empty) empty.classList.add("hidden");
      return;
    }
    if (state.apiErrors.reports) {
      host.innerHTML = '<div class="empty-state muted">' + esc(t("reportsFeatureClosed")) + "</div>";
      if (empty) empty.classList.add("hidden");
      return;
    }
    var rows = filteredReports();
    host.innerHTML = rows.length ? rows.map(itemCardHtmlFlat).join("") : "";
    bindItemCards(host);
    if (empty) {
      empty.textContent = t("reportsShellEmpty");
      empty.classList.toggle("hidden", rows.length > 0);
    }
  }

  function renderApprovalsList() {
    var host = $("approvalsList");
    var empty = $("approvalsListEmpty");
    if (!host) return;
    if (!isBound()) {
      host.innerHTML = "";
      if (empty) empty.classList.add("hidden");
      return;
    }
    if (state.apiErrors.approvals) {
      host.innerHTML = '<div class="empty-state muted">' + esc(t("approvalsFeatureClosed")) + "</div>";
      if (empty) empty.classList.add("hidden");
      return;
    }
    var rows = filteredApprovals();
    host.innerHTML = rows.length ? rows.map(itemCardHtmlFlat).join("") : "";
    bindItemCards(host);
    if (empty) {
      empty.textContent = t("approvalsEmpty");
      empty.classList.toggle("hidden", rows.length > 0);
    }
  }

  var THINK_MERGE_WINDOW_MS = 15000;
  var THINK_MAX_CHARS = 4000;

  function normalizeThinkText(text) {
    return String(text || "")
      .replace(/^\s*(?:💭|\[思\])\s*/u, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function appendThinkText(base, next) {
    var a = normalizeThinkText(base);
    var b = normalizeThinkText(next);
    if (!a) return b;
    if (!b) return a;
    if (a.endsWith(b)) return a;
    var glue = /[\s([{`"']$/.test(a) || /^[\s.,;:!?)}\]'"`]/.test(b) ? "" : " ";
    return a + glue + b;
  }

  function trimThinkText(text) {
    var s = String(text || "");
    return s.length > THINK_MAX_CHARS ? "\u2026" + s.slice(-THINK_MAX_CHARS) : s;
  }

  /** Same-agent think rows within 15s merge into one continuous summary (PC thinkConsole parity). */
  function mergeThinkActivityEvents(events) {
    if (!events || !events.length) return events;
    var thinks = [];
    var others = [];
    events.forEach(function (ev) {
      if (!ev) return;
      if (ev.consoleKind === "think") thinks.push(ev);
      else others.push(ev);
    });
    thinks.sort(function (a, b) {
      return (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0);
    });
    var merged = [];
    thinks.forEach(function (ev) {
      var last = merged[merged.length - 1];
      var evTs = Date.parse(ev.at) || 0;
      if (
        last &&
        last.agent === ev.agent &&
        evTs - (Date.parse(last.at) || 0) <= THINK_MERGE_WINDOW_MS
      ) {
        last.summary = trimThinkText(appendThinkText(last.summary, ev.summary));
        last.at = ev.at;
        if (ev.taskId && !last.taskId) last.taskId = ev.taskId;
        return;
      }
      merged.push(Object.assign({}, ev));
    });
    var all = merged.concat(others);
    all.sort(function (a, b) {
      return (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);
    });
    return all;
  }

  function normalizeActivityEvent(row) {
    if (!row) return null;
    var taskId = String(row.taskId || row.task_id || "");
    var eventType = String(row.eventType || row.event_type || "");
    if (/^CHAT-/i.test(taskId)) return null;
    if (eventType === "chat_message") return null;
    var source = String(row.source || "");
    var consoleKind = String(row.consoleKind || row.console_kind || "");
    if (!consoleKind) {
      if (
        source === "think_console" ||
        source === "live_thought" ||
        source === "runtime_action"
      ) {
        consoleKind = source === "runtime_action" ? "runtime" : "think";
      } else if (source === "live_operation") {
        return null;
      } else if (String(row.kind || "").toUpperCase() === "TOOL") {
        return null;
      }
    }
    if (consoleKind === "tool") return null;
    if (source === "runtime_action") consoleKind = "runtime";
    return {
      id: String(row.id || ""),
      taskId: taskId,
      agent: String(row.agent || ""),
      source: source,
      consoleKind: consoleKind || "think",
      eventType: eventType,
      kind: String(row.kind || ""),
      summary: String(row.summary || ""),
      status: String(row.status || "running"),
      at: row.at || row.startAt || row.start_at || "",
    };
  }

  function activityMatchesFilter(ev, filter) {
    if (filter === "all") return true;
    if (filter === "exception") {
      var st = String(ev.status || "").toLowerCase();
      if (st === "warning" || st === "error") return true;
      var summary = String(ev.summary || "");
      if (summary.indexOf("\u2717") >= 0 || summary.indexOf("\u2716") >= 0) return true;
      return false;
    }
    return String(ev.agent || "").toUpperCase() === String(filter).toUpperCase();
  }

  function filteredActivityEvents() {
    return state.activityEvents.filter(function (ev) {
      return activityMatchesFilter(ev, state.activityFilter);
    });
  }

  function formatActivityTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return (
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0") +
      ":" +
      String(d.getSeconds()).padStart(2, "0")
    );
  }

  function activityStreamLineHtml(ev) {
    var consoleKind =
      ev.consoleKind ||
      (String(ev.kind || "").toUpperCase() === "RUNTIME" ? "runtime" : "think");
    if (consoleKind === "tool") return "";
    var timeIso = ev.at || "";
    var agent = String(ev.agent || "");
    var summaryText =
      consoleKind === "think"
        ? normalizeThinkText(ev.summary || "")
        : String(ev.summary || "");
    var cls = "activity-stream-line activity-stream-think";
    if (consoleKind === "runtime") cls += " activity-stream-runtime";
    if (String(ev.status || "").toLowerCase() === "error") {
      cls += " activity-stream-error";
    }
    var iconHtml = "";
    var textHtml = esc(summaryText);
    if (consoleKind === "runtime") {
      iconHtml = '<span class="activity-stream-icon">\u25B8</span>';
    } else {
      iconHtml = '<span class="activity-stream-icon">\uD83D\uDCAD</span>';
    }
    return (
      '<div class="' +
      cls +
      '" data-activity-id="' +
      esc(ev.id) +
      '">' +
      '<span class="activity-stream-time">' +
      esc(formatActivityTime(timeIso)) +
      "</span>" +
      '<span class="activity-stream-agent">' +
      esc(agent) +
      "</span>" +
      iconHtml +
      '<span class="activity-stream-text">' +
      textHtml +
      "</span>" +
      "</div>"
    );
  }

  function tryUpdateThinkStreamInPlace(host, rows) {
    if (!host || !rows || !rows.length) return false;
    var top = rows[0];
    if (top.consoleKind !== "think") return false;
    if (host.children.length !== rows.length) return false;
    var first = host.firstElementChild;
    if (!first || !first.classList.contains("activity-stream-think")) return false;
    if (String(first.getAttribute("data-activity-id") || "") !== String(top.id || "")) {
      return false;
    }
    var textEl = first.querySelector(".activity-stream-text");
    var timeEl = first.querySelector(".activity-stream-time");
    if (!textEl) return false;
    var nextText = normalizeThinkText(top.summary || "");
    if (textEl.textContent === nextText) {
      if (timeEl) timeEl.textContent = formatActivityTime(top.at);
      return true;
    }
    textEl.textContent = nextText;
    if (timeEl) timeEl.textContent = formatActivityTime(top.at);
    return true;
  }

  function renderActivityList(opts) {
    opts = opts || {};
    var host = $("activityList");
    var empty = $("activityListEmpty");
    if (!host) return;
    if (!isBound()) {
      host.innerHTML = "";
      state.activityRenderFingerprint = null;
      if (empty) empty.classList.add("hidden");
      return;
    }
    if (state.activityLoadError) {
      var errFp = "err:" + state.activityLoadError;
      if (!opts.force && errFp === state.activityRenderFingerprint) return;
      state.activityRenderFingerprint = errFp;
      host.innerHTML = '<div class="empty-state muted">' + esc(state.activityLoadError) + "</div>";
      if (empty) empty.classList.add("hidden");
      return;
    }
    var rows = filteredActivityEvents();
    var fp = activityRenderFingerprint(rows, "");
    if (!opts.force && fp === state.activityRenderFingerprint && host.childElementCount > 0) {
      return;
    }
    if (!opts.force && tryUpdateThinkStreamInPlace(host, rows)) {
      state.activityRenderFingerprint = fp;
      if (empty) {
        empty.textContent = t("activityEmpty");
        empty.classList.toggle("hidden", rows.length > 0);
      }
      return;
    }
    state.activityRenderFingerprint = fp;
    var scrollEl = getActivityScrollEl();
    preserveScrollOnMutate(
      scrollEl || host,
      function () {
        host.innerHTML = rows.length
          ? rows.map(activityStreamLineHtml).join("")
          : "";
      },
      false,
    );
    if (empty) {
      empty.textContent = t("activityEmpty");
      empty.classList.toggle("hidden", rows.length > 0);
    }
  }

  async function loadActivity() {
    if (!isBound()) {
      state.activityEvents = [];
      state.activityLoadError = null;
      return state.activityEvents;
    }
    try {
      var data = await api("/api/v2/mobile/activity?limit=100");
      var rows = Array.isArray(data) ? data : data.events || [];
      state.activityEvents = mergeThinkActivityEvents(
        rows.map(normalizeActivityEvent).filter(Boolean),
      );
      state.activityLoadError = null;
    } catch (e) {
      state.activityEvents = [];
      var msg = String(e.message || "");
      if (/FORBIDDEN/i.test(msg)) {
        state.activityLoadError = t("activityApiUnavailable");
      } else if (msg) {
        state.activityLoadError = msg;
      } else {
        state.activityLoadError = t("activityFeatureClosed");
      }
    }
    return state.activityEvents;
  }

  function clearActivityPoll() {
    if (state.activityPollTimer) {
      clearTimeout(state.activityPollTimer);
      state.activityPollTimer = null;
    }
  }

  function scheduleActivityPoll(delayMs) {
    clearActivityPoll();
    if (shouldPauseBackgroundPoll()) return;
    var delay = typeof delayMs === "number" ? delayMs : getActivityPollDelay();
    state.activityPollTimer = setTimeout(function () {
      if (state.tab !== "activity" || shouldPauseBackgroundPoll()) return;
      loadActivity()
        .then(function () {
          renderActivityList();
        })
        .finally(function () {
          if (state.tab === "activity" && !shouldPauseBackgroundPoll()) {
            scheduleActivityPoll(getActivityPollDelay());
          }
        });
    }, delay);
  }

  function setDetailTitle(kind) {
    var titleEl = $("taskDetailPageTitle");
    if (!titleEl) return;
    if (kind === "report") titleEl.textContent = t("reportDetailTitle");
    else if (kind === "approval") titleEl.textContent = t("approvalDetailTitle");
    else titleEl.textContent = t("taskDetailTitle");
  }

  function hideDetailSections() {
    [
      "fpStatusAlert",
      "fpRelatedIssuesSection",
      "fpReportActions",
      "fpApprovalPanel",
      "fpRelatedTasksSection",
      "fpChildTasksSection",
      "fpFlowOverviewSection",
    ].forEach(function (id) {
      var el = $(id);
      if (el) el.classList.add("hidden");
    });
    $("fpNoReports") && $("fpNoReports").classList.remove("hidden");
    $("fpRelatedReports") && ($("fpRelatedReports").innerHTML = "");
    $("fpChildTasks") && ($("fpChildTasks").innerHTML = "");
    $("fpFlowOverview") && ($("fpFlowOverview").innerHTML = "");
    $("fpTaskActionBar") && ($("fpTaskActionBar").innerHTML = "");
  }

  function renderFlowOverview(nodes) {
    var host = $("fpFlowOverview");
    var sec = $("fpFlowOverviewSection");
    if (!host || !sec) return;
    if (!nodes || !nodes.length) {
      sec.classList.add("hidden");
      host.innerHTML = "";
      return;
    }
    sec.classList.remove("hidden");
    host.innerHTML = nodes
      .map(function (node, idx) {
        var arrow = idx < nodes.length - 1 ? '<div class="flow-arrow" aria-hidden="true">↓</div>' : "";
        var rel =
          node.sender && node.recipient
            ? '<div class="flow-node-rel muted">' + esc(node.sender) + " → " + esc(node.recipient) + "</div>"
            : "";
        var clickable = node.ref_kind && node.filename ? " flow-node-clickable" : "";
        var time = node.time ? '<span class="flow-node-time muted">' + esc(node.time) + "</span>" : "";
        var st = node.status || "";
        var badgeKind = node.ref_kind === "approval" ? "approval" : "task";
        var status = st
          ? '<span class="badge ' + statusBadgeClass(st, badgeKind) + '">' + esc(st) + "</span>"
          : "";
        var dataAttrs =
          node.filename && node.ref_kind
            ? ' data-kind="' + esc(node.ref_kind) + '" data-filename="' + esc(node.filename) + '"'
            : "";
        return (
          '<div class="flow-node' +
          clickable +
          '"' +
          dataAttrs +
          ">" +
          '<div class="flow-node-title">' +
          esc(node.title || "—") +
          "</div>" +
          rel +
          '<div class="flow-node-meta">' +
          status +
          time +
          "</div>" +
          "</div>" +
          arrow
        );
      })
      .join("");
    host.querySelectorAll(".flow-node-clickable").forEach(function (el) {
      el.addEventListener("click", function () {
        var k = el.getAttribute("data-kind") || "task";
        var fn = el.getAttribute("data-filename");
        if (fn) openDetail(k, fn);
      });
    });
  }

  function renderChildTasks(children) {
    var sec = $("fpChildTasksSection");
    if (!sec) return;
    if (!children || !children.length) {
      sec.classList.add("hidden");
      $("fpChildTasks") && ($("fpChildTasks").innerHTML = "");
      return;
    }
    sec.classList.remove("hidden");
    renderRelatedList(
      "fpChildTasks",
      "fpNoChildTasks",
      children.map(function (c) {
        return normalizeTask(Object.assign({ kind: "task" }, c));
      }),
      "task",
    );
  }

  function renderTaskActionBar(actions) {
    var host = $("fpTaskActionBar");
    if (!host) return;
    var list =
      actions && actions.length
        ? actions
        : [{ id: "back", label: t("back"), enabled: true }];
    host.innerHTML = list
      .map(function (a) {
        var cls = "btn-secondary-block fp-task-action-btn";
        if ((a.id === "approve" || a.id === "archive") && a.enabled !== false) {
          cls = "btn-block-primary fp-task-action-btn";
        }
        var dis = a.enabled === false ? " disabled" : "";
        var reason = a.disabled_reason ? ' title="' + esc(a.disabled_reason) + '"' : "";
        return (
          '<button type="button" class="' +
          cls +
          '"' +
          dis +
          reason +
          ' data-action="' +
          esc(a.id) +
          '">' +
          esc(a.label) +
          "</button>"
        );
      })
      .join("");
    host.querySelectorAll(".fp-task-action-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.disabled) {
          var reason = btn.getAttribute("title");
          if (reason) showToast(reason);
          return;
        }
        runTaskAction(btn.getAttribute("data-action"));
      });
    });
  }

  async function runTaskAction(actionId) {
    if (!actionId || actionId === "back") {
      closeTaskDetail();
      return;
    }
    var task = state.currentDetail;
    if (!task || state.detailKind !== "task") return;
    var fn = task.filename || task.id;
    if (!fn) return;
    var body = { action: actionId };
    if (actionId === "reject") {
      var reason = window.prompt(t("actionRejectReason"));
      if (reason == null) return;
      reason = String(reason).trim();
      if (!reason) {
        showToast(t("actionRejectRequired"));
        return;
      }
      body.reason = reason;
    }
    try {
      await api("/api/v2/mobile/tasks/" + encodeURIComponent(fn) + "/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
      });
      showToast(t("actionSuccess"));
      await refreshAll();
      await openDetail("task", fn, { preserveScroll: false });
    } catch (e) {
      if (actionId === "archive") {
        try {
          await refreshAll();
          await openDetail("task", fn, { preserveScroll: true });
        } catch (_) {}
      }
      showErrorToast(t("toastError") + "：" + userFacingError(e));
    }
  }

  function renderRelatedList(hostId, emptyId, items, kind) {
    var host = $(hostId);
    var empty = $(emptyId);
    if (!host) return;
    if (items && items.length) {
      host.innerHTML = items.map(itemCardHtmlFlat).join("");
      bindItemCards(host);
      if (empty) empty.classList.add("hidden");
    } else {
      host.innerHTML = "";
      if (empty) empty.classList.remove("hidden");
    }
  }

  function showDetailFromTask(task, relatedReports, relatedIssues, transitions, extras) {
    extras = extras || {};
    state.currentDetail = task;
    state.detailKind = "task";
    setDetailTitle("task");
    hideDetailSections();
    $("fpDetailTaskId").textContent = task.filename || task.id || "—";
    $("fpDetailFileName").textContent = task.title || task.filename || "—";
    $("fpDetailStatus").textContent = task.status || "—";
    $("fpDetailSender").textContent = task.sender || "—";
    $("fpDetailRecipient").textContent = task.recipient || "—";
    $("fpDetailBucket").textContent = task.bucket || "—";
    setFpMarkdown(task.body || task.markdown);

    var st = (task.status || "").toLowerCase();
    var alert = $("fpStatusAlert");
    if (alert) {
      if (st === "blocked" || st === "failed") {
        alert.classList.remove("hidden");
        alert.className = "detail-alert " + st;
        alert.textContent = t("reportNeedsAction") + " (" + st + ")";
      } else {
        alert.classList.add("hidden");
      }
    }

    renderFlowOverview(extras.flow_overview || []);
    renderChildTasks(extras.child_tasks || []);
    renderRelatedList("fpRelatedReports", "fpNoReports", relatedReports || [], "report");

    var issSec = $("fpRelatedIssuesSection");
    if (relatedIssues && relatedIssues.length) {
      issSec && issSec.classList.remove("hidden");
      renderRelatedList("fpRelatedIssues", "fpNoIssues", relatedIssues, "issue");
    }

    renderTaskActionBar(extras.available_actions || [{ id: "back", label: t("back"), enabled: true }]);
    $("taskDetailPage").classList.add("open");
  }

  function showDetailFromReport(report, linkedTasks, relatedIssues) {
    state.currentDetail = report;
    state.detailKind = "report";
    setDetailTitle("report");
    hideDetailSections();
    $("fpDetailTaskId").textContent = report.filename || report.id || "—";
    $("fpDetailFileName").textContent = report.title || report.filename || "—";
    $("fpDetailStatus").textContent = report.status || "—";
    $("fpDetailSender").textContent = report.sender || "—";
    $("fpDetailRecipient").textContent = report.recipient || "—";
    $("fpDetailBucket").textContent = report.priority || "—";
    setFpMarkdown(report.body);

    var st = (report.status || "").toLowerCase();
    var alert = $("fpStatusAlert");
    if (alert) {
      if (st === "blocked" || st === "failed") {
        alert.classList.remove("hidden");
        alert.className = "detail-alert " + st;
        alert.textContent = t("reportNeedsAction");
      } else {
        alert.classList.add("hidden");
      }
    }

    var tasksSec = $("fpRelatedTasksSection");
    if (linkedTasks && linkedTasks.length) {
      tasksSec && tasksSec.classList.remove("hidden");
      renderRelatedList(
        "fpRelatedTasks",
        "fpNoLinkedTasks",
        linkedTasks.map(function (x) {
          return normalizeTask(x);
        }),
        "task",
      );
    }

    if (relatedIssues && relatedIssues.length) {
      $("fpRelatedIssuesSection") && $("fpRelatedIssuesSection").classList.remove("hidden");
      renderRelatedList("fpRelatedIssues", "fpNoIssues", relatedIssues, "issue");
    }

    renderTaskActionBar([{ id: "back", label: t("back"), enabled: true }]);
    $("taskDetailPage").classList.add("open");
  }

  function showDetailFromApproval(data) {
    var approval = normalizeApproval(data.approval || data);
    state.currentDetail = approval;
    state.detailKind = "approval";
    setDetailTitle("approval");
    hideDetailSections();
    $("fpDetailTaskId").textContent = approval.filename || "—";
    $("fpDetailFileName").textContent = approval.title || "—";
    $("fpDetailStatus").textContent = approval.status || "—";
    $("fpDetailSender").textContent = approval.sender || "—";
    $("fpDetailRecipient").textContent = approval.recipient || "—";
    $("fpDetailBucket").textContent = approval.approval_type || "—";
    setFpMarkdown(
      approval.body ||
        approval.preview ||
        approval.summary ||
        (data.approval && (data.approval.body || data.approval.preview || data.approval.summary)),
    );

    if (data.linked_task) {
      $("fpRelatedTasksSection") && $("fpRelatedTasksSection").classList.remove("hidden");
      renderRelatedList("fpRelatedTasks", "fpNoLinkedTasks", [normalizeTask(data.linked_task)], "task");
    }
    if (data.linked_report) {
      renderRelatedList("fpRelatedReports", "fpNoReports", [normalizeReport(data.linked_report)], "report");
    }

    var panel = $("fpApprovalPanel");
    if (panel && isBound() && approval.status === "pending") {
      panel.classList.remove("hidden");
      var disabled = approval.can_approve === false || approval.material_missing;
      var approveBtn = $("fpApprovalApprove");
      var rejectBtn = $("fpApprovalReject");
      var hint = $("fpApprovalGateHint");
      if (approveBtn) {
        approveBtn.disabled = disabled;
        approveBtn.classList.toggle("btn-block-primary", !disabled);
        approveBtn.classList.toggle("btn-secondary-block", !!disabled);
      }
      if (rejectBtn) {
        rejectBtn.disabled = false;
        rejectBtn.classList.add("btn-secondary-block");
        rejectBtn.classList.remove("btn-block-primary");
      }
      if (hint) {
        hint.classList.toggle("hidden", !disabled);
        hint.textContent = t("approvalMaterialsMissing");
      }
    }

    renderTaskActionBar([{ id: "back", label: t("back"), enabled: true }]);
    $("taskDetailPage").classList.add("open");
  }

  async function openDetail(kind, filename, opts) {
    if (!filename) return;
    kind = kind || "task";
    opts = opts || {};
    state.detailKind = kind;

    var detailContent = document.querySelector(".fp-detail-content");
    var preserveScroll = !!opts.preserveScroll && isDetailPageOpen() && detailContent;
    var prevScroll = preserveScroll ? detailContent.scrollTop : null;

    try {
      if (kind === "task") {
        var data = await api("/api/v2/mobile/tasks/" + encodeURIComponent(filename));
        var task = normalizeTask(Object.assign({}, data.task, { body: data.task && data.task.body }));
        showDetailFromTask(
          task,
          (data.related_reports || []).map(normalizeReport),
          data.related_issues || [],
          data.transitions || [],
          {
            child_tasks: data.child_tasks || [],
            flow_overview: data.flow_overview || [],
            available_actions: data.available_actions || [],
          },
        );
        clearApiError("tasks");
      } else if (kind === "report") {
        var rd = await api("/api/v2/mobile/reports/" + encodeURIComponent(filename));
        var report = normalizeReport(Object.assign({}, rd.report, { body: rd.report && rd.report.body }));
        showDetailFromReport(report, rd.linked_tasks || [], rd.related_issues || []);
        clearApiError("reports");
      } else if (kind === "approval") {
        var ad = await api("/api/v2/mobile/approvals/" + encodeURIComponent(filename));
        showDetailFromApproval(ad);
        clearApiError("approvals");
      }
    } catch (e) {
      showErrorToast(t("toastError") + "：" + userFacingError(e));
      if (kind === "task") setApiError("tasks", e.message);
      if (kind === "report") setApiError("reports", e.message);
      if (kind === "approval") setApiError("approvals", e.message);
      return;
    }

    if (prevScroll != null && detailContent) {
      detailContent.scrollTop = prevScroll;
    }
  }

  function closeTaskDetail() {
    $("taskDetailPage").classList.remove("open");
    state.currentDetail = null;
    if (state.tab === "chat") scheduleChatPoll(0);
    if (state.tab === "activity") scheduleActivityPoll(0);
  }

  async function refreshCurrentDetail() {
    if (!state.currentDetail) return;
    await openDetail(state.detailKind, state.currentDetail.filename || state.currentDetail.id, {
      preserveScroll: true,
    });
  }

  async function approveCurrentApproval() {
    var item = state.currentDetail;
    if (!item || state.detailKind !== "approval") return;
    if (item.can_approve === false || item.material_missing) {
      showToast(t("approvalMaterialsMissing"));
      return;
    }
    var reason = window.prompt(t("approvalApproveReason"));
    if (reason == null) return;
    reason = String(reason).trim();
    if (!reason) {
      showToast(t("approvalApproveReasonRequired"));
      return;
    }
    try {
      var approved = await api("/api/v2/mobile/approvals/" + encodeURIComponent(item.filename) + "/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { reason: reason },
      });
      if (approved && approved.execution_token) {
        await api("/api/v2/mobile/approvals/" + encodeURIComponent(item.filename) + "/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: { execution_token: approved.execution_token },
        });
      }
      showToast(t("approvalApprovedToast"));
      closeTaskDetail();
      await loadApprovals();
      renderApprovalsList();
    } catch (e) {
      showErrorToast(t("toastError") + "：" + userFacingError(e));
    }
  }

  async function rejectCurrentApproval() {
    var item = state.currentDetail;
    if (!item || state.detailKind !== "approval") return;
    var reason = window.prompt(t("approvalRejectReason"));
    if (reason == null) return;
    reason = String(reason).trim();
    if (!reason) {
      showToast(t("approvalRejectRequired"));
      return;
    }
    try {
      await api("/api/v2/mobile/approvals/" + encodeURIComponent(item.filename) + "/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { reason: reason },
      });
      showToast(t("approvalRejectedToast"));
      closeTaskDetail();
      await loadApprovals();
      renderApprovalsList();
    } catch (e) {
      showErrorToast(t("toastError") + "：" + userFacingError(e));
    }
  }

  function updateMyPage(bs) {
    var bound = isBound();
    bs = bound ? bs || state.bootstrap || unboundBootstrap() : unboundBootstrap();
    var el = $("myBindStatusValue");
    if (el) el.textContent = bound ? t("bound") : t("unbound");
    updateVersionDisplay();
    var gate = $("bindGate");
    if (gate && bound) gate.classList.add("hidden");
    updateTabBoundState();
  }

  function clearChatPoll() {
    if (state.chatPollTimer) {
      clearTimeout(state.chatPollTimer);
      state.chatPollTimer = null;
    }
  }

  function scheduleChatPoll(delayMs) {
    clearChatPoll();
    if (shouldPauseBackgroundPoll()) return;
    var delay = typeof delayMs === "number" ? delayMs : getChatPollDelay();
    state.chatPollTimer = setTimeout(function () {
      if (state.tab !== "chat" || shouldPauseBackgroundPoll()) return;
      loadChatMessages().finally(function () {
        if (state.tab === "chat" && !shouldPauseBackgroundPoll()) {
          scheduleChatPoll(getChatPollDelay());
        }
      });
    }, delay);
  }

  function switchTab(tab, opts) {
    opts = opts || {};
    if (tab === "tasks" && !opts.keepRoleFilter) {
      state.tasksRoleFilter = null;
      updateTasksRoleFilterLabel();
    }
    state.tab = tab;
    clearChatPoll();
    clearActivityPoll();
    document.querySelectorAll(".tab-view").forEach(function (el) {
      el.classList.add("hidden");
      el.classList.remove("active");
    });
    var view = $("view" + tab.charAt(0).toUpperCase() + tab.slice(1));
    if (view) {
      view.classList.remove("hidden");
      view.classList.add("active");
    }
    document.querySelectorAll(".bottom-nav-item").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
    });
    updateTabBoundState();
    if (tab === "chat") {
      state.chatPollDelay = 3000;
      scheduleChatPoll(0);
    }
    if (tab === "activity") {
      state.activityPollDelay = 3000;
      scheduleActivityPoll(0);
    }
    if (tab === "my") updateMyPage();
  }

  async function loadBootstrap() {
    if (!isBound()) {
      state.bootstrap = unboundBootstrap();
      return state.bootstrap;
    }
    try {
      var raw = await api("/api/v2/mobile/bootstrap");
      reconcileApiBaseFromServer(raw.api_base);
      state.bootstrap = normalizeBootstrap(raw);
      clearApiError("bootstrap");
      return state.bootstrap;
    } catch (e) {
      state.bootstrap = normalizeBootstrap({ summary: {}, status: { pc_online: false, gateway_online: false } });
      setApiError("bootstrap", e.message);
      return state.bootstrap;
    }
  }

  async function loadTasks() {
    if (!isBound()) {
      state.tasks = [];
      return state.tasks;
    }
    try {
      var qs = "";
      var recipient = state.tasksRoleFilter ? roleCodeFromField(state.tasksRoleFilter) : "";
      if (recipient) {
        qs = "?recipient=" + encodeURIComponent(recipient);
      }
      var data = await api("/api/v2/mobile/tasks" + qs);
      var rows = Array.isArray(data) ? data : data.tasks || data.items || [];
      state.tasks = sortTasksNewestFirst(rows.map(normalizeTask));
      clearApiError("tasks");
    } catch (e) {
      state.tasks = [];
      setApiError("tasks", e.message);
    }
    return state.tasks;
  }

  async function loadRelationPickerTasks() {
    if (!isBound()) {
      state.relationPickerTasks = [];
      return state.relationPickerTasks;
    }
    try {
      var data = await api("/api/v2/mobile/tasks");
      var rows = Array.isArray(data) ? data : data.tasks || data.items || [];
      state.relationPickerTasks = sortTasksNewestFirst(rows.map(normalizeTask));
    } catch (e) {
      state.relationPickerTasks = Array.isArray(state.tasks) ? state.tasks.slice() : [];
    }
    return state.relationPickerTasks;
  }

  async function loadReports() {
    if (!isBound()) {
      state.reports = [];
      return state.reports;
    }
    try {
      var data = await api("/api/v2/mobile/reports");
      var rows = Array.isArray(data) ? data : data.reports || [];
      state.reports = rows.map(normalizeReport);
      clearApiError("reports");
    } catch (e) {
      state.reports = [];
      setApiError("reports", e.message);
    }
    return state.reports;
  }

  async function loadApprovals() {
    if (!isBound()) {
      state.approvals = [];
      return state.approvals;
    }
    try {
      var data = await api("/api/v2/mobile/approvals");
      var rows = Array.isArray(data) ? data : data.approvals || [];
      state.approvals = rows.map(normalizeApproval);
      clearApiError("approvals");
    } catch (e) {
      state.approvals = [];
      setApiError("approvals", e.message);
    }
    return state.approvals;
  }

  function shouldClearBoundDataOnRefresh() {
    if (isBound()) return false;
    if (bindingInProgress) return false;
    if (Date.now() <= bindGraceUntil) return false;
    return true;
  }

  async function refreshAll() {
    if (shouldClearBoundDataOnRefresh()) {
      clearBoundData();
    } else if (isBound()) {
      await loadBootstrap();
      await Promise.all([
        loadTasks(),
        loadRelationPickerTasks(),
        loadReports(),
        loadApprovals(),
        loadActivity(),
      ]);
      if (state.bootstrap) {
        var stats = computeStatsFromLists(state.tasks, state.reports);
        mergeBootstrapSummaryStats(stats, state.bootstrap.summary);
        state.bootstrap.stats = stats;
      }
      // 同步“任务关系模式”的可选项（依赖 loadTasks() 已完成）
      syncTaskSendRelationMode();
    }
    renderFilterRow("taskFilterRow", TASK_FILTERS, state.taskFilter, "taskFilter_", function (f) {
      state.taskFilter = f;
      renderTaskLists();
    });
    renderFilterRow("reportFilterRow", REPORT_FILTERS, state.reportFilter, "reportFilter_", function (f) {
      state.reportFilter = f;
      renderReportsList();
    });
    renderFilterRow("approvalFilterRow", APPROVAL_FILTERS, state.approvalFilter, "approvalFilter_", function (f) {
      state.approvalFilter = f;
      renderApprovalsList();
    });
    renderFilterRow("activityFilterRow", ACTIVITY_FILTERS, state.activityFilter, "activityFilter_", function (f) {
      state.activityFilter = f;
      renderActivityList();
    });
    updateStats(state.tasks, state.bootstrap);
    updateStatusLights(state.bootstrap);
    renderTeam(state.bootstrap);
    renderTaskLists();
    renderReportsList();
    renderApprovalsList();
    renderActivityList();
    renderApiErrorBanner();
    updateMyPage(state.bootstrap);
    updateTabBoundState();
  }

  function readLocalChatLog() {
    try {
      var raw = localStorage.getItem(CHAT_LOCAL_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeLocalChatLog(messages) {
    try {
      localStorage.setItem(CHAT_LOCAL_KEY, JSON.stringify(messages || []));
    } catch (e) {}
  }

  function isMobileChatSource(msg) {
    var s = String((msg && msg.source) || "").toLowerCase();
    var c = String((msg && msg.client) || "").toLowerCase();
    return s === "mobile" || c === "pwa" || c === "ios" || c === "android";
  }

  var DEFAULT_CHAT_AGENT_ID = "PM-01";

  function formatChatSenderLabel(msg) {
    var role = String((msg && msg.role) || "user").toLowerCase();
    if (role === "user" || role === "admin") return "ADMIN";
    var agentId = String((msg && (msg.agentId || msg.agent_id)) || "").trim();
    if (!agentId) agentId = DEFAULT_CHAT_AGENT_ID;
    var roleMatch = /^([A-Za-z]+)/.exec(agentId);
    if (roleMatch && roleMatch[1]) return roleMatch[1].toUpperCase();
    return agentId;
  }

  function normalizeChatMessage(row) {
    if (!row) return null;
    var role = String(row.role || "user").toLowerCase();
    if (role === "admin") role = "user";
    var attachments = Array.isArray(row.attachments) ? row.attachments : [];
    var out = {
      role: role,
      content: String(row.content || row.text || ""),
      created_at: row.created_at || row.ts || new Date().toISOString(),
      ...(attachments && attachments.length ? { attachments: attachments } : {}),
    };
    var agentId = row.agentId != null ? row.agentId : row.agent_id;
    if (agentId) out.agentId = String(agentId);
    if (row.source) out.source = String(row.source);
    if (row.client) out.client = String(row.client);
    return out;
  }

  function getChatAttachmentLocalPath(a) {
    if (!a) return "";
    return String(a.local_path || a.localPath || "");
  }

  function getChatAttachmentMime(a) {
    if (!a) return "";
    return String(a.mime || "");
  }

  function renderChatMessages(opts) {
    opts = opts || {};
    var box = $("chatMessages");
    if (!box) return;
    var rows = state.chatMessages || [];
    var fp = chatMessagesFingerprint(rows);
    if (!opts.force && fp === state.chatMessagesFingerprint && box.childElementCount > 0) {
      return;
    }
    state.chatMessagesFingerprint = fp;

    if (!rows.length) {
      box.innerHTML = '<div class="empty-state muted">' + esc(t("empty")) + "</div>";
      box.scrollTop = 0;
      return;
    }

    var stickToBottom =
      opts.stickToBottom === true ||
      (opts.stickToBottom !== false && scrollContainerNearBottom(box));

    preserveScrollOnMutate(
      box,
      function () {
        box.innerHTML = rows
          .map(function (msg) {
            var role = String(msg.role || "user").toLowerCase();
            var cls = role === "user" || role === "admin" ? "admin" : "agent";
            var time = "";
            try {
              time = msg.created_at ? new Date(msg.created_at).toLocaleString() : "";
            } catch (e) {}

            var attachHtml = "";
            if (Array.isArray(msg.attachments) && msg.attachments.length) {
              attachHtml =
                '<div class="chat-attach-list">' +
                msg.attachments
                  .map(function (a) {
                    var localPath = getChatAttachmentLocalPath(a);
                    var mime = getChatAttachmentMime(a);
                    var key = String(a.sha256 || a.absolute_path || localPath || a.original_name || mime || "");
                    var name = String(a.original_name || a.originalName || "image");
                    return (
                      '<button type="button" class="chat-attach-thumb" ' +
                      'data-attach-key="' +
                      esc(key) +
                      '" data-local-path="' +
                      esc(localPath) +
                      '" data-mime="' +
                      esc(mime) +
                      '" aria-label="image preview" ' +
                      'data-loaded="0">' +
                      '<img src="" alt="' +
                      esc(name) +
                      '" />' +
                      "</button>"
                    );
                  })
                  .join("") +
                "</div>";
            }
            var whoLabel = formatChatSenderLabel(msg);
            var mobileTag = isMobileChatSource(msg)
              ? '<span class="chat-source-tag">' + esc(t("chatSourceMobile")) + "</span>"
              : "";
            var metaLine = esc(whoLabel);
            if (time) metaLine += " · " + esc(time);
            if (mobileTag) metaLine += " " + mobileTag;
            var bodyHtml = "";
            if (msg.content && String(msg.content).trim()) {
              bodyHtml = '<div class="chat-msg-body detail-markdown">' + renderMarkdown(msg.content) + "</div>";
            }
            return (
              '<div class="chat-msg ' +
              cls +
              '">' +
              '<div class="chat-msg-meta">' +
              metaLine +
              "</div>" +
              bodyHtml +
              attachHtml +
              "</div>"
            );
          })
          .join("");

        // Delegated click: thumbnail -> modal
        if (!box.dataset.fcopThumbClickBound) {
          box.dataset.fcopThumbClickBound = "1";
          box.addEventListener("click", function (ev) {
            var t = ev.target;
            if (!t) return;
            var btn = t.closest && t.closest(".chat-attach-thumb");
            if (!btn) return;
            ev.preventDefault();
            ev.stopPropagation();
            var lp = btn.getAttribute("data-local-path") || "";
            var mime = btn.getAttribute("data-mime") || "";
            if (lp) openImagePreview(lp, mime);
          });
        }
      },
      stickToBottom,
    );
  }

  function openImagePreview(localPath, mime) {
    var modal = $("imagePreviewModal");
    var img = $("imagePreviewImg");
    if (!modal || !img) {
      showToast(t("imagePreviewMissing") || "image preview modal missing");
      return;
    }
    var lp = String(localPath || "");
    var m = String(mime || "");
    if (!lp) return;

    function showModalWithSrc(src) {
      img.src = src || "";
      modal.classList.add("visible");
      modal.setAttribute("aria-hidden", "false");
      modal.dataset.opened = "1";
      document.body.classList.add("image-preview-open");
    }

    // Cache hit: reuse already hydrated data url
    var cached = state.chatAttachmentPreviewCache && state.chatAttachmentPreviewCache[lp];
    if (cached) {
      showModalWithSrc(cached);
      return;
    }

    showModalWithSrc("");
    img.alt = "image preview";

    if (!isBound()) return;
    // Fetch full bytes via mobile gateway (base64).
    api("/api/v2/mobile/files/attachment?path=" + encodeURIComponent(lp))
      .then(function (data) {
        if (!data || data.ok === false) throw new Error(data && data.error ? data.error : "FETCH_FAILED");
        var src = "data:" + data.mime + ";base64," + data.base64;
        state.chatAttachmentPreviewCache = state.chatAttachmentPreviewCache || {};
        state.chatAttachmentPreviewCache[lp] = src;
        if (modal.classList.contains("visible")) img.src = src;
      })
      .catch(function () {
        // Keep modal open; just show toast.
        showToast(t("imagePreviewLoadFail") || "image preview load failed");
      });
  }

  function closeImagePreview() {
    var modal = $("imagePreviewModal");
    if (!modal) return;
    if (!modal.classList.contains("visible")) return;
    modal.classList.remove("visible");
    modal.setAttribute("aria-hidden", "true");
    modal.dataset.opened = "0";
    document.body.classList.remove("image-preview-open");
    var img = $("imagePreviewImg");
    if (img) img.src = "";
    if (state.tab === "chat") scheduleChatPoll(0);
    if (state.tab === "activity") scheduleActivityPoll(0);
  }

  async function hydrateChatAttachmentThumbnails() {
    if (!isBound()) return;
    var box = $("chatMessages");
    if (!box) return;
    if (state.chatHydratingThumbnails) return;
    var thumbs = box.querySelectorAll && box.querySelectorAll(".chat-attach-thumb[data-local-path]");
    if (!thumbs || !thumbs.length) return;

    state.chatHydratingThumbnails = true;
    try {
      state.chatAttachmentPreviewCache = state.chatAttachmentPreviewCache || {};
      for (var i = 0; i < thumbs.length; i++) {
        var btn = thumbs[i];
        var lp = btn.getAttribute("data-local-path") || "";
        if (!lp) continue;
        if (btn.dataset && btn.dataset.loaded === "1") continue;

        var img = btn.querySelector && btn.querySelector("img");
        if (!img) continue;

        var cached = state.chatAttachmentPreviewCache[lp];
        if (cached) {
          img.src = cached;
          if (btn.dataset) btn.dataset.loaded = "1";
          continue;
        }

        try {
          var data = await api("/api/v2/mobile/files/attachment?path=" + encodeURIComponent(lp));
          if (!data || data.ok === false) continue;
          var src = "data:" + data.mime + ";base64," + data.base64;
          state.chatAttachmentPreviewCache[lp] = src;
          img.src = src;
          if (btn.dataset) btn.dataset.loaded = "1";
        } catch (e) {
          // ignore single thumb failure; other thumbs still hydrate
        }
      }
    } finally {
      state.chatHydratingThumbnails = false;
    }
  }

  async function loadChatMessages() {
    var box = $("chatMessages");
    var stickToBottom = box ? scrollContainerNearBottom(box) : true;
    var prevTop = box ? box.scrollTop : 0;
    var prevHeight = box ? box.scrollHeight : 0;

    if (!isBound()) {
      state.chatMessages = readLocalChatLog();
      renderChatMessages({ stickToBottom: true });
      return state.chatMessages;
    }
    try {
      var data = await api("/api/v2/mobile/chat/messages");
      var rows = Array.isArray(data.messages) ? data.messages : [];
      state.chatMessages = rows.map(normalizeChatMessage).filter(Boolean);
      writeLocalChatLog(state.chatMessages);
      clearApiError("chat");
      state.chatPollDelay = 3000;
    } catch (e) {
      state.chatMessages = readLocalChatLog();
      if (state.chatMessages.length) {
        clearApiError("chat");
        state.chatPollDelay = Math.min((state.chatPollDelay || 3000) * 2, 15000);
      } else {
        setApiError("chat", e.message);
      }
    }
    renderChatMessages({ stickToBottom: stickToBottom });
    // Fill chat thumbnails after DOM render.
    await hydrateChatAttachmentThumbnails().catch(function () {});
    if (box && !stickToBottom) {
      adjustScrollAfterContentGrowth(box, prevTop, prevHeight);
    }
    return state.chatMessages;
  }

  async function sendChatMessage() {
    var input = $("chatInput");
    var text = (input && input.value.trim()) || "";
    var pending = Array.isArray(state.pendingChatAttachments) ? state.pendingChatAttachments : [];
    if (state.chatSending) return;
    if (!isBound()) {
      // 不支持未绑定状态下上传图片附件（只允许纯文本消息）。
      if (pending.length) {
        showToast(t("unbound"));
        openBindPage();
        return;
      }
      if (!text) return;
      var local = readLocalChatLog();
      var localMsg = { role: "user", content: text, created_at: new Date().toISOString() };
      local.push(localMsg);
      writeLocalChatLog(local);
      state.chatMessages = local;
      if (input) input.value = "";
      renderChatMessages({ stickToBottom: true });
      return;
    }
    var btn = $("chatSendBtn");
    state.chatSending = true;
    if (btn) btn.disabled = true;
    try {
      var attachmentsMeta = [];
      if (pending.length) {
        // Upload images first, then create the chat message with returned metadata.
        attachmentsMeta = await uploadPendingAttachments(pending);
      }
      if (!text && (!attachmentsMeta || !attachmentsMeta.length)) return;

      // Optimistic UI: show the message right after attachment upload.
      var optimistic = {
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
        ...(attachmentsMeta && attachmentsMeta.length ? { attachments: attachmentsMeta } : {}),
      };
      state.chatMessages = (state.chatMessages || []).concat([optimistic]);
      writeLocalChatLog(state.chatMessages);

      // Clear composer UI (attachments are already uploaded).
      if (input) input.value = "";
      state.pendingChatAttachments = [];
      var preview = $("chatAttachPreview");
      if (preview) preview.innerHTML = "";

      renderChatMessages({ stickToBottom: true });
      await hydrateChatAttachmentThumbnails().catch(function () {});

      var sendResp = await api("/api/v2/mobile/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { message: text, attachments: attachmentsMeta && attachmentsMeta.length ? attachmentsMeta : undefined },
      });
      clearApiError("chat");
      if (sendResp && sendResp.ok === true) {
        if (sendResp.message) {
          // Replace optimistic with server-persisted message (created_at + attachments).
          var normalized = normalizeChatMessage(sendResp.message);
          if (normalized) {
            state.chatMessages = state.chatMessages || [];
            state.chatMessages[state.chatMessages.length - 1] = normalized;
            writeLocalChatLog(state.chatMessages);
            renderChatMessages({ stickToBottom: true });
            await hydrateChatAttachmentThumbnails().catch(function () {});
          }
        }
        await loadChatMessages();
        scheduleChatPoll(state.chatPollDelay || 3000);
      }
    } catch (e) {
      showErrorToast(t("homeSendFail") + "：" + userFacingError(e));
    } finally {
      state.chatSending = false;
      if (btn) btn.disabled = false;
    }
  }

  function isTaskOpen(row) {
    var bucket = String(row && (row.bucket || row._state || row.display_status || "")).toLowerCase();
    if (["done", "archive", "archived", "closed"].includes(bucket)) return false;
    var review = String(row && (row.review_status || row.reviewStatus || "")).toLowerCase();
    if (review === "approved" && (bucket === "done" || bucket === "archive")) return false;
    return true;
  }

  function getOpenTasksForRelation() {
    var src = Array.isArray(state.relationPickerTasks)
      ? state.relationPickerTasks
      : Array.isArray(state.tasks)
        ? state.tasks
        : [];
    return src.filter(function (row) {
      return isTaskOpen(row) && isTopLevelListTask(row, src);
    });
  }

  function syncRelationModeOptions(hasOpen) {
    var modeEl = $("taskSendRelationMode");
    if (!modeEl) return;
    var opts = modeEl.querySelectorAll("option");
    if (opts && opts.length) {
      opts.forEach(function (opt) {
        var v = opt.value;
        if (v === "continue" || v === "child") opt.disabled = !hasOpen;
      });
    }
    if (!hasOpen && (modeEl.value === "continue" || modeEl.value === "child")) {
      modeEl.value = "new";
    }
  }

  function formatRelationTaskOption(row) {
    var rawId = String(row.task_id || row.filename || row.id || "").replace(/\.md$/i, "");
    var taskId = taskIdFromItem(row) || rawId.match(/TASK-\d{8}-\d{3}/)?.[0] || rawId;
    var title = String(row.title || row.subject || "").trim();
    var status = String(row.bucket || row.status || "").trim();
    if (!title && rawId && rawId !== taskId) title = rawId;
    return { taskId: taskId, title: title, status: status };
  }

  function renderRelationTaskList(listEl, openTasks, inputType) {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!openTasks.length) {
      var empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = t("taskRelationEmpty");
      listEl.appendChild(empty);
      return;
    }
    var radioName = inputType === "radio" ? "taskRelationPick" : "";
    openTasks.forEach(function (row) {
      var opt = formatRelationTaskOption(row);
      if (!opt.taskId) return;
      var label = document.createElement("label");
      label.className = "task-relation-multi-item";
      var inputHtml =
        '<input type="' +
        inputType +
        '" value="' +
        esc(opt.taskId) +
        '"';
      if (radioName) inputHtml += ' name="' + radioName + '"';
      inputHtml += " /> <span>";
      inputHtml += "<code>" + esc(opt.taskId) + "</code>";
      if (opt.title && opt.title !== opt.taskId) inputHtml += " · " + esc(opt.title);
      if (opt.status) inputHtml += ' · <span class="muted">' + esc(opt.status) + "</span>";
      inputHtml += "</span>";
      label.innerHTML = inputHtml;
      listEl.appendChild(label);
    });
    if (!listEl.children.length) {
      var none = document.createElement("div");
      none.className = "muted";
      none.textContent = t("taskRelationEmpty");
      listEl.appendChild(none);
    }
  }

  function syncTaskSendRelationMode() {
    var modeEl = $("taskSendRelationMode");
    if (!modeEl) return;
    var mode = modeEl.value || "new";
    var singleWrap = $("taskRelationSingleWrap");
    var multiWrap = $("taskRelationMultiWrap");
    var multiLabel = $("taskRelationMultiLabel");
    if (!multiWrap) return;

    var openTasks = getOpenTasksForRelation();
    syncRelationModeOptions(openTasks.length > 0);

    if (singleWrap) singleWrap.classList.add("hidden");

    if (mode === "new") {
      multiWrap.classList.add("hidden");
      return;
    }

    multiWrap.classList.remove("hidden");
    if (multiLabel) {
      multiLabel.textContent = mode === "child" ? t("taskSelectParent") : t("taskSelectReferences");
    }
    var list = $("taskRelationMultiList");
    renderRelationTaskList(list, openTasks, mode === "child" ? "radio" : "checkbox");
  }

  function getTaskRelationPayload() {
    var modeEl = $("taskSendRelationMode");
    var mode = modeEl ? modeEl.value || "new" : "new";
    if (mode === "new") {
      return { relation_mode: "new", references: [], parent_task_id: "", current_task_id: "" };
    }
    if (mode === "child") {
      var listChild = $("taskRelationMultiList");
      var currentId = "";
      if (listChild) {
        var picked = listChild.querySelector('input[type="radio"]:checked');
        if (picked) currentId = String(picked.value || "").trim();
      }
      return {
        relation_mode: "child",
        references: [],
        parent_task_id: currentId,
        current_task_id: currentId,
      };
    }
    if (mode === "continue") {
      var list = $("taskRelationMultiList");
      var out = [];
      if (list) {
        var boxes = list.querySelectorAll && list.querySelectorAll('input[type="checkbox"]');
        if (boxes && boxes.length) {
          boxes.forEach(function (b) {
            if (b && b.checked) out.push(String(b.value || ""));
          });
        }
      }
      return { relation_mode: "continue", references: out, parent_task_id: "", current_task_id: "" };
    }
    return { relation_mode: "new", references: [], parent_task_id: "", current_task_id: "" };
  }

  function getTaskReferencesFromRelationMode() {
    var payload = getTaskRelationPayload();
    return payload.references || [];
  }

  function renderPendingTaskAttachPreview() {
    var preview = $("taskAttachPreview");
    if (!preview) return;
    var pending = Array.isArray(state.pendingTaskAttachments) ? state.pendingTaskAttachments : [];
    preview.innerHTML = "";
    pending.forEach(function (p, idx) {
      preview.innerHTML += buildPendingAttachItemHtml(p, idx);
    });

    if (!preview.dataset.fcopDelBound) {
      preview.dataset.fcopDelBound = "1";
      preview.addEventListener("click", function (ev) {
        var btn = ev.target && ev.target.closest && ev.target.closest(".pending-attach-del");
        if (!btn) return;
        var idx = parseInt(btn.getAttribute("data-index") || "-1", 10);
        if (!Number.isFinite(idx) || idx < 0) return;
        var arr = Array.isArray(state.pendingTaskAttachments) ? state.pendingTaskAttachments : [];
        var item = arr[idx];
        if (item && item.previewUrl) {
          try {
            URL.revokeObjectURL(item.previewUrl);
          } catch (e) {}
        }
        if (arr.length) arr.splice(idx, 1);
        state.pendingTaskAttachments = arr;
        var input = $("taskAttachFile");
        if (input) input.value = "";
        renderPendingTaskAttachPreview();
      });
    }
  }

  function syncTaskAttachFilesFromInput() {
    return syncMobileAttachFilesFromInput("taskAttachFile", "pendingTaskAttachments", renderPendingTaskAttachPreview);
  }

  function renderPendingChatAttachPreview() {
    var preview = $("chatAttachPreview");
    if (!preview) return;
    var pending = Array.isArray(state.pendingChatAttachments) ? state.pendingChatAttachments : [];
    preview.innerHTML = "";
    pending.forEach(function (p, idx) {
      preview.innerHTML += buildPendingAttachItemHtml(p, idx);
    });

    if (!preview.dataset.fcopDelBound) {
      preview.dataset.fcopDelBound = "1";
      preview.addEventListener("click", function (ev) {
        var btn = ev.target && ev.target.closest && ev.target.closest(".pending-attach-del");
        if (!btn) return;
        var idx = parseInt(btn.getAttribute("data-index") || "-1", 10);
        if (!Number.isFinite(idx) || idx < 0) return;
        var arr = Array.isArray(state.pendingChatAttachments) ? state.pendingChatAttachments : [];
        var item = arr[idx];
        if (item && item.previewUrl) {
          try {
            URL.revokeObjectURL(item.previewUrl);
          } catch (e) {}
        }
        if (arr.length) arr.splice(idx, 1);
        state.pendingChatAttachments = arr;
        var input = $("chatAttachFile");
        if (input) input.value = "";
        renderPendingChatAttachPreview();
      });
    }
  }

  function syncChatAttachFilesFromInput() {
    return syncMobileAttachFilesFromInput("chatAttachFile", "pendingChatAttachments", renderPendingChatAttachPreview);
  }

  async function sendQuickTaskFromHome() {
    var title = ($("homeQuickTitle") && $("homeQuickTitle").value.trim()) || "";
    var body = ($("homeQuickBody") && $("homeQuickBody").value.trim()) || "";
    var priority = ($("homeQuickPriority") && $("homeQuickPriority").value) || "P2";
    if (!title || !body) {
      showToast(t("homeSendEmpty"));
      return;
    }
    if (!isBound()) {
      showToast(t("unbound"));
      openBindPage();
      return;
    }
    var confirmMsg = t("taskConfirmSubmit").replace("{title}", title);
    if (!window.confirm(confirmMsg)) return;
    try {
      await api("/api/v2/mobile/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          title: title,
          body: body,
          priority: priority,
          to: "PM",
          relation_mode: "new",
          references: [],
        },
      });
      showToast(t("homeSendOk"));
      if ($("homeQuickTitle")) $("homeQuickTitle").value = "";
      if ($("homeQuickBody")) $("homeQuickBody").value = "";
      await refreshAll();
    } catch (e) {
      showErrorToast(t("homeSendFail") + "：" + userFacingError(e));
    }
  }

  async function sendTaskFromTasksPage() {
    var bodyEl = $("taskSendBodyInput");
    var body = (bodyEl && bodyEl.value.trim()) || "";
    var titleInput = $("taskSendTitleInput");
    var title = (titleInput && titleInput.value.trim()) || "";
    var priorityEl = $("taskSendPriority");
    var priority = (priorityEl && priorityEl.value) || "P2";

    var pending = Array.isArray(state.pendingTaskAttachments) ? state.pendingTaskAttachments : [];
    var hasAttachments = pending.length > 0;

    if (!body && !hasAttachments) {
      showToast(t("taskSendBodyRequired"));
      return;
    }

    if (!title && body) {
      title = body.split(/\r?\n/)[0].trim().slice(0, 120) || body.slice(0, 120);
    }

    if (!isBound()) {
      showToast(t("unbound"));
      openBindPage();
      return;
    }

    var relation = getTaskRelationPayload();
    if (relation.relation_mode === "continue" && (!relation.references || !relation.references.length)) {
      showToast(t("taskRelationPick"));
      return;
    }
    if (relation.relation_mode === "child" && !(relation.parent_task_id || relation.current_task_id)) {
      showToast(t("taskRelationChildPick"));
      return;
    }

    var displayTitle = title || (hasAttachments ? "image-only-task" : "task");
    var confirmMsg = t("taskConfirmSubmit").replace("{title}", displayTitle);
    if (!window.confirm(confirmMsg)) return;
    try {
      var attachmentsMeta = [];
      if (hasAttachments) attachmentsMeta = await uploadPendingAttachments(pending);
      await api("/api/v2/mobile/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          title: title || "",
          body: body || "",
          priority: priority,
          to: "PM",
          attachments: attachmentsMeta && attachmentsMeta.length ? attachmentsMeta : undefined,
          relation_mode: relation.relation_mode,
          references: relation.references && relation.references.length ? relation.references : [],
          parent_task_id: relation.parent_task_id || relation.current_task_id || "",
          current_task_id: relation.current_task_id || relation.parent_task_id || "",
        },
      });
      showToast(t("homeSendOk"));
      if (titleInput) titleInput.value = "";
      if (bodyEl) bodyEl.value = "";
      state.pendingTaskAttachments = [];
      var fileInput = $("taskAttachFile");
      if (fileInput) fileInput.value = "";
      var preview = $("taskAttachPreview");
      if (preview) preview.innerHTML = "";
      await refreshAll();
      syncTaskSendRelationMode();
    } catch (e) {
      showErrorToast(t("homeSendFail") + "：" + userFacingError(e));
    }
  }

  function parseBindFromText(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    try {
      var u = new URL(s);
      var hashQuery = u.hash && u.hash.indexOf("?") >= 0 ? u.hash.slice(u.hash.indexOf("?") + 1) : "";
      var hashParams = new URLSearchParams(hashQuery);
      var explicitApi = u.searchParams.get("api_base") || u.searchParams.get("api") || hashParams.get("api_base") || hashParams.get("api") || "";
      var urlApi = mobileApiBaseFromUrl(u);
      return {
        bind_id: u.searchParams.get("bind_id") || u.searchParams.get("id") || hashParams.get("bind_id") || hashParams.get("id"),
        token: u.searchParams.get("token") || u.searchParams.get("t") || hashParams.get("token") || hashParams.get("t"),
        api_base: explicitApi || urlApi.api_base,
        missing_instance: !explicitApi && urlApi.missing_instance,
      };
    } catch (e) {}
    var m = s.match(/bind_id[=:]([\w-]+)/i);
    var tkn = s.match(/token[=:]([\w.-]+)/i);
    var apiM = s.match(/api_base[=:]([^&\s#]+)/i);
    if (m) {
      var apiBaseFallback = "";
      if (apiM && apiM[1]) {
        try {
          apiBaseFallback = decodeURIComponent(apiM[1]);
        } catch (e2) {
          apiBaseFallback = apiM[1];
        }
      }
      return {
        bind_id: m[1],
        token: tkn ? tkn[1] : "",
        api_base: apiBaseFallback,
        missing_instance: !apiBaseFallback && currentPublicShellNeedsInstance(),
      };
    }
    return null;
  }

  function parseBindFromLocation() {
    var search = new URLSearchParams(window.location.search || "");
    var hash = window.location.hash || "";
    var hashQuery = hash.indexOf("?") >= 0 ? hash.slice(hash.indexOf("?") + 1) : "";
    var hashParams = new URLSearchParams(hashQuery);
    var bindId = search.get("bind_id") || search.get("id") || hashParams.get("bind_id") || hashParams.get("id");
    var token = search.get("token") || search.get("t") || hashParams.get("token") || hashParams.get("t") || "";
    if (!bindId || !String(bindId).trim() || !token || !String(token).trim()) return null;
    var explicitApi = search.get("api_base") || search.get("api") || hashParams.get("api_base") || hashParams.get("api") || "";
    var urlApi = mobileApiBaseFromUrl(window.location);
    return {
      bind_id: String(bindId).trim(),
      token: String(token).trim(),
      api_base: explicitApi || urlApi.api_base,
      missing_instance: !explicitApi && urlApi.missing_instance,
    };
  }

  function getOrCreatePreBindDeviceId() {
    try {
      var existing = localStorage.getItem("cfm_mobile_device_id");
      if (existing) return existing;
    } catch (e) {}
    var newId =
      "mdev-" +
      (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10));
    try {
      localStorage.setItem("cfm_mobile_device_id", newId);
    } catch (e2) {}
    return newId;
  }

  function openBindPage(options) {
    var opts = options || {};
    if (!opts.keepTab) switchTab("home");
    var gate = $("bindGate");
    if (gate) {
      gate.classList.remove("hidden");
      gate.setAttribute("aria-hidden", "false");
    }
    var input = $("bindPasteInput");
    if (input) {
      setTimeout(function () {
        input.focus();
      }, 50);
    }
  }

  function clearBindParamsFromUrl() {
    try {
      var path = window.location.pathname || "/mobile/";
      if (!/\/$/.test(path)) path += "/";
      var hash = window.location.hash || "";
      if (hash && hash.indexOf("?") < 0 && hash.indexOf("bind_id") < 0) {
        history.replaceState(null, "", path + hash);
      } else {
        history.replaceState(null, "", path);
      }
    } catch (e) {}
  }

  function ensureBindControls() {
    var card = document.querySelector("#bindGate .card");
    if (!card) return;
    if (!document.getElementById("bindSystemCameraNote")) {
      var note = document.createElement("p");
      note.id = "bindSystemCameraNote";
      note.className = "muted";
      note.setAttribute("data-i18n", "bindSystemCameraHint");
      note.textContent = t("bindSystemCameraHint");
      card.insertBefore(note, card.firstChild);
    }
    if (!document.getElementById("bindManualId")) {
      var wrap = document.createElement("div");
      wrap.className = "bind-manual-grid";
      wrap.innerHTML =
        '<input id="bindManualId" type="text" data-i18n-placeholder="bindId" placeholder="bind_id" />' +
        '<input id="bindManualToken" type="text" data-i18n-placeholder="bindToken" placeholder="token" />' +
        '<button type="button" class="btn-secondary" id="bindManualBtn" data-i18n="bindSubmit">Confirm bind</button>';
      card.appendChild(wrap);
    }
    applyI18n();
  }

  function bindErrorToastMessage(errText, status) {
    var code = String(parseApiErrorText(errText, status) || "");
    if (
      status === 401 ||
      status === 403 ||
      code === "BIND_TOKEN_INVALID" ||
      code.indexOf("BIND_TOKEN_INVALID") >= 0
    ) {
      if (isBound()) return t("bindAlreadyDone");
      return t("bindTokenInvalid");
    }
    if (status === 403) return t("bindFail403");
    return t("bindFail") + ": " + code;
  }

  async function runBind(parsed) {
    if (!parsed || !parsed.bind_id || !parsed.token) {
      showToast(t("bindInvalid"));
      return false;
    }
    if (bindingInProgress) {
      return false;
    }
    bindingInProgress = true;
    if (
      parsed.missing_instance ||
      (parsed.api_base && !isPlausibleApiBase(parsed.api_base)) ||
      (!parsed.api_base && currentPublicShellNeedsInstance() && !isPlausibleApiBase(getStoredApiBase()))
    ) {
      bindingInProgress = false;
      showToast(bindMissingInstanceMessage(), 5200);
      openBindPage();
      return false;
    }
    var base = "";
    if (parsed.api_base && isPlausibleApiBase(parsed.api_base)) {
      base = String(parsed.api_base).replace(/\/$/, "");
    } else if (isPlausibleApiBase(getStoredApiBase())) {
      base = getStoredApiBase().replace(/\/$/, "");
    } else {
      var resolved = resolveMobileApiBase();
      if (resolved) base = String(resolved).replace(/\/$/, "");
    }
    if (!base) {
      bindingInProgress = false;
      showToast(bindMissingInstanceMessage(), 5200);
      openBindPage();
      return false;
    }
    var bindUrl = base.replace(/\/$/, "") + "/api/v2/mobile/bind-confirm";
    try {
      var res = await fetch(bindUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          bind_id: parsed.bind_id,
          token: parsed.token,
          device_id: getOrCreatePreBindDeviceId(),
          device_name: (navigator.userAgent || "Mobile PWA").slice(0, 120),
        }),
      });
      if (!res.ok) {
        var errText = await res.text().catch(function () {
          return "";
        });
        clearBindParamsFromUrl();
        if (res.status === 401 || res.status === 403) {
          clearSession();
          clearBoundData();
          updateTabBoundState();
          showToast(bindErrorToastMessage(errText, res.status), 5200);
          return false;
        }
        var bindErr = new Error(parseApiErrorText(errText, res.status));
        bindErr.status = res.status;
        bindErr.rawText = errText;
        throw bindErr;
      }
      var data = await res.json();
      var boundToken = extractBindSessionToken(data);
      if (!boundToken) {
        clearBindParamsFromUrl();
        showToast(t("bindSuccessNoToken"), 5200);
        return false;
      }
      var serverApiBase = data.api_base ? String(data.api_base).replace(/\/$/, "") : "";
      var bindApiBase = base;
      if (bindApiBase && isPlausibleApiBase(bindApiBase)) {
        base = bindApiBase;
      } else if (serverApiBase && isPlausibleApiBase(serverApiBase)) {
        base = serverApiBase;
      }
      applyAuthSession(boundToken, data.device_id, base);
      if (!getToken()) {
        showToast(t("bindSuccessNoToken"), 5200);
        return false;
      }
      clearBindParamsFromUrl();
      if ($("bindGate")) $("bindGate").classList.add("hidden");
      Object.keys(state.apiErrors).forEach(function (k) {
        delete state.apiErrors[k];
      });
      showToast(t("bindSuccess"));
      switchTab("home");
      setTimeout(function () {
        refreshAll()
          .catch(function (e) {
            console.warn("refresh after bind failed", e);
          })
          .finally(function () {
            bindingInProgress = false;
          });
      }, 300);
      return true;
    } catch (e) {
      clearBindParamsFromUrl();
      showToast(bindErrorToastMessage(e.rawText || e.message, e.status || 0), 5200);
      return false;
    } finally {
      if (!getToken()) bindingInProgress = false;
    }
  }

  var qrStream = null;
  function stopQr() {
    var modal = $("cfm-qr-scan-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
    }
    if (qrStream) {
      qrStream.getTracks().forEach(function (tr) {
        tr.stop();
      });
      qrStream = null;
    }
    var v = $("cfm-qr-video");
    if (v) v.srcObject = null;
  }

  async function startQrScan(onResult) {
    var modal = $("cfm-qr-scan-modal");
    var video = $("cfm-qr-video");
    var canvas = $("cfm-qr-canvas");
    var status = $("cfm-qr-status");
    if (!modal || !video) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    if (status) status.textContent = t("qrStartingCamera");
    try {
      qrStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      video.srcObject = qrStream;
      await video.play();
      if (status) status.textContent = t("qrScanHint");
      var ctx = canvas.getContext("2d");
      var tick = function () {
        if (modal.classList.contains("hidden")) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          if (window.jsQR) {
            var code = jsQR(img.data, img.width, img.height);
            if (code && code.data) {
              stopQr();
              onResult(code.data);
              return;
            }
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (e) {
      if (status) status.textContent = t("scanCameraDenied");
      var photo = $("cfm-qr-photo");
      if (photo) photo.classList.remove("hidden");
    }
  }

  function decodeQrFile(file, onResult) {
    if (!file || !window.jsQR) {
      showToast(t("scanPhotoFailed"));
      return;
    }
    var img = new Image();
    img.onload = function () {
      var canvas = $("cfm-qr-canvas") || document.createElement("canvas");
      var max = 1400;
      var scale = Math.min(1, max / Math.max(img.width, img.height));
      canvas.width = Math.max(1, Math.floor(img.width * scale));
      canvas.height = Math.max(1, Math.floor(img.height * scale));
      var ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      var data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var code = jsQR(data.data, data.width, data.height);
      if (code && code.data) {
        stopQr();
        onResult(code.data);
      } else {
        showToast(t("scanPhotoFailed"));
      }
      URL.revokeObjectURL(img.src);
    };
    img.onerror = function () {
      showToast(t("scanPhotoFailed"));
    };
    img.src = URL.createObjectURL(file);
  }

  function hideUpdateBar() {
    pwaUpdatePending = false;
    var bar = $("updateBar");
    if (bar) bar.classList.remove("visible");
    syncRefreshBtnUpdateHint();
  }

  window.hideUpdateBarFromDom = function () {
    hideUpdateBar();
  };

  function handleHeaderRefreshClick() {
    var btn = $("headerRefreshBtn");
    if (btn) {
      btn.classList.add("spin");
      setTimeout(function () {
        btn.classList.remove("spin");
      }, 600);
    }
    if (isPwaUpdatePending()) {
      window.doForceUpdate();
      return;
    }
    refreshAll();
  }

  window.doForceUpdate = function () {
    hideUpdateBar();
    var reloadWithBust = function () {
      // 不在重载前写入「已安装」版本——避免缓存未刷新时误判为已更新、更新条永久消失
      try {
        var u = new URL(window.location.href);
        u.searchParams.set("_cfm", String(Date.now()));
        window.location.replace(u.toString());
      } catch (e) {
        window.location.reload();
      }
    };
    var chain = Promise.resolve();
    if ("serviceWorker" in navigator) {
      chain = chain
        .then(function () {
          return navigator.serviceWorker.getRegistration().then(function (reg) {
            if (!reg) return;
            if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
            if (reg.installing) {
              reg.installing.addEventListener("statechange", function () {
                if (reg.installing && reg.installing.state === "installed" && reg.waiting) {
                  reg.waiting.postMessage({ type: "SKIP_WAITING" });
                }
              });
            }
          });
        })
        .then(function () {
          return navigator.serviceWorker.getRegistration().then(function (reg) {
            if (reg && typeof reg.update === "function") {
              return reg.update().catch(function () {});
            }
          });
        });
    }
    chain
      .then(function () {
        if (!("caches" in window)) return;
        return caches.keys().then(function (keys) {
          var names = keys.slice();
          PWA_LEGACY_CACHE_NAMES.forEach(function (legacy) {
            if (names.indexOf(legacy) === -1) names.push(legacy);
          });
          return Promise.all(
            names.map(function (k) {
              return caches.delete(k);
            }),
          );
        });
      })
      .finally(reloadWithBust);
  };

  function registerSw() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("./sw.js?v=" + PWA_CACHE_BUST)
      .then(function (reg) {
        if (reg && typeof reg.update === "function") {
          reg.update().catch(function () {});
        }
        reg.addEventListener("updatefound", function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", function () {
            if (nw.state === "installed" && navigator.serviceWorker.controller) {
              showUpdateBar();
            }
          });
        });
      })
      .catch(function () {});
  }

  function isEditableActive() {
    var active = document.activeElement;
    return !!(active && active.matches && active.matches("input, textarea, select, [contenteditable='true']"));
  }

  /** 保留占位：不再用 --layout-height 驱动 html/body/app-shell（对齐旧版 codeflow-pwa） */
  function initLayoutHeight() {}

  function initKeyboardViewport() {
    var blurTimer = null;

    function setKeyboardOpen(open) {
      document.body.classList.toggle("keyboard-open", !!open);
    }

    document.addEventListener(
      "focusin",
      function (ev) {
        var el = ev.target;
        if (!el || !el.matches) return;
        if (!el.matches("input, textarea, select, [contenteditable='true']")) return;
        clearTimeout(blurTimer);
        setKeyboardOpen(true);
        window.setTimeout(function () {
          var scrollHost = el.closest(".tab-scroll, .fullscreen-page-content, .fp-detail-content");
          if (scrollHost) {
            try {
              el.scrollIntoView({ block: "nearest", behavior: "auto" });
            } catch (e) {
              el.scrollIntoView(true);
            }
          }
        }, 280);
      },
      true
    );

    document.addEventListener(
      "focusout",
      function () {
        clearTimeout(blurTimer);
        blurTimer = window.setTimeout(function () {
          if (isEditableActive()) {
            return;
          }
          setKeyboardOpen(false);
        }, 120);
      },
      true
    );
  }

  function wireEvents() {
    ensureBindControls();
    document.querySelectorAll(".bottom-nav-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        switchTab(btn.getAttribute("data-tab"));
      });
    });
    $("myQuickBtn") &&
      $("myQuickBtn").addEventListener("click", function () {
        switchTab("my");
      });
    $("headerRefreshBtn") &&
      $("headerRefreshBtn").addEventListener("click", function () {
        handleHeaderRefreshClick();
      });
    $("homeViewAllBtn") &&
      $("homeViewAllBtn").addEventListener("click", function () {
        openTasksForSelectedRole(state.selectedRole);
      });
    $("tasksListCollapseBtn") &&
      $("tasksListCollapseBtn").addEventListener("click", function (ev) {
        ev.stopPropagation();
        toggleTasksListCollapsed();
      });
    $("reportsRefreshBtn") &&
      $("reportsRefreshBtn").addEventListener("click", function () {
        refreshAll();
      });
    $("approvalsRefreshBtn") &&
      $("approvalsRefreshBtn").addEventListener("click", function () {
        refreshAll();
      });
    $("activityRefreshBtn") &&
      $("activityRefreshBtn").addEventListener("click", function () {
        if (!isBound()) return;
        loadActivity().then(function () {
          renderActivityList();
        });
      });
    $("taskSendBtn") && $("taskSendBtn").addEventListener("click", sendTaskFromTasksPage);
    $("sendBtn") && $("sendBtn").addEventListener("click", sendQuickTaskFromHome);
    $("targetRole") &&
      $("targetRole").addEventListener("change", function () {
        persistSelectedRole($("targetRole").value);
      });
    $("taskSendRelationMode") &&
      $("taskSendRelationMode").addEventListener("change", function () {
        syncTaskSendRelationMode();
      });

    $("taskAttachBtn") &&
      $("taskAttachBtn").addEventListener("click", function () {
        var input = $("taskAttachFile");
        if (input) input.click();
      });
    $("taskAttachFile") &&
      $("taskAttachFile").addEventListener("change", function () {
        syncTaskAttachFilesFromInput().catch(function () {
          showErrorToast(t("errorImageProcessFailed"));
        });
      });

    $("taskMdImportBtn") &&
      $("taskMdImportBtn").addEventListener("click", function () {
        var input = $("taskMdImportFile");
        if (input) input.click();
      });
    $("taskMdImportFile") &&
      $("taskMdImportFile").addEventListener("change", function () {
        var file = $("taskMdImportFile").files && $("taskMdImportFile").files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onerror = function () {
          showToast(t("importFail"));
        };
        reader.onload = function () {
          var text = String(reader.result || "");
          var body = $("taskSendBodyInput");
          if (body) body.value = text;
          // 若标题为空，则从正文第一行推一个默认标题
          var titleInput = $("taskSendTitleInput");
          if (titleInput && !(titleInput.value && titleInput.value.trim())) {
            var first = text.split(/\r?\n/)[0] || "";
            titleInput.value = first.trim().slice(0, 120);
          }
          showToast(t("importDone"));
          $("taskMdImportFile").value = "";
        };
        reader.readAsText(file);
      });

    $("chatAttachBtn") &&
      $("chatAttachBtn").addEventListener("click", function () {
        var input = $("chatAttachFile");
        if (input) input.click();
      });
    $("chatAttachFile") &&
      $("chatAttachFile").addEventListener("change", function () {
        syncChatAttachFilesFromInput().catch(function () {
          showErrorToast(t("errorImageProcessFailed"));
        });
      });

    $("chatSendBtn") && $("chatSendBtn").addEventListener("click", sendChatMessage);
    $("chatInput") &&
      $("chatInput").addEventListener("keydown", function (ev) {
        // textarea：Enter 换行，Ctrl/Cmd+Enter 发送（手机点「发送」按钮）
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          sendChatMessage();
        }
      });

    // 大图预览：点击任意处关闭 / ESC 关闭
    $("imagePreviewCloseBtn") &&
      $("imagePreviewCloseBtn").addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        closeImagePreview();
      });
    $("imagePreviewModal") &&
      $("imagePreviewModal").addEventListener("click", function (ev) {
        var modal = $("imagePreviewModal");
        if (!modal || !modal.classList.contains("visible")) return;
        ev.preventDefault();
        closeImagePreview();
      });
    window.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeImagePreview();
    });

    $("taskDetailBackBtn") &&
      $("taskDetailBackBtn").addEventListener("click", closeTaskDetail);
    $("fpApprovalApprove") &&
      $("fpApprovalApprove").addEventListener("click", approveCurrentApproval);
    $("fpApprovalReject") &&
      $("fpApprovalReject").addEventListener("click", rejectCurrentApproval);
    $("bindBannerBtn") &&
      $("bindBannerBtn").addEventListener("click", function () {
        openBindPage({ keepTab: true });
      });
    ["tasksUnboundBindBtn", "reportsUnboundBindBtn", "approvalsUnboundBindBtn", "activityUnboundBindBtn"].forEach(
      function (id) {
      var el = $(id);
      if (el) el.addEventListener("click", openBindPage);
    });
    function openBindQr() {
      startQrScan(function (raw) {
        runBind(parseBindFromText(raw));
      });
    }
    ["bindScanBtn", "scanQrBtn"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("click", openBindQr);
    });
    $("bindPasteBtn") &&
      $("bindPasteBtn").addEventListener("click", function () {
        var v = $("bindPasteInput") && $("bindPasteInput").value;
        runBind(parseBindFromText(v));
      });
    $("bindManualBtn") &&
      $("bindManualBtn").addEventListener("click", function () {
        runBind({
          bind_id: $("bindManualId") && $("bindManualId").value.trim(),
          token: $("bindManualToken") && $("bindManualToken").value.trim(),
        });
      });
    $("cfm-qr-photo") &&
      $("cfm-qr-photo").addEventListener("click", function () {
        var file = $("cfm-qr-file");
        if (file) file.click();
      });
    $("cfm-qr-file") &&
      $("cfm-qr-file").addEventListener("change", function () {
        var file = $("cfm-qr-file").files && $("cfm-qr-file").files[0];
        decodeQrFile(file, function (raw) {
          runBind(parseBindFromText(raw));
        });
        $("cfm-qr-file").value = "";
      });
    $("cfm-qr-close") && $("cfm-qr-close").addEventListener("click", stopQr);
    $("clearCacheBtn") &&
      $("clearCacheBtn").addEventListener("click", function () {
        window.doForceUpdate();
      });
    $("rebindBtn") &&
      $("rebindBtn").addEventListener("click", function () {
        clearSession();
        clearBoundData();
        $("bindGate").classList.remove("hidden");
        updateTabBoundState();
        refreshAll();
        showToast(t("settingsRebindHint"));
      });
    $("langZhBtn") &&
      $("langZhBtn").addEventListener("click", function () {
        if (window.CFM_I18N) window.CFM_I18N.setLang("zh");
        applyI18n();
        refreshAll();
      });
    $("langEnBtn") &&
      $("langEnBtn").addEventListener("click", function () {
        if (window.CFM_I18N) window.CFM_I18N.setLang("en");
        applyI18n();
        refreshAll();
      });
    window.addEventListener("online", function () {
      state.online = true;
      updateOfflineBanner();
    });
    window.addEventListener("offline", function () {
      state.online = false;
      updateOfflineBanner();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        clearChatPoll();
        clearActivityPoll();
        return;
      }
      if (state.tab === "chat") {
        loadChatMessages().finally(function () {
          scheduleChatPoll(0);
        });
      }
      if (state.tab === "activity") {
        loadActivity()
          .then(function () {
            renderActivityList({ force: true });
          })
          .finally(function () {
            scheduleActivityPoll(0);
          });
      }
    });
  }

  async function init() {
    loadSelectedRole();
    var incomingBind = parseBindFromLocation();
    var bindFromUrl = !!incomingBind;
    if (bindFromUrl) {
      clearSession();
      try {
        document.documentElement.setAttribute("data-bound", "0");
      } catch (e0) {}
    } else {
      clearInvalidStoredApiBase();
    }

    if (window.CFM_I18N && window.CFM_I18N.applyI18n) window.CFM_I18N.applyI18n();
    applyI18n();

    var bindSucceeded = false;
    if (bindFromUrl) {
      updateTabBoundState();
      bindSucceeded = await runBind(incomingBind);
    }

    await loadMobileVersionManifest();
    wireEvents();
    state.tasksListCollapsed = readTasksListCollapsed();
    syncTasksListCollapsedUI();
    initLayoutHeight();
    initKeyboardViewport();
    registerSw();
    state.online = navigator.onLine !== false;
    updateOfflineBanner();

    if (shouldClearBoundDataOnRefresh()) {
      clearBoundData();
    }
    updateTabBoundState();

    var boundNow = isBound();
    if (!bindSucceeded) {
      await refreshAll();
    }

    if ($("bindGate")) {
      if (boundNow) {
        $("bindGate").classList.add("hidden");
      } else if (bindFromUrl) {
        $("bindGate").classList.remove("hidden");
        $("bindGate").setAttribute("aria-hidden", "false");
      } else {
        $("bindGate").classList.add("hidden");
      }
    }
    if (!bindSucceeded) {
      switchTab("home");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
