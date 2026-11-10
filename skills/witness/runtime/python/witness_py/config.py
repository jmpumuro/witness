"""Loads .witness/config.json (mirror of runtime/node/lib/config.mjs)."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .util import WITNESS_DIR, read_json

DEFAULT_CONFIG: dict[str, Any] = {
    "version": 1,
    "language": "python",
    "baseURL": "http://localhost:3000",
    "testDir": "tests",
    "roles": {},
    "authSetupCommand": None,
    "browser": {"channel": None, "locale": "en-US", "timezoneId": "UTC", "viewport": [1280, 800]},
    "testIdAttribute": "data-testid",
    "credentialEnv": [],
    "verify": {"repeat": 3, "cpuThrottle": 4},
    "pytestArgs": [],
}


class Paths:
    def __init__(self, project_dir: str | Path):
        self.root = Path(project_dir)
        self.witness = self.root / WITNESS_DIR
        self.config = self.witness / "config.json"
        self.recordings = self.witness / "recordings"
        self.flows = self.witness / "flows"
        self.tmp = self.witness / "tmp"

    def recording(self, flow: str) -> Path:
        return self.recordings / flow

    def flow_meta(self, flow: str) -> Path:
        return self.flows / f"{flow}.json"


def load_config(project_dir: str | Path) -> dict:
    p = Paths(project_dir)
    if not p.config.exists():
        raise RuntimeError(f'No {p.config.relative_to(p.root)} found. Run "python -m witness_py setup" (or /witness:setup) first.')
    user = read_json(p.config)
    cfg = {**DEFAULT_CONFIG, **user}
    cfg["browser"] = {**DEFAULT_CONFIG["browser"], **(user.get("browser") or {})}
    cfg["verify"] = {**DEFAULT_CONFIG["verify"], **(user.get("verify") or {})}
    return cfg


def role_storage(project_dir: str | Path, cfg: dict, role: str | None) -> Path | None:
    if not role or role == "none":
        return None
    r = (cfg.get("roles") or {}).get(role)
    if r is None:
        known = ", ".join(cfg.get("roles") or {}) or "(none configured)"
        raise RuntimeError(f'Unknown role "{role}". Known roles: {known}')
    return (Path(project_dir) / r["storageState"]).resolve() if r.get("storageState") else None


def credential_values(cfg: dict) -> list[dict]:
    names = set(cfg.get("credentialEnv") or [])
    for r in (cfg.get("roles") or {}).values():
        for k in ("usernameEnv", "passwordEnv"):
            if r.get(k):
                names.add(r[k])
    out = []
    for n in sorted(names):
        v = os.environ.get(n)
        if v and len(v) >= 4:
            out.append({"name": n, "value": v})
    return out


def ensure_gitignore(project_dir: str | Path) -> list[str]:
    gi = Path(project_dir) / ".gitignore"
    lines = [".witness/recordings/", ".witness/tmp/"]
    cur = gi.read_text(encoding="utf-8") if gi.exists() else ""
    missing = [l for l in lines if l not in cur.splitlines()]
    if missing:
        if cur and not cur.endswith("\n"):
            cur += "\n"
        gi.write_text(cur + "# Witness: raw recordings may contain personal data; run artifacts are disposable\n" + "\n".join(missing) + "\n", encoding="utf-8")
    return missing
