"""Runs a test file under the Witness pytest plugin (mirror of runtime/node/lib/runner.mjs).

Python needs no mirroring: the plugin patches Playwright's sync classes at import time, so tests run
in place, with the project's own conftest.py and pytest configuration.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .config import Paths
from .util import log, read_json, rel, run, stamp

RUNTIME_DIR = Path(__file__).resolve().parent.parent


def run_spec(project_dir: str | Path, cfg: dict, spec: str | Path, mode: str, *, raw: bool = False, storage: Path | None = None,
             repeat: int = 1, throttle: float = 0, plan: dict | None = None, label: str | None = None) -> dict:
    P = Paths(project_dir)
    spec = Path(spec).resolve()
    if not spec.exists():
        raise RuntimeError(f"Test file not found: {spec}")
    run_dir = P.tmp / f"{label or mode}-{stamp()}"
    evidence_dir = run_dir / "evidence"
    run_dir.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "WITNESS_MODE": mode,
        "WITNESS_EVIDENCE_DIR": str(evidence_dir),
        "WITNESS_TEST_ID_ATTRIBUTE": cfg.get("testIdAttribute") or "data-testid",
        "WITNESS_CPU_THROTTLE": str(throttle or 0),
        "PYTHONPATH": str(RUNTIME_DIR) + os.pathsep + os.environ.get("PYTHONPATH", ""),
    }
    if plan is not None:
        pf = run_dir / "vacuity-plan.json"
        pf.write_text(json.dumps(plan), encoding="utf-8")
        env["WITNESS_VACUITY_PLAN"] = str(pf)
    if raw:
        b = cfg.get("browser") or {}
        overrides = {"locale": b.get("locale"), "timezone_id": b.get("timezoneId")}
        if b.get("viewport"):
            overrides["viewport"] = {"width": b["viewport"][0], "height": b["viewport"][1]}
        if storage:
            overrides["storage_state"] = str(storage)
        env["WITNESS_CONTEXT_OVERRIDES"] = json.dumps(overrides)
        env["WITNESS_ACTION_TIMEOUT_MS"] = "15000"
    cmd = [sys.executable, "-m", "pytest", str(spec), "-p", "witness_py.pytest_plugin", "-q", "-p", "no:cacheprovider",
           "-o", "console_output_style=classic", *(cfg.get("pytestArgs") or [])]
    channel = os.environ.get("WITNESS_BROWSER_CHANNEL") or (cfg.get("browser") or {}).get("channel")
    if channel:
        cmd += ["--browser-channel", channel]
    log(f"running {mode}{f' x{repeat}' if repeat > 1 else ''}{f' (cpu x{throttle:g})' if throttle and throttle > 1 else ''}: {rel(project_dir, spec)}")
    outputs, codes = [], []
    for i in range(max(1, repeat)):
        env["WITNESS_REPEAT_INDEX"] = str(i)
        code, out = run(cmd, cwd=project_dir, env=env, timeout=900)
        outputs.append(out)
        codes.append(code)
    (run_dir / "output.log").write_text("\n".join(outputs), encoding="utf-8")
    evidence = []
    for f in sorted(evidence_dir.glob("*.json")) if evidence_dir.exists() else []:
        e = read_json(f)
        if Path(e["file"]).resolve() == spec:
            e["file"] = rel(project_dir, spec)
            evidence.append(e)
    evidence.sort(key=lambda e: (e.get("repeat", 0), str(e.get("title"))))
    return {"code": max(codes) if codes else 1, "output": "\n".join(outputs), "runDir": str(run_dir), "evidence": evidence}
