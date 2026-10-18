#!/usr/bin/env python3
"""Install Recall and Stop Recall for a Linux desktop with a systemd user session."""

import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys


PROJECT = Path(__file__).resolve().parent.parent


def unit_quote(value, command=False):
    # Unit specifiers and Exec command environment expansions must remain literal.
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
    if command:
        escaped = escaped.replace("$", "$$")
    return '"' + escaped + '"'


def desktop_exec(value):
    # Exec quoting is layered over Desktop Entry string escaping.
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$")
    return '"' + escaped.replace("\\", "\\\\").replace("%", "%%") + '"'


def main():
    if sys.platform != "linux":
        raise RuntimeError("These launchers require a Linux desktop with systemd.")
    for command in ("node", "npm", "systemctl", "xdg-open", "xdg-user-dir"):
        if not shutil.which(command):
            raise RuntimeError(f"Missing {command}. Install the README prerequisites first.")
    session_output = subprocess.check_output(["systemctl", "--user", "show-environment"], text=True)
    session_env = {}
    for line in session_output.splitlines():
        key, separator, value = line.partition("=")
        if separator and key in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"):
            session_env[key] = " ".join(shlex.split(value))
    node = Path(shutil.which("node")).resolve()
    python = Path(sys.executable).resolve()
    launcher = PROJECT / "scripts/linux-launcher.py"
    # Validate/build before installing shortcuts; never install a knowingly broken launch target.
    subprocess.run([str(python), str(launcher), "--node", str(node), "prepare"], check=True)

    # Editors packaged as Snaps can override XDG directories with private app folders.
    # Install into the desktop session's directories, not the editor's sandbox.
    desktop_env = session_env if os.environ.get("SNAP") else os.environ
    desktop_home = Path(desktop_env.get("HOME", str(Path.home())))
    config = Path(desktop_env.get("XDG_CONFIG_HOME", desktop_home / ".config"))
    data = Path(desktop_env.get("XDG_DATA_HOME", desktop_home / ".local/share"))
    gio_env = os.environ.copy()
    if os.environ.get("SNAP"):
        for key in ("GIO_EXTRA_MODULES", "GIO_MODULE_DIR", "LD_LIBRARY_PATH", "GTK_PATH", "GSETTINGS_SCHEMA_DIR"):
            gio_env.pop(key, None)
        gio_env["XDG_DATA_HOME"] = str(data)
    units = config / "systemd/user"
    applications = data / "applications"
    recall_data = data / "recall"
    desktop_value = subprocess.check_output(["xdg-user-dir", "DESKTOP"], text=True).strip()
    desktop = Path(desktop_value) if desktop_value else None
    for directory in (units, applications):
        directory.mkdir(parents=True, exist_ok=True)

    unit = f"""[Unit]
Description=Recall local flashcard workspace

[Service]
Type=exec
WorkingDirectory={str(PROJECT).replace('%', '%%')}
ExecStartPre={unit_quote(python, True)} {unit_quote(launcher, True)} --node {unit_quote(node, True)} prepare
ExecStart={unit_quote(node, True)} {unit_quote(PROJECT / 'server/index.ts', True)} --no-open --host 127.0.0.1 --port 4317 --data-dir {unit_quote(recall_data, True)}
TimeoutStartSec=180
TimeoutStopSec=20
KillSignal=SIGTERM
Restart=no
UMask=0077
"""
    (units / "recall.service").write_text(unit)
    subprocess.run(["systemd-analyze", "--user", "verify", str(units / "recall.service")], check=True)

    for name, action, filename, comment, icon in (
        ("Recall", "start", "recall.desktop", "Start Recall and open your study workspace", str(PROJECT / "public/favicon.svg")),
        ("Stop Recall", "stop", "recall-stop.desktop", "Stop Recall safely and keep your saved progress", "process-stop"),
    ):
        command = " ".join(desktop_exec(value) for value in (python, launcher, "--node", node, action))
        entry = f"""[Desktop Entry]
Version=1.0
Type=Application
Name={name}
Comment={comment}
Exec={command}
Icon={icon}
Terminal=false
Categories=Education;
StartupNotify=false
"""
        targets = [applications / filename]
        if desktop and desktop != Path.home():
            desktop.mkdir(parents=True, exist_ok=True)
            targets.append(desktop / f"{name}.desktop")
        for target in targets:
            target.write_text(entry)
            target.chmod(0o755)
            if shutil.which("desktop-file-validate"):
                subprocess.run(["desktop-file-validate", str(target)], check=True)
            if target.parent == desktop and shutil.which("gio"):
                result = subprocess.run(["gio", "set", str(target), "metadata::trusted", "true"], env=gio_env, capture_output=True)
                if result.returncode:
                    print(f"If prompted, right-click {target.name} and choose Allow Launching.")
            print(f"Installed {target}")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    if shutil.which("update-desktop-database"):
        subprocess.run(["update-desktop-database", str(applications)], check=True)
    print("Recall and Stop Recall are ready. Recall starts only when you launch it, not at login.")
    print("Re-run this installer after moving the project or changing your Node installation.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Could not install Recall launchers: {error}", file=sys.stderr)
        sys.exit(1)
