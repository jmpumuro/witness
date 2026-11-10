"""Shared helpers for the Witness Python runtime (mirror of runtime/node/lib/util.mjs)."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WITNESS_DIR = ".witness"
MUTATING = {"POST", "PUT", "PATCH", "DELETE"}

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_HEX = re.compile(r"^[0-9a-f]{16,}$", re.I)
_IDLIKE = re.compile(r"^[A-Za-z]{0,4}[-_]?\d[\w-]*$")


def read_json(path: str | Path, fallback: Any = ...) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        if fallback is not ...:
            return fallback
        raise RuntimeError(f"Could not read {path}: {e}") from e


def write_json(path: str | Path, data: Any) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def stamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-").replace("+00-00", "Z")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def template_path(p: str | None) -> str | None:
    """Replace id-like path segments with :id so calls can be compared across runs."""
    if not p:
        return p
    pathname = str(p).split("?")[0]
    out = []
    for seg in pathname.split("/"):
        if not seg:
            out.append(seg)
        elif seg.isdigit() or _UUID.match(seg) or _HEX.match(seg):
            out.append(":id")
        elif re.search(r"\d", seg) and _IDLIKE.match(seg):
            out.append(":id")
        else:
            out.append(seg)
    return "/".join(out)


def query_keys(p: str) -> str:
    s = str(p)
    if "?" not in s:
        return ""
    from urllib.parse import parse_qsl

    return "&".join(sorted(k for k, _ in parse_qsl(s.split("?", 1)[1], keep_blank_values=True)))


def status_class(s: Any) -> str:
    if s is None:
        return "none"
    return f"{str(s)[0]}xx"


def digits_masked(s: str) -> str:
    return re.sub(r"\d+", "#", str(s))


def regex_for(s: str) -> str:
    esc = re.sub(r"([.*+?^${}()|\[\]\\/])", r"\\\1", str(s))
    return re.sub(r"\d+", r"\\d+", esc)


def strip_har_replay(src: str) -> str:
    """Remove the route_from_har call codegen adds with --save-har: replays must hit the live app, not the HAR."""
    return re.sub(r"^[ \t]*(?:await[ \t]+)?(?:page|context)\.route_from_har\([^\n]*\)[ \t]*\r?\n", "", str(src), flags=re.M)


def run(cmd: list[str] | str, cwd: str | Path, env: dict | None = None, timeout: int | None = None, shell: bool = False) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, cwd=str(cwd), env=env, capture_output=True, text=True, timeout=timeout, shell=shell)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired as e:
        return 124, f"{e.stdout or ''}{e.stderr or ''}\n[witness] timed out after {timeout}s\n"


def git_info(cwd: str | Path) -> dict:
    code, email = run(["git", "config", "user.email"], cwd)
    code2, sha = run(["git", "rev-parse", "--short", "HEAD"], cwd)
    return {"author": email.strip() or None if code == 0 else None, "gitSha": sha.strip() if code2 == 0 else None}


def rel(base: str | Path, p: str | Path) -> str:
    return os.path.relpath(str(p), str(base)).replace(os.sep, "/")


def log(*a: Any) -> None:
    sys.stderr.write("[witness] " + " ".join(str(x) for x in a) + "\n")
    sys.stderr.flush()
