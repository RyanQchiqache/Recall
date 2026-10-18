#!/usr/bin/env python3
"""Start/stop the Recall user service, with a checked build and browser readiness."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request


PROJECT = Path(__file__).resolve().parent.parent
UNIT = "recall.service"
URL = "http://127.0.0.1:4317"
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
PORT = 4317


def needs_build():
    index = PROJECT / "dist/index.html"
    if not index.is_file():
        return True
    inputs = [PROJECT / name for name in (
        "index.html", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json",
    )]
    for directory in ("src", "shared", "public"):
        inputs.extend(p for p in (PROJECT / directory).rglob("*") if p.is_file())
    return any(p.stat().st_mtime_ns > index.stat().st_mtime_ns for p in inputs)


def prepare(node):
    version = subprocess.check_output([node, "--version"], text=True).strip()
    if tuple(map(int, version.lstrip("v").split("."))) < (22, 18, 0):
        raise RuntimeError("Recall needs Node 22.18 or newer. Install Node 24 and rerun the launcher installer.")
    if not (PROJECT / "node_modules").is_dir():
        raise RuntimeError(f"Dependencies are missing. Run npm ci in {PROJECT}, then try again.")
    if needs_build():
        print("Building Recall…", flush=True)
        env = {**os.environ, "PATH": f"{Path(node).parent}:{os.environ.get('PATH', '')}"}
        subprocess.run(["npm", "run", "build"], cwd=PROJECT, env=env, check=True)


def service(*args):
    return subprocess.run(["systemctl", "--user", *args, UNIT], text=True, capture_output=True)


def active():
    return service("is-active", "--quiet").returncode == 0


def main_pid():
    result = service("show", "--property=MainPID", "--value")
    try:
        return int(result.stdout.strip()) if result.returncode == 0 else 0
    except ValueError:
        return 0


def owns_port(pid):
    """Confirm the service process, rather than an unrelated process, owns Recall's port."""
    if pid <= 0:
        return False
    try:
        sockets = {
            target.removeprefix("socket:[").removesuffix("]")
            for fd in Path(f"/proc/{pid}/fd").iterdir()
            if (target := os.readlink(fd)).startswith("socket:[")
        }
        for table in ("/proc/net/tcp", "/proc/net/tcp6"):
            for line in Path(table).read_text().splitlines()[1:]:
                fields = line.split()
                if int(fields[1].rsplit(":", 1)[1], 16) == PORT and fields[3] == "0A" and fields[9] in sockets:
                    return True
    except (OSError, ValueError):
        return False
    return False


def ready(pid):
    if not active() or main_pid() != pid or not owns_port(pid):
        return False
    try:
        with HTTP.open(f"{URL}/api/health", timeout=2) as response:
            health = json.load(response)
        if health.get("ok") is not True or health.get("version") != json.loads((PROJECT / "package.json").read_text())["version"]:
            return False
        expected = (PROJECT / "dist/index.html").read_bytes()
        with HTTP.open(URL, timeout=2) as response:
            if response.read() != expected:
                return False
        for asset in re.findall(rb'(?:src|href)="(/assets/[^"<>]+)"', expected):
            with HTTP.open(URL + asset.decode(), timeout=2) as response:
                if response.read() != (PROJECT / "dist" / asset.decode().lstrip("/")).read_bytes():
                    return False
        return True
    except (OSError, ValueError, urllib.error.URLError):
        return False


def notify(message):
    if shutil.which("notify-send"):
        try:
            subprocess.run(["notify-send", "--app-name=Recall", "Recall", message],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
        except (OSError, subprocess.SubprocessError):
            pass  # Desktop notifications are optional, not a startup dependency.


def control(action, no_open):
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime:
        raise RuntimeError("Open Recall from your Linux desktop session; the user service manager is unavailable.")
    # Serialize double-clicks and simultaneous start/stop operations.
    with (Path(runtime) / "recall-launcher.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action == "stop":
            result = service("stop")
            if result.returncode:
                raise RuntimeError(result.stderr.strip() or "Could not stop Recall.")
            if not no_open:
                notify("Recall stopped. Your study progress is saved.")
            return

        if not no_open:
            notify("Starting Recall…")
        # systemd owns the process: never identify/kill another app by port or a loose name match.
        command = "restart" if active() and needs_build() else "start"
        result = service(command)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or "Recall could not start.")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if not active():
                break
            pid = main_pid()
            if ready(pid):
                if not no_open:
                    subprocess.Popen(["xdg-open", URL], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     start_new_session=True, close_fds=True)
                print(f"Recall is ready at {URL}")
                return
            time.sleep(0.25)
        raise RuntimeError("Recall did not become ready. Port 4317 may already be in use, or startup failed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("action", choices=("start", "stop", "prepare"))
    parser.add_argument("--no-open", action="store_true", help="Check startup without opening a browser")
    args = parser.parse_args()
    try:
        if args.action == "prepare":
            if not args.node:
                raise RuntimeError("Node.js was not found. Install Node 24 and reinstall the launchers.")
            prepare(args.node)
        else:
            control(args.action, args.no_open)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        message = f"{error}\n\nSee the startup log with:\njournalctl --user -u recall.service -n 60 --no-pager"
        print(message, file=sys.stderr)
        if args.action != "prepare" and not args.no_open and shutil.which("zenity"):
            subprocess.run(["zenity", "--error", "--no-markup", "--title=Recall", f"--text={message}"], check=False)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
