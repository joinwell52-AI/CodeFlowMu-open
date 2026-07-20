"""Windows Use native host and stdio MCP server.

One-shot mode reads one JSON request from stdin and writes one JSON response.
MCP mode (``--mcp``) serves newline-delimited JSON-RPC for Cursor SDK.
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.parse
from ctypes import wintypes
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


IS_WINDOWS = sys.platform == "win32"
BLOCKED_APPS = {
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "wt.exe",
    "windowsterminal.exe",
    "applicationframehost.exe",
    "clicktodo.exe",
    "textinputhost.exe",
    "msedgewebview2.exe",
    "chatgpt.exe",
    "codex.exe",
    "codeflowmu.exe",
}
PAUSED = False


class HostError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _allowed_apps() -> set[str]:
    return {
        pathlib.Path(part.strip()).name.lower()
        for part in os.environ.get("CODEFLOW_WINDOWS_USE_ALLOW_APPS", "").split(",")
        if part.strip()
    }


def _allowed_paths() -> dict[str, set[str]]:
    try:
        raw = json.loads(os.environ.get("CODEFLOW_WINDOWS_USE_ALLOW_PATHS_JSON", "[]"))
    except json.JSONDecodeError:
        raw = []
    result: dict[str, set[str]] = {}
    for value in raw if isinstance(raw, list) else []:
        normalized = os.path.normcase(os.path.abspath(str(value)))
        app_id = pathlib.Path(normalized).name.lower()
        if app_id:
            result.setdefault(app_id, set()).add(normalized)
    return result


def _target_profiles() -> list[dict[str, Any]]:
    try:
        raw = json.loads(os.environ.get("CODEFLOW_WINDOWS_USE_TARGET_PROFILES_JSON", "[]"))
    except json.JSONDecodeError:
        raw = []
    if not isinstance(raw, list):
        return []
    allowed_keys = {
        "id", "name", "description", "type", "target", "browser", "loginMethod",
        "verificationChannel", "loginInstruction", "usernameSaved", "hasPassword",
        "requiresUser", "loginSummary",
    }
    profiles = [
        {key: value for key, value in item.items() if key in allowed_keys}
        for item in raw if isinstance(item, dict)
    ]
    represented_apps = {
        _normalize_app_id(item.get("target"))
        for item in profiles if item.get("type") == "native"
    }
    for app_id in sorted(_allowed_apps() - represented_apps):
        profiles.append({
            "id": app_id.removesuffix(".exe"),
            "name": app_id,
            "type": "native",
            "target": app_id,
            "loginMethod": "unspecified",
            "verificationChannel": "none",
            "loginInstruction": "",
            "usernameSaved": False,
            "hasPassword": False,
            "requiresUser": True,
            "loginSummary": "登录特征尚未设置；Agent 必须先询问用户，不得自行判断。",
        })
    return profiles


def list_targets(_: dict[str, Any]) -> dict[str, Any]:
    return {
        "targets": _target_profiles(),
        "instruction": "Use the structured login profile; do not infer authentication. Pause for the user when requiresUser is true.",
    }


def _browser_executable(browser: str) -> pathlib.Path:
    executable = "msedge.exe" if browser == "edge" else "chrome.exe"
    candidates = [shutil.which(executable)]
    if browser == "edge":
        candidates.extend([
            os.path.join(os.environ.get("PROGRAMFILES(X86)", ""), "Microsoft", "Edge", "Application", executable),
            os.path.join(os.environ.get("PROGRAMFILES", ""), "Microsoft", "Edge", "Application", executable),
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Edge", "Application", executable),
        ])
    else:
        candidates.extend([
            os.path.join(os.environ.get("PROGRAMFILES", ""), "Google", "Chrome", "Application", executable),
            os.path.join(os.environ.get("PROGRAMFILES(X86)", ""), "Google", "Chrome", "Application", executable),
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "Application", executable),
        ])
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).is_file():
            return pathlib.Path(candidate)
    raise HostError("BROWSER_NOT_FOUND", f"Configured browser executable was not found: {browser}")


def launch_target(args: dict[str, Any]) -> dict[str, Any]:
    _require_windows()
    target_id = str(args.get("target_id") or "").strip().lower()
    if not target_id:
        raise HostError("TARGET_ID_REQUIRED", "target_id from windows.list_targets is required")
    profile = next((item for item in _target_profiles() if str(item.get("id") or "").lower() == target_id), None)
    if profile is None:
        raise HostError("TARGET_NOT_APPROVED", f"Approved target was not found: {target_id}")
    if profile.get("type") == "web":
        url = str(profile.get("target") or "")
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
            raise HostError("TARGET_URL_INVALID", "Configured web target must be an HTTPS URL without embedded credentials")
        browser = "edge" if profile.get("browser") == "edge" else "chrome"
        browser_path = _browser_executable(browser)
        process = subprocess.Popen([str(browser_path), url], cwd=str(browser_path.parent), shell=False, close_fds=True)
        return {
            "target_id": target_id,
            "name": profile.get("name") or target_id,
            "type": "web",
            "browser": browser,
            "process_id": process.pid,
            "launched": True,
            "next": "Continue with the browser-specific capability when available.",
        }
    if profile.get("type") != "native":
        raise HostError("TARGET_TYPE_INVALID", "Configured target type is not supported")
    raw_path = str(profile.get("target") or "")
    path = pathlib.Path(raw_path)
    app_id = _normalize_app_id(raw_path)
    normalized_path = os.path.normcase(os.path.abspath(raw_path))
    if not path.is_absolute() or path.suffix.lower() != ".exe":
        raise HostError("TARGET_PATH_INVALID", "Configured native target is not an absolute EXE path")
    if app_id in BLOCKED_APPS:
        raise HostError("APP_BLOCKED", f"Windows Use cannot launch {app_id}")
    if app_id not in _allowed_apps() or normalized_path not in _allowed_paths().get(app_id, set()):
        raise HostError("TARGET_NOT_APPROVED", "The configured EXE path is not in the active Windows Use authorization")
    if not path.is_file():
        raise HostError("TARGET_NOT_FOUND", f"Configured executable does not exist: {path}")
    existing_windows = [
        item for item in list_apps({})["windows"]
        if item.get("app_id") == app_id and item.get("approved")
    ]
    if existing_windows:
        return {
            "target_id": target_id,
            "name": profile.get("name") or target_id,
            "type": "native",
            "app_id": app_id,
            "launched": False,
            "already_running": True,
            "windows": existing_windows,
            "next": "Reuse the returned window. Do not launch another instance.",
        }
    running_process_ids = _running_processes_for_path(normalized_path)
    if running_process_ids:
        return {
            "target_id": target_id,
            "name": profile.get("name") or target_id,
            "type": "native",
            "app_id": app_id,
            "launched": False,
            "already_running": True,
            "process_ids": running_process_ids,
            "windows": [],
            "next": "The exact executable is already running without a visible window. Call windows.wait_for_app; do not launch again.",
        }
    process = subprocess.Popen([str(path)], cwd=str(path.parent), shell=False, close_fds=True)
    return {
        "target_id": target_id,
        "name": profile.get("name") or target_id,
        "type": "native",
        "app_id": app_id,
        "process_id": process.pid,
        "launched": True,
        "next": "Call windows.list_apps until the application's visible window appears.",
    }


def _normalize_app_id(value: Any) -> str:
    return pathlib.Path(str(value or "").replace("\\", "/")).name.lower()


def _assert_allowed(args: dict[str, Any]) -> str:
    app_id = _normalize_app_id(args.get("app_id"))
    if not app_id:
        raise HostError("APP_ID_REQUIRED", "app_id from windows.list_apps is required")
    if app_id in BLOCKED_APPS:
        raise HostError("APP_BLOCKED", f"Windows Use cannot control {app_id}")
    if app_id not in _allowed_apps():
        raise HostError("APP_APPROVAL_REQUIRED", f"User approval is required for {app_id}")
    return app_id


def _require_windows() -> None:
    if not IS_WINDOWS:
        raise HostError("WINDOWS_ONLY", "Windows Use requires Windows")


if IS_WINDOWS:
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    MOUSEEVENTF_LEFTDOWN = 0x0002
    MOUSEEVENTF_LEFTUP = 0x0004
    MOUSEEVENTF_RIGHTDOWN = 0x0008
    MOUSEEVENTF_RIGHTUP = 0x0010
    MOUSEEVENTF_WHEEL = 0x0800
    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_UNICODE = 0x0004
    INPUT_MOUSE = 0
    INPUT_KEYBOARD = 1
    SW_RESTORE = 9
    HWND_TOP = 0
    HWND_TOPMOST = -1
    HWND_NOTOPMOST = -2
    SWP_NOSIZE = 0x0001
    SWP_NOMOVE = 0x0002
    SWP_SHOWWINDOW = 0x0040
    VK_MENU = 0x12
    ASFW_ANY = -1
    WM_LBUTTONDOWN = 0x0201
    WM_LBUTTONUP = 0x0202
    WM_RBUTTONDOWN = 0x0204
    WM_RBUTTONUP = 0x0205
    MK_LBUTTON = 0x0001
    MK_RBUTTON = 0x0002

    ULONG_PTR = wintypes.WPARAM

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [
            ("uMsg", wintypes.DWORD),
            ("wParamL", wintypes.WORD),
            ("wParamH", wintypes.WORD),
        ]

    class INPUTUNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _anonymous_ = ("u",)
        _fields_ = [("type", wintypes.DWORD), ("u", INPUTUNION)]


def _window_app_id(handle: int) -> str:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))
    path = _process_path(pid.value)
    return pathlib.Path(path).name.lower() if path else f"pid:{pid.value}"


def _window_process_path(handle: int) -> str:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))
    path = _process_path(pid.value)
    return os.path.normcase(os.path.abspath(path)) if path else ""


def _window_handle(raw: Any, expected_app_id: str | None = None) -> int:
    try:
        handle = int(str(raw), 0)
    except (TypeError, ValueError) as exc:
        raise HostError("WINDOW_ID_INVALID", f"Invalid window_id: {raw}") from exc
    if not IS_WINDOWS or not user32.IsWindow(handle):
        raise HostError("WINDOW_NOT_FOUND", f"Window does not exist: {raw}")
    if not user32.IsWindowVisible(handle):
        raise HostError("WINDOW_NOT_VISIBLE", f"Window is not visible: {raw}")
    if expected_app_id and _window_app_id(handle) != expected_app_id:
        raise HostError(
            "WINDOW_APP_MISMATCH",
            f"Window {raw} does not belong to approved app {expected_app_id}",
        )
    expected_paths = _allowed_paths().get(expected_app_id or "", set())
    if expected_paths and _window_process_path(handle) not in expected_paths:
        raise HostError(
            "WINDOW_APP_MISMATCH",
            f"Window {raw} executable path does not match configured target {expected_app_id}",
        )
    return handle


def _process_path(pid: int) -> str:
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return buffer.value
        return ""
    finally:
        kernel32.CloseHandle(handle)


def _running_processes_for_path(expected_path: str) -> list[int]:
    _require_windows()
    process_ids = (wintypes.DWORD * 4096)()
    bytes_returned = wintypes.DWORD()
    if not psapi.EnumProcesses(ctypes.byref(process_ids), ctypes.sizeof(process_ids), ctypes.byref(bytes_returned)):
        return []
    count = min(len(process_ids), bytes_returned.value // ctypes.sizeof(wintypes.DWORD))
    normalized_expected = os.path.normcase(os.path.abspath(expected_path))
    result: list[int] = []
    for index in range(count):
        pid = int(process_ids[index])
        if pid <= 0:
            continue
        process_path = _process_path(pid)
        if process_path and os.path.normcase(os.path.abspath(process_path)) == normalized_expected:
            result.append(pid)
    return result


def list_apps(_: dict[str, Any]) -> dict[str, Any]:
    _require_windows()
    windows: list[dict[str, Any]] = []
    allowed = _allowed_apps()
    profiles = _target_profiles()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        title_buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title_buffer, length + 1)
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        class_buffer = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_buffer, 256)
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        path = _process_path(pid.value)
        app_id = pathlib.Path(path).name.lower() if path else f"pid:{pid.value}"
        allowed_paths = _allowed_paths().get(app_id, set())
        normalized_path = os.path.normcase(os.path.abspath(path)) if path else ""
        approved = (
            app_id in allowed
            and app_id not in BLOCKED_APPS
            and (not allowed_paths or normalized_path in allowed_paths)
        )
        profile = next((item for item in profiles if item.get("type") == "native" and os.path.normcase(os.path.abspath(str(item.get("target") or ""))) == normalized_path), None)
        if profile is None:
            profile = next((item for item in profiles if item.get("type") == "native" and _normalize_app_id(item.get("target")) == app_id), None)
        windows.append(
            {
                "app_id": app_id,
                "process_id": pid.value,
                "approved": approved,
                "executable": path if approved else "",
                "window_id": f"0x{int(hwnd):X}",
                "title": title_buffer.value if approved else "<approval required>",
                "class_name": class_buffer.value,
                "foreground": int(hwnd) == int(user32.GetForegroundWindow()),
                "minimized": bool(user32.IsIconic(hwnd)),
                "rect": {
                    "left": rect.left,
                    "top": rect.top,
                    "width": rect.right - rect.left,
                    "height": rect.bottom - rect.top,
                },
                **({"target_profile": profile} if approved and profile else {}),
            }
        )
        return True

    user32.EnumWindows(callback, 0)
    return {"windows": windows}


def wait_for_app(args: dict[str, Any]) -> dict[str, Any]:
    _require_windows()
    app_id = _assert_allowed(args)
    timeout_ms = max(0, min(int(args.get("timeout_ms", 10_000)), 15_000))
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        windows = [
            item for item in list_apps({})["windows"]
            if item.get("app_id") == app_id and item.get("approved")
        ]
        if windows:
            return {"found": True, "app_id": app_id, "windows": windows}
        if time.monotonic() >= deadline:
            return {"found": False, "app_id": app_id, "windows": [], "timeout_ms": timeout_ms}
        time.sleep(0.25)


def capabilities(_: dict[str, Any]) -> dict[str, Any]:
    pillow_available = True
    pywinauto_available = True
    try:
        import PIL  # noqa: F401
    except ImportError:
        pillow_available = False
    try:
        import pywinauto  # noqa: F401
    except ImportError:
        pywinauto_available = False
    return {
        "platform": sys.platform,
        "windows": IS_WINDOWS,
        "window_discovery": IS_WINDOWS,
        "send_input": IS_WINDOWS,
        "screenshot": IS_WINDOWS and pillow_available,
        "ui_automation": IS_WINDOWS and pywinauto_available,
        "mcp": True,
        "paused": PAUSED,
    }


def pause_session(_: dict[str, Any]) -> dict[str, Any]:
    global PAUSED
    PAUSED = True
    return {"cancelled": True, "paused": True, "scope": "current_mcp_session"}


def resume_session(_: dict[str, Any]) -> dict[str, Any]:
    global PAUSED
    PAUSED = False
    return {"resumed": True, "paused": False, "scope": "current_mcp_session"}


def session_status(_: dict[str, Any]) -> dict[str, Any]:
    return {"paused": PAUSED, "scope": "current_mcp_session"}


def _window_rect(hwnd: int) -> tuple[int, int, int, int]:
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise HostError("WINDOW_BOUNDS_FAILED", "Unable to read window bounds")
    return rect.left, rect.top, rect.right, rect.bottom


def screenshot(args: dict[str, Any]) -> dict[str, Any]:
    _require_windows()
    app_id = _assert_allowed(args)
    hwnd = _window_handle(args.get("window_id"), app_id)
    try:
        from PIL import ImageGrab
    except ImportError as exc:
        raise HostError("SCREENSHOT_UNAVAILABLE", "Install Pillow for screenshots") from exc
    bbox = _window_rect(hwnd)
    image = ImageGrab.grab(bbox=bbox, all_screens=True)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return {
        "window_id": f"0x{hwnd:X}",
        "width": image.width,
        "height": image.height,
        "mime_type": "image/png",
        "image_base64": base64.b64encode(buffer.getvalue()).decode("ascii"),
    }


def _focus(hwnd: int) -> None:
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    foreground = int(user32.GetForegroundWindow() or 0)
    current_thread = int(kernel32.GetCurrentThreadId())
    target_thread = int(user32.GetWindowThreadProcessId(hwnd, None) or 0)
    foreground_thread = int(user32.GetWindowThreadProcessId(foreground, None) or 0) if foreground else 0
    attached: list[tuple[int, int]] = []
    try:
        pairs = {(current_thread, target_thread), (current_thread, foreground_thread), (foreground_thread, target_thread)}
        for source_thread, target_input_thread in pairs:
            if source_thread and target_input_thread and source_thread != target_input_thread and user32.AttachThreadInput(source_thread, target_input_thread, True):
                attached.append((source_thread, target_input_thread))
        try:
            user32.AllowSetForegroundWindow(ASFW_ANY)
        except Exception:
            pass
        user32.ShowWindow(hwnd, SW_RESTORE)
        user32.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
        user32.BringWindowToTop(hwnd)
        user32.SetActiveWindow(hwnd)
        user32.SetForegroundWindow(hwnd)
        user32.SetFocus(hwnd)
    finally:
        for source_thread, target_input_thread in reversed(attached):
            user32.AttachThreadInput(source_thread, target_input_thread, False)
    if int(user32.GetForegroundWindow() or 0) != int(hwnd):
        try:
            user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            user32.keybd_event(VK_MENU, 0, 0, 0)
            user32.SetForegroundWindow(hwnd)
            user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
            user32.BringWindowToTop(hwnd)
            user32.SetActiveWindow(hwnd)
            user32.SetFocus(hwnd)
        except Exception:
            pass
    time.sleep(0.12)
    if int(user32.GetForegroundWindow() or 0) != int(hwnd):
        raise HostError("FOCUS_FAILED", "Windows foreground lock prevented activation; ask the user to click the approved window once")


def activate(args: dict[str, Any]) -> dict[str, Any]:
    _require_windows()
    app_id = _assert_allowed(args)
    hwnd = _window_handle(args.get("window_id"), app_id)
    _focus(hwnd)
    return {"app_id": app_id, "window_id": f"0x{hwnd:X}", "foreground": True, "minimized": False}


def _send_inputs(inputs: list[Any]) -> None:
    if not inputs:
        return
    array = (INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), array, ctypes.sizeof(INPUT))
    if sent != len(inputs):
        raise HostError("SEND_INPUT_FAILED", f"SendInput accepted {sent}/{len(inputs)} events")


def click(args: dict[str, Any]) -> dict[str, Any]:
    _require_windows()
    app_id = _assert_allowed(args)
    hwnd = _window_handle(args.get("window_id"), app_id)
    left, top, right, bottom = _window_rect(hwnd)
    x = int(args.get("x", 0))
    y = int(args.get("y", 0))
    if not (0 <= x < right - left and 0 <= y < bottom - top):
        raise HostError("COORDINATE_OUT_OF_BOUNDS", "Click coordinates are outside the window")
    button = str(args.get("button", "left")).lower()
    down, up = (
        (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
        if button == "right"
        else (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    )
    try:
        _focus(hwnd)
    except HostError as exc:
        if exc.code != "FOCUS_FAILED":
            raise
        point = wintypes.POINT(left + x, top + y)
        user32.ScreenToClient(hwnd, ctypes.byref(point))
        lparam = (int(point.y) & 0xFFFF) << 16 | (int(point.x) & 0xFFFF)
        message_down, message_up, key_state = (
            (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON)
            if button == "right" else (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON)
        )
        if not user32.PostMessageW(hwnd, message_down, key_state, lparam):
            raise HostError("BACKGROUND_CLICK_FAILED", "Unable to deliver a bounded click to the approved window")
        user32.PostMessageW(hwnd, message_up, 0, lparam)
        return {"window_id": f"0x{hwnd:X}", "clicked": True, "x": x, "y": y, "method": "window_message", "foreground": False}
    user32.SetCursorPos(left + x, top + y)
    _send_inputs([
        INPUT(type=INPUT_MOUSE, mi=MOUSEINPUT(0, 0, 0, down, 0, 0)),
        INPUT(type=INPUT_MOUSE, mi=MOUSEINPUT(0, 0, 0, up, 0, 0)),
    ])
    return {"window_id": f"0x{hwnd:X}", "clicked": True, "x": x, "y": y, "method": "send_input", "foreground": True}


def type_text(args: dict[str, Any]) -> dict[str, Any]:
    _require_windows()
    app_id = _assert_allowed(args)
    hwnd = _window_handle(args.get("window_id"), app_id)
    text = str(args.get("text", ""))
    _focus(hwnd)
    units = [int.from_bytes(text.encode("utf-16-le")[i : i + 2], "little") for i in range(0, len(text.encode("utf-16-le")), 2)]
    events: list[Any] = []
    for unit in units:
        events.append(INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(0, unit, KEYEVENTF_UNICODE, 0, 0)))
        events.append(INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0)))
    _send_inputs(events)
    return {"window_id": f"0x{hwnd:X}", "typed": True, "text_length": len(text)}


KEYS = {
    "CTRL": 0x11,
    "CONTROL": 0x11,
    "SHIFT": 0x10,
    "ALT": 0x12,
    "ENTER": 0x0D,
    "TAB": 0x09,
    "ESC": 0x1B,
    "ESCAPE": 0x1B,
    "BACKSPACE": 0x08,
    "DELETE": 0x2E,
    "UP": 0x26,
    "DOWN": 0x28,
    "LEFT": 0x25,
    "RIGHT": 0x27,
    "HOME": 0x24,
    "END": 0x23,
    "PAGEUP": 0x21,
    "PAGEDOWN": 0x22,
}


def _virtual_key(name: str) -> int:
    upper = name.upper()
    if upper in KEYS:
        return KEYS[upper]
    if len(upper) == 1 and upper.isalnum():
        return ord(upper)
    if upper.startswith("F") and upper[1:].isdigit() and 1 <= int(upper[1:]) <= 12:
        return 0x70 + int(upper[1:]) - 1
    raise HostError("KEY_NOT_ALLOWED", f"Unsupported key: {name}")


def keypress(args: dict[str, Any]) -> dict[str, Any]:
    _require_windows()
    app_id = _assert_allowed(args)
    hwnd = _window_handle(args.get("window_id"), app_id)
    keys = args.get("keys")
    if not isinstance(keys, list) or not keys or len(keys) > 5:
        raise HostError("KEYS_INVALID", "keys must contain 1 to 5 key names")
    codes = [_virtual_key(str(key)) for key in keys]
    _focus(hwnd)
    events = [INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(code, 0, 0, 0, 0)) for code in codes]
    events += [INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(code, 0, KEYEVENTF_KEYUP, 0, 0)) for code in reversed(codes)]
    _send_inputs(events)
    return {"window_id": f"0x{hwnd:X}", "pressed": [str(key).upper() for key in keys]}


def scroll(args: dict[str, Any]) -> dict[str, Any]:
    _require_windows()
    app_id = _assert_allowed(args)
    hwnd = _window_handle(args.get("window_id"), app_id)
    left, top, right, bottom = _window_rect(hwnd)
    x = int(args.get("x", (right - left) // 2))
    y = int(args.get("y", (bottom - top) // 2))
    delta = int(args.get("delta", 0))
    _focus(hwnd)
    user32.SetCursorPos(left + x, top + y)
    _send_inputs([INPUT(type=INPUT_MOUSE, mi=MOUSEINPUT(0, 0, delta, MOUSEEVENTF_WHEEL, 0, 0))])
    return {"window_id": f"0x{hwnd:X}", "scrolled": delta}


def _uia_window(args: dict[str, Any]) -> Any:
    app_id = _assert_allowed(args)
    hwnd = _window_handle(args.get("window_id"), app_id)
    try:
        from pywinauto import Desktop
    except ImportError as exc:
        raise HostError("UIA_UNAVAILABLE", "Install pywinauto for UI Automation") from exc
    return Desktop(backend="uia").window(handle=hwnd), hwnd


def inspect_ui(args: dict[str, Any]) -> dict[str, Any]:
    _require_windows()
    window, hwnd = _uia_window(args)
    limit = max(1, min(int(args.get("limit", 200)), 1000))
    elements = []
    for control in window.descendants()[:limit]:
        info = control.element_info
        rect = info.rectangle
        elements.append(
            {
                "title": info.name,
                "automation_id": info.automation_id,
                "control_type": info.control_type,
                "enabled": bool(info.enabled),
                "visible": bool(info.visible),
                "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
            }
        )
    return {"window_id": f"0x{hwnd:X}", "elements": elements, "truncated": len(elements) >= limit}


def invoke_ui(args: dict[str, Any]) -> dict[str, Any]:
    _require_windows()
    window, hwnd = _uia_window(args)
    selector = args.get("selector")
    if not isinstance(selector, dict) or not selector:
        raise HostError("SELECTOR_REQUIRED", "selector is required")
    kwargs = {}
    if selector.get("automation_id"):
        kwargs["auto_id"] = str(selector["automation_id"])
    if selector.get("title"):
        kwargs["title"] = str(selector["title"])
    if selector.get("control_type"):
        kwargs["control_type"] = str(selector["control_type"])
    control = window.child_window(**kwargs).wrapper_object()
    try:
        control.invoke()
        method = "uia_invoke"
    except Exception:
        try:
            control.click()
            method = "uia_message"
        except Exception:
            _focus(hwnd)
            control.click_input()
            method = "send_input"
    return {"window_id": f"0x{hwnd:X}", "invoked": True, "selector": selector, "method": method}


COMMANDS = {
    "capabilities": capabilities,
    "list_targets": list_targets,
    "launch_target": launch_target,
    "list_apps": list_apps,
    "wait_for_app": wait_for_app,
    "activate": activate,
    "screenshot": screenshot,
    "inspect_ui": inspect_ui,
    "click": click,
    "type_text": type_text,
    "keypress": keypress,
    "scroll": scroll,
    "invoke_ui": invoke_ui,
    "cancel": pause_session,
    "status": session_status,
    "resume": resume_session,
}


def _safe_args(args: dict[str, Any]) -> dict[str, Any]:
    safe = {}
    for key, value in args.items():
        if key == "text":
            text = str(value or "")
            safe["text_length"] = len(text)
            safe["text_sha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
        elif key not in {"image", "image_base64", "screenshot"}:
            safe[key] = value
    return safe


def _audit(command: str, args: dict[str, Any], ok: bool, started: float, error_code: str | None = None) -> None:
    root = pathlib.Path(os.environ.get("FCOP_PROJECT_DIR") or os.getcwd())
    directory = root / "fcop" / "logs" / "runtime"
    try:
        directory.mkdir(parents=True, exist_ok=True)
        key = time.strftime("%Y%m%d")
        record = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "event_type": "windows_use_action",
            "tool": f"windows.{command}",
            "app_id": _normalize_app_id(args.get("app_id")) or None,
            "window_id": args.get("window_id"),
            "ok": ok,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "args": _safe_args(args),
        }
        if error_code:
            record["error_code"] = error_code
        with (directory / f"windows-use-{key}.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    command = str(request.get("command") or "")
    args = request.get("args") or {}
    if not isinstance(args, dict):
        return {"ok": False, "error": {"code": "ARGS_INVALID", "message": "args must be an object"}}
    if PAUSED and command not in {"cancel", "status", "resume", "capabilities"}:
        return {"ok": False, "error": {"code": "WINDOWS_USE_PAUSED", "message": "Windows Use is paused for the current MCP session; explicit user instruction is required before windows.resume"}}
    handler = COMMANDS.get(command)
    if not handler:
        return {"ok": False, "error": {"code": "COMMAND_UNKNOWN", "message": f"Unknown command: {command}"}}
    started = time.monotonic()
    try:
        result = handler(args)
        _audit(command, args, True, started)
        return {"ok": True, "result": result}
    except HostError as exc:
        _audit(command, args, False, started, exc.code)
        return {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except Exception as exc:
        _audit(command, args, False, started, "HOST_FAILED")
        return {"ok": False, "error": {"code": "HOST_FAILED", "message": str(exc)}}


def _tool(name: str, description: str, properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "object", "properties": properties, "additionalProperties": False}
    if required:
        schema["required"] = required
    return {"name": name, "description": description, "inputSchema": schema}


TARGET = {
    "app_id": {"type": "string", "description": "Application id from windows.list_apps"},
    "window_id": {"type": "string", "description": "Window id from windows.list_apps"},
}


MCP_TOOLS = [
    _tool("windows.capabilities", "Inspect Windows Use host capabilities.", {}),
    _tool("windows.list_targets", "List approved application targets and their structured login profiles. Call this before handling login. Passwords are never returned; pause for the user when requiresUser is true.", {}),
    _tool("windows.launch_target", "Open an approved configured target by target_id: start its exact native EXE or open its exact HTTPS URL in the configured Chrome/Edge browser. Arbitrary paths, URLs, commands, and arguments are rejected. Call windows.list_apps afterward for native targets.", {"target_id": {"type": "string", "description": "Approved target id from windows.list_targets"}}, ["target_id"]),
    _tool("windows.list_apps", "List visible top-level windows on the active desktop, including a matching structured target_profile when configured.", {}),
    _tool("windows.wait_for_app", "Wait up to 15 seconds for an approved app window after launch. Use this instead of Shell sleep.", {"app_id": TARGET["app_id"], "timeout_ms": {"type": "integer", "minimum": 0, "maximum": 15000}}, ["app_id"]),
    _tool("windows.activate", "Restore and robustly activate an approved window before interaction.", TARGET, ["app_id", "window_id"]),
    _tool("windows.screenshot", "Capture an approved visible window as PNG base64.", TARGET, ["app_id", "window_id"]),
    _tool("windows.inspect_ui", "Inspect UI Automation controls in an approved window.", {**TARGET, "limit": {"type": "integer", "minimum": 1, "maximum": 1000}}, ["app_id", "window_id"]),
    _tool("windows.click", "Click window-relative coordinates in an approved app.", {**TARGET, "x": {"type": "integer"}, "y": {"type": "integer"}, "button": {"type": "string", "enum": ["left", "right"]}}, ["app_id", "window_id", "x", "y"]),
    _tool("windows.type_text", "Type Unicode text into an approved foreground app.", {**TARGET, "text": {"type": "string"}}, ["app_id", "window_id", "text"]),
    _tool("windows.keypress", "Send a bounded keyboard chord to an approved app.", {**TARGET, "keys": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 5}}, ["app_id", "window_id", "keys"]),
    _tool("windows.scroll", "Scroll an approved app window.", {**TARGET, "delta": {"type": "integer"}, "x": {"type": "integer"}, "y": {"type": "integer"}}, ["app_id", "window_id", "delta"]),
    _tool("windows.invoke_ui", "Invoke a UI Automation control in an approved app.", {**TARGET, "selector": {"type": "object", "properties": {"automation_id": {"type": "string"}, "title": {"type": "string"}, "control_type": {"type": "string"}}, "additionalProperties": False}}, ["app_id", "window_id", "selector"]),
    _tool("windows.cancel", "Pause Windows Use for the current MCP session. Subsequent discovery and desktop actions are rejected until explicit resume.", {}),
    _tool("windows.status", "Read the real Windows Use pause state for the current MCP session.", {}),
    _tool("windows.resume", "Resume a paused Windows Use MCP session only after the user explicitly asks to resume.", {}),
]


def _mcp_content(payload: dict[str, Any], command: str) -> list[dict[str, Any]]:
    if command == "screenshot" and payload.get("ok"):
        result = dict(payload.get("result") or {})
        image_data = str(result.pop("image_base64", ""))
        content: list[dict[str, Any]] = [
            {"type": "text", "text": json.dumps({"ok": True, "result": result}, ensure_ascii=False)}
        ]
        if image_data:
            content.append({"type": "image", "data": image_data, "mimeType": "image/png"})
        return content
    return [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]


def serve_mcp() -> None:
    for raw in sys.stdin.buffer:
        message: dict[str, Any] | None = None
        try:
            message = json.loads(raw.decode("utf-8"))
            method = message.get("method")
            request_id = message.get("id")
            if request_id is None:
                continue
            if method == "initialize":
                result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "codeflowmu-windows-use", "version": "0.1.0"}}
            elif method == "tools/list":
                result = {"tools": MCP_TOOLS}
            elif method == "tools/call":
                params = message.get("params") or {}
                name = str(params.get("name") or "")
                command = name.removeprefix("windows.")
                response = dispatch({"command": command, "args": params.get("arguments") or {}})
                result = {"content": _mcp_content(response, command), "isError": not response.get("ok", False)}
            else:
                raise HostError("METHOD_NOT_FOUND", f"Unsupported MCP method: {method}")
            reply = {"jsonrpc": "2.0", "id": request_id, "result": result}
        except Exception as exc:
            reply = {"jsonrpc": "2.0", "id": message.get("id") if isinstance(message, dict) else None, "error": {"code": -32603, "message": str(exc)}}
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def main() -> None:
    if "--mcp" in sys.argv:
        serve_mcp()
        return
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except Exception as exc:
        response = {"ok": False, "error": {"code": "HOST_PROTOCOL_ERROR", "message": str(exc)}}
    else:
        response = dispatch(request)
    sys.stdout.write(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()
