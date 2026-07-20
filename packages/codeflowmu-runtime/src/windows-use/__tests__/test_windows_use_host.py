from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import Mock, patch


HOST_PATH = pathlib.Path(__file__).parents[1] / "host" / "windows_use_host.py"
SPEC = importlib.util.spec_from_file_location("windows_use_host", HOST_PATH)
assert SPEC and SPEC.loader
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


class WindowsUseHostTests(unittest.TestCase):
    def setUp(self) -> None:
        host.PAUSED = False

    def test_capabilities_is_json_serializable(self) -> None:
        payload = host.dispatch({"command": "capabilities", "args": {}})
        json.dumps(payload)
        self.assertTrue(payload["ok"])
        self.assertIsInstance(payload["result"]["ui_automation"], bool)

    def test_blocked_app_cannot_be_allowlisted(self) -> None:
        with patch.dict(os.environ, {"CODEFLOW_WINDOWS_USE_ALLOW_APPS": "powershell.exe"}):
            with self.assertRaises(host.HostError) as caught:
                host._assert_allowed({"app_id": "powershell.exe"})
        self.assertEqual(caught.exception.code, "APP_BLOCKED")

    @unittest.skipUnless(os.name == "nt", "Windows-only window enumeration")
    def test_unapproved_window_titles_are_masked(self) -> None:
        with patch.dict(os.environ, {"CODEFLOW_WINDOWS_USE_ALLOW_APPS": ""}):
            result = host.dispatch({"command": "list_apps", "args": {}})
        self.assertTrue(result["ok"])
        windows = result["result"]["windows"]
        self.assertGreater(len(windows), 0)
        self.assertTrue(all(item["title"] == "<approval required>" for item in windows))
        self.assertTrue(all(item["executable"] == "" for item in windows))

    def test_mcp_screenshot_uses_image_content(self) -> None:
        payload = {
            "ok": True,
            "result": {
                "window_id": "0x1",
                "mime_type": "image/png",
                "image_base64": "YWJj",
            },
        }
        content = host._mcp_content(payload, "screenshot")
        self.assertEqual(content[1], {"type": "image", "data": "YWJj", "mimeType": "image/png"})
        self.assertNotIn("YWJj", content[0]["text"])

    def test_list_targets_returns_login_profile_without_password(self) -> None:
        profiles = [{
            "id": "company-erp",
            "name": "Company ERP",
            "type": "web",
            "target": "https://erp.example.com",
            "loginMethod": "verification_code",
            "verificationChannel": "sms",
            "requiresUser": True,
            "hasPassword": False,
            "loginSummary": "需要短信验证码。",
            "password": "must-not-leak",
        }]
        with patch.dict(os.environ, {"CODEFLOW_WINDOWS_USE_TARGET_PROFILES_JSON": json.dumps(profiles)}):
            payload = host.dispatch({"command": "list_targets", "args": {}})
        self.assertTrue(payload["ok"])
        target = payload["result"]["targets"][0]
        self.assertEqual(target["loginMethod"], "verification_code")
        self.assertTrue(target["requiresUser"])
        self.assertNotIn("password", target)

    @unittest.skipUnless(os.name == "nt", "Windows-only process launch")
    def test_launch_target_uses_only_the_approved_exact_executable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = pathlib.Path(directory) / "client.exe"
            executable.touch()
            profiles = [{"id": "company-client", "name": "Company Client", "type": "native", "target": str(executable)}]
            env = {
                "CODEFLOW_WINDOWS_USE_ALLOW_APPS": "client.exe",
                "CODEFLOW_WINDOWS_USE_ALLOW_PATHS_JSON": json.dumps([str(executable)]),
                "CODEFLOW_WINDOWS_USE_TARGET_PROFILES_JSON": json.dumps(profiles),
            }
            fake_process = Mock(pid=12345)
            with patch.dict(os.environ, env), patch.object(host.subprocess, "Popen", return_value=fake_process) as popen:
                payload = host.dispatch({"command": "launch_target", "args": {"target_id": "company-client"}})
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["result"]["process_id"], 12345)
            popen.assert_called_once_with([str(executable)], cwd=str(executable.parent), shell=False, close_fds=True)

    @unittest.skipUnless(os.name == "nt", "Windows-only process launch")
    def test_launch_target_rejects_arbitrary_paths(self) -> None:
        with patch.dict(os.environ, {"CODEFLOW_WINDOWS_USE_TARGET_PROFILES_JSON": "[]"}, clear=False):
            payload = host.dispatch({"command": "launch_target", "args": {"target_id": "C:\\Windows\\notepad.exe"}})
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "TARGET_NOT_APPROVED")

    @unittest.skipUnless(os.name == "nt", "Windows-only browser launch")
    def test_launch_web_target_uses_configured_browser_and_exact_url(self) -> None:
        url = "https://erp.example.com/app"
        profiles = [{"id": "company-web", "name": "Company Web", "type": "web", "target": url, "browser": "edge"}]
        fake_browser = pathlib.Path("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe")
        fake_process = Mock(pid=23456)
        with patch.dict(os.environ, {"CODEFLOW_WINDOWS_USE_TARGET_PROFILES_JSON": json.dumps(profiles)}), \
                patch.object(host, "_browser_executable", return_value=fake_browser), \
                patch.object(host.subprocess, "Popen", return_value=fake_process) as popen:
            payload = host.dispatch({"command": "launch_target", "args": {"target_id": "company-web"}})
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["result"]["browser"], "edge")
        popen.assert_called_once_with([str(fake_browser), url], cwd=str(fake_browser.parent), shell=False, close_fds=True)

    @unittest.skipUnless(os.name == "nt", "Windows-only window wait")
    def test_wait_for_app_replaces_shell_sleep(self) -> None:
        visible = {"app_id": "client.exe", "approved": True, "window_id": "0x1"}
        with patch.dict(os.environ, {"CODEFLOW_WINDOWS_USE_ALLOW_APPS": "client.exe"}), \
                patch.object(host, "list_apps", side_effect=[{"windows": []}, {"windows": [visible]}]), \
                patch.object(host.time, "sleep"):
            payload = host.dispatch({"command": "wait_for_app", "args": {"app_id": "client.exe", "timeout_ms": 1000}})
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["result"]["found"])
        self.assertEqual(payload["result"]["windows"][0]["window_id"], "0x1")

    @unittest.skipUnless(os.name == "nt", "Windows-only foreground activation")
    def test_focus_restores_and_attaches_input_threads(self) -> None:
        class FakeUser32:
            foreground = 200
            calls: list[tuple] = []
            def IsIconic(self, hwnd): return True
            def ShowWindow(self, *args): self.calls.append(("ShowWindow", *args)); return True
            def GetForegroundWindow(self): return self.foreground
            def GetWindowThreadProcessId(self, hwnd, _pid): return 20 if hwnd == 100 else 30
            def AttachThreadInput(self, *args): self.calls.append(("AttachThreadInput", *args)); return True
            def SetWindowPos(self, *args): self.calls.append(("SetWindowPos", *args)); return True
            def BringWindowToTop(self, *args): return True
            def SetActiveWindow(self, *args): return True
            def SetForegroundWindow(self, hwnd): self.foreground = hwnd; return True
            def SetFocus(self, *args): return True
        fake_user32 = FakeUser32()
        fake_kernel32 = Mock()
        fake_kernel32.GetCurrentThreadId.return_value = 10
        with patch.object(host, "user32", fake_user32), patch.object(host, "kernel32", fake_kernel32), patch.object(host.time, "sleep"):
            host._focus(100)
        self.assertEqual(fake_user32.foreground, 100)
        self.assertTrue(any(call[0] == "ShowWindow" for call in fake_user32.calls))
        self.assertTrue(any(call[0] == "AttachThreadInput" and call[-1] is True for call in fake_user32.calls))

    @unittest.skipUnless(os.name == "nt", "Windows-only UI Automation")
    def test_invoke_ui_does_not_require_foreground_focus(self) -> None:
        control = Mock()
        window = Mock()
        window.child_window.return_value.wrapper_object.return_value = control
        with patch.object(host, "_uia_window", return_value=(window, 0x123)), \
                patch.object(host, "_focus", side_effect=AssertionError("focus must not run before InvokePattern")):
            result = host.invoke_ui({"selector": {"automation_id": "Form.okButton"}})
        control.invoke.assert_called_once_with()
        self.assertEqual(result["method"], "uia_invoke")

    @unittest.skipUnless(os.name == "nt", "Windows-only background click")
    def test_click_falls_back_to_bounded_window_message_when_focus_is_locked(self) -> None:
        fake_user32 = Mock()
        fake_user32.ScreenToClient.return_value = True
        fake_user32.PostMessageW.return_value = True
        focus_error = host.HostError("FOCUS_FAILED", "locked")
        with patch.object(host, "_assert_allowed", return_value="client.exe"), \
                patch.object(host, "_window_handle", return_value=0x123), \
                patch.object(host, "_window_rect", return_value=(10, 20, 510, 420)), \
                patch.object(host, "_focus", side_effect=focus_error), \
                patch.object(host, "user32", fake_user32):
            result = host.click({"app_id": "client.exe", "window_id": "0x123", "x": 100, "y": 80, "button": "left"})
        self.assertEqual(result["method"], "window_message")
        self.assertFalse(result["foreground"])
        self.assertEqual(fake_user32.PostMessageW.call_count, 2)

    def test_cancel_creates_a_real_session_pause_until_explicit_resume(self) -> None:
        cancelled = host.dispatch({"command": "cancel", "args": {}})
        self.assertTrue(cancelled["ok"])
        self.assertTrue(cancelled["result"]["paused"])
        blocked = host.dispatch({"command": "list_targets", "args": {}})
        self.assertFalse(blocked["ok"])
        self.assertEqual(blocked["error"]["code"], "WINDOWS_USE_PAUSED")
        status = host.dispatch({"command": "status", "args": {}})
        self.assertTrue(status["result"]["paused"])
        resumed = host.dispatch({"command": "resume", "args": {}})
        self.assertFalse(resumed["result"]["paused"])
        available = host.dispatch({"command": "list_targets", "args": {}})
        self.assertTrue(available["ok"])

    @unittest.skipUnless(os.name == "nt", "Windows-only idempotent launch")
    def test_launch_target_reuses_an_existing_approved_window(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = pathlib.Path(directory) / "client.exe"
            executable.touch()
            profile = {"id": "company-client", "name": "Company Client", "type": "native", "target": str(executable)}
            existing = {"app_id": "client.exe", "approved": True, "window_id": "0xABC", "minimized": True}
            env = {
                "CODEFLOW_WINDOWS_USE_ALLOW_APPS": "client.exe",
                "CODEFLOW_WINDOWS_USE_ALLOW_PATHS_JSON": json.dumps([str(executable)]),
                "CODEFLOW_WINDOWS_USE_TARGET_PROFILES_JSON": json.dumps([profile]),
            }
            with patch.dict(os.environ, env), patch.object(host, "list_apps", return_value={"windows": [existing]}), \
                    patch.object(host.subprocess, "Popen") as popen:
                payload = host.dispatch({"command": "launch_target", "args": {"target_id": "company-client"}})
            self.assertTrue(payload["ok"])
            self.assertTrue(payload["result"]["already_running"])
            self.assertFalse(payload["result"]["launched"])
            popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
