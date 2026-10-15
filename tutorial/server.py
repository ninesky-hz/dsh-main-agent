#!/usr/bin/env python3
"""在 localhost 上提供教程页面，并暴露它只读的里程碑评分器。"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


TUTORIAL_ROOT = Path(__file__).resolve().parent
GRADER = TUTORIAL_ROOT / "grade.py"
TARGETS = {"doctor", "all", *(f"m{i}" for i in range(8))}


class TutorialHandler(SimpleHTTPRequestHandler):
    server_version = "DSHSupervisorTutorial/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(TUTORIAL_ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path != "/api/grade":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 16_384:
                raise ValueError("请求体太大")
            payload = json.loads(self.rfile.read(length) or b"{}")
            target = payload.get("target")
            workspace = payload.get("workspace")
            if target not in TARGETS:
                raise ValueError("未知的评分器 target")
            if workspace is not None and not isinstance(workspace, str):
                raise ValueError("workspace 必须是字符串")
        except (ValueError, json.JSONDecodeError) as exc:
            self._json(400, {"ok": False, "error": str(exc)})
            return

        command = [sys.executable, str(GRADER), target]
        if workspace and target != "doctor":
            expanded = os.path.expandvars(workspace)
            command.extend(["--ws", str(Path(expanded).expanduser())])
        try:
            result = subprocess.run(
                command,
                cwd=TUTORIAL_ROOT,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                env={**os.environ, "PYTHONUTF8": "1"},
                timeout=180,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            output = (exc.stdout or "") + (exc.stderr or "")
            self._json(504, {"ok": False, "exitCode": None, "output": output,
                             "error": "评分器在 180 秒后超时"})
            return

        output = result.stdout + result.stderr
        self._json(200, {"ok": result.returncode == 0,
                         "exitCode": result.returncode, "output": output})

    def _json(self, status: int, document: dict) -> None:
        body = json.dumps(document).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1",
                        help="监听地址（默认：127.0.0.1）")
    parser.add_argument("--port", type=int, default=0,
                        help="监听端口；0 表示选一个未占用的端口（默认：0）")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), TutorialHandler)
    host, port = server.server_address[:2]
    print(f"教程：http://{host}:{port}/", flush=True)
    print("按 Ctrl-C 停止。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
