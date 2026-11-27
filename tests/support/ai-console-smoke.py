"""Exercise the Windows console Ctrl+C lifecycle on isolated loopback ports."""

import ctypes
import os
from pathlib import Path
from queue import Empty, Queue
from secrets import token_hex
import socket
import subprocess
import sys
from threading import Thread
from time import monotonic, sleep


def port_is_open(port):
    with socket.socket() as connection:
        connection.settimeout(0.5)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def main():
    if os.name != "nt":
        raise SystemExit("This smoke test requires a Windows console.")
    command = sys.argv[1] if len(sys.argv) > 1 else "ai"
    if command not in {"ai", "ai:damage", "ai:identity"}:
        raise SystemExit("Select ai, ai:damage, or ai:identity.")
    with socket.socket() as damage, socket.socket() as identity:
        for probe in (damage, identity):
            probe.bind(("127.0.0.1", 0))
        damage_port, identity_port = (probe.getsockname()[1] for probe in (damage, identity))
    env = {
        **os.environ, "NODE_ENV": "development", "HOST": "127.0.0.1", "VERCEL": "",
        "DB_DRIVER": "mysql", "DB_TARGET": "local", "DB_HOST": "127.0.0.1", "DB_NAME": "ai_console_test",
        "AI_HOST": "127.0.0.1", "AI_PORT": str(damage_port), "IDENTITY_API_PORT": str(identity_port),
        "REGISTRATION_FRAUD_SCREENING_ENABLED": "false", "REGISTRATION_FRAUD_SECRET": token_hex(32),
        "REGISTRATION_CAPTURE_TESSERACT": "", "IDENTITY_RESEARCH_MODEL": "trufor", "TRUFOR_SOURCE": "missing-trufor",
    }
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    child = subprocess.Popen(
        ["cmd.exe", "/d", "/s", "/c", "npm run " + command], cwd=Path(__file__).resolve().parents[2],
        env=env, startupinfo=startup, creationflags=subprocess.CREATE_NEW_CONSOLE, text=True, errors="replace",
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    messages = Queue()

    def drain():
        for line in child.stdout:
            messages.put(line.strip())

    Thread(target=drain, daemon=True).start()
    try:
        deadline = monotonic() + 70
        while monotonic() < deadline and child.poll() is None:
            try:
                line = messages.get(timeout=0.5)
            except Empty:
                continue
            if line.startswith("[AI"):
                print(line, flush=True)
            if line == "[AI] All required services ready":
                break
        else:
            raise RuntimeError(f"{command} never reached readiness.")

        ports = [port for name, port in (("ai:damage", damage_port), ("ai:identity", identity_port))
                 if command in ("ai", name)]
        assert all(port_is_open(port) for port in ports)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.FreeConsole()
        if not kernel.AttachConsole(child.pid):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            assert kernel.SetConsoleCtrlHandler(None, True)
            if not kernel.GenerateConsoleCtrlEvent(0, 0):
                raise ctypes.WinError(ctypes.get_last_error())
            sleep(0.5)
        finally:
            kernel.FreeConsole()
        deadline = monotonic() + 15
        while any(port_is_open(port) for port in ports) and monotonic() < deadline:
            sleep(0.2)
        assert not any(port_is_open(port) for port in ports), "Ctrl+C left a service listening."
        print(f"{command} released its ports after Ctrl+C.", flush=True)
    finally:
        if child.poll() is None:
            subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"], capture_output=True,
                           creationflags=subprocess.CREATE_NO_WINDOW)


if __name__ == "__main__":
    main()
