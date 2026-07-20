import os
import sys
import json
import subprocess
import threading
from typing import Dict, Any, List, Optional

class McpClient:
    """
    Multi-threaded standard JSON-RPC 2.0 Stdio client for local MCP servers.
    Includes active threading event-waits to prevent main-thread blocks.
    """
    def __init__(self, command: str, args: List[str], cwd: Optional[str] = None, env: Optional[Dict[str, str]] = None):
        self.command = command
        self.args = args
        self.cwd = cwd or os.getcwd()
        self.env = env or os.environ.copy()
        
        self.process: Optional[subprocess.Popen] = None
        self.message_id = 0
        self.pending_resolves: Dict[int, threading.Event] = {}
        self.pending_responses: Dict[int, Dict[str, Any]] = {}
        self.read_thread: Optional[threading.Thread] = None
        self.active = False

    def start(self) -> None:
        """Spawns the MCP subprocess and performs JSON-RPC initialize handshake."""
        # Clean path formatting
        cmd = self.command
        args = list(self.args)
        
        # Enforce Python unbuffered mode to destroy Windows 4KB buffering deadlocks
        is_python = "python" in cmd.lower()
        if is_python:
            self.env["PYTHONUNBUFFERED"] = "1"
            if "-u" not in args:
                args.insert(0, "-u")

        # Resolve windows command shell run requirements
        use_shell = sys.platform == "win32"
        
        # Build node path for proxy mapping if tsx is involved
        if "tsx" in cmd:
            shell_node_modules = os.path.join(self.cwd, "codeflowmu-shell", "node_modules")
            runtime_node_modules = os.path.join(self.cwd, "packages", "codeflowmu-runtime", "node_modules")
            existing_node_path = self.env.get("NODE_PATH", "")
            self.env["NODE_PATH"] = os.path.pathsep.join(filter(None, [shell_node_modules, runtime_node_modules, existing_node_path]))

        print(f"[FCoP SDK] McpClient spawning: \"{cmd}\" {' '.join(args)}")

        self.process = subprocess.Popen(
            [cmd] + args if not use_shell else f"{cmd} {' '.join(args)}",
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr, # Directly pipe stderr to console for debugging
            cwd=self.cwd,
            env=self.env,
            shell=use_shell,
            text=True
        )

        self.active = True
        self.read_thread = threading.Thread(target=self._stdout_loop, daemon=True)
        self.read_thread.start()

        # Initialize Handshake
        init_res = self.call("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "codeflowmu-python-sdk", "version": "1.0.0"}
        })
        
        # Send initialized notification
        self.notify("notifications/initialized", {})
        print("[FCoP SDK] MCP Server handshake successful!")

    def notify(self, method: str, params: Dict[str, Any]) -> None:
        """Sends a JSON-RPC 2.0 notification (instant, without ID, no response expected)."""
        if not self.process or not self.process.stdin:
            raise RuntimeError("MCP process not running")
            
        notification = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }
        raw = json.dumps(notification) + "\n"
        self.process.stdin.write(raw)
        self.process.stdin.flush()

    def call(self, method: str, params: Dict[str, Any], timeout: float = 60.0) -> Dict[str, Any]:
        """Invokes a JSON-RPC 2.0 request and blocks waiting for the response using thread events."""
        if not self.process or not self.process.stdin:
            raise RuntimeError("MCP process not running")

        self.message_id += 1
        msg_id = self.message_id

        request = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "method": method,
            "params": params
        }

        event = threading.Event()
        self.pending_resolves[msg_id] = event

        raw = json.dumps(request) + "\n"
        self.process.stdin.write(raw)
        self.process.stdin.flush()

        # Wait for response thread to signal event
        success = event.wait(timeout)
        self.pending_resolves.pop(msg_id, None)

        if not success:
            raise TimeoutError(f"MCP JSON-RPC request to method '{method}' timed out after {timeout} seconds.")

        response = self.pending_responses.pop(msg_id)
        if "error" in response:
            error_msg = response["error"].get("message", "Unknown MCP Server error")
            raise RuntimeError(f"MCP Server error calling '{method}': {error_msg}")

        return response.get("result", {})

    def _stdout_loop(self) -> None:
        """Background thread reading from subprocess stdout."""
        while self.active and self.process and self.process.stdout:
            try:
                line = self.process.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if not line or not line.startswith("{"):
                    continue # Ignore debug noise
                
                msg = json.loads(line)
                msg_id = msg.get("id")
                if msg_id is not None and msg_id in self.pending_resolves:
                    self.pending_responses[msg_id] = msg
                    self.pending_resolves[msg_id].set()

            except Exception as e:
                print(f"[FCoP SDK] McpClient stdout loop warning: {str(e)}", file=sys.stderr)
                break
                
        self.active = False

    def stop(self) -> None:
        """Tears down the process cleanly."""
        self.active = False
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except Exception:
                self.process.kill()
            self.process = None
        if self.read_thread:
            self.read_thread.join(timeout=1)
