"""Witness CLI for pytest-playwright projects (mirror of runtime/node/witness.mjs). Run from the project root.

    python -m witness_py setup   [--base-url URL] [--role name=storageStatePath ...] [--role-env name=USER_ENV,PASS_ENV ...] [--auth-setup "cmd"]
    python -m witness_py doctor
    python -m witness_py record  <flow> [--role r] [--start /path] [--replace] [--dry-run] [--timeout-min 30]
    python -m witness_py import  <flow> --from <dir> [--role r] [--start /path] [--replace]
    python -m witness_py analyze <flow> [--spec path] [--runs 2]
    python -m witness_py verify  <flow> --spec <path> [--repeat N] [--throttle N] [--skip-repeat]
    python -m witness_py lock    <flow>
    python -m witness_py status
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from .analysis import analysis_summary, build_analysis
from .config import DEFAULT_CONFIG, Paths, credential_values, ensure_gitignore, load_config, role_storage
from .har import read_har
from .runner import run_spec
from .util import git_info, log, now_iso, read_json, rel, run, stamp, strip_har_replay, write_json
from .verify import assertion_signature, compare_fidelity, lint, lock_check, secret_scan, vacuity_plan, vacuity_results

PROJECT = Path.cwd()
P = Paths(PROJECT)


class WitnessError(Exception):
    pass


def out(s: str) -> None:
    sys.stdout.write(s if s.endswith("\n") else s + "\n")
    sys.stdout.flush()


def flow_name(f: str | None) -> str:
    if not f:
        raise WitnessError("missing <flow> name")
    if not re.match(r"^[a-z0-9][a-z0-9-_]*$", f, re.I):
        raise WitnessError(f'flow names use letters, digits, - and _ (got "{f}")')
    return f


# ------------------------------------------------------------------ setup / doctor

def cmd_setup(a: argparse.Namespace) -> int:
    has_pkg = (PROJECT / "package.json").exists() and "@playwright/test" in (PROJECT / "package.json").read_text(encoding="utf-8")
    if has_pkg and not any((PROJECT / f).exists() for f in ("pyproject.toml", "requirements.txt", "pytest.ini", "conftest.py")):
        raise WitnessError("this looks like a TypeScript project; use the Node runtime: node <plugin>/skills/witness/runtime/node/witness.mjs setup")
    cfg = read_json(P.config, None) or {**DEFAULT_CONFIG, "roles": {}}
    if a.base_url:
        cfg["baseURL"] = a.base_url
    if a.test_dir:
        cfg["testDir"] = a.test_dir
    if a.auth_setup:
        cfg["authSetupCommand"] = a.auth_setup
    if a.channel:
        cfg["browser"] = {**cfg.get("browser", {}), "channel": a.channel}
    for r in a.role or []:
        name, _, storage = r.partition("=")
        cfg["roles"][name] = {**cfg["roles"].get(name, {}), "storageState": storage or f"playwright/.auth/{name}.json"}
    for r in a.role_env or []:
        name, user, pw = re.split(r"[=:,]", r)[:3]
        cfg["roles"][name] = {**cfg["roles"].get(name, {}), "usernameEnv": user, "passwordEnv": pw}
    write_json(P.config, cfg)
    P.flows.mkdir(parents=True, exist_ok=True)
    added = ensure_gitignore(PROJECT)
    missing = []
    try:
        import pytest_playwright  # noqa: F401
    except ImportError:
        missing.append("pytest-playwright is not installed (pip install pytest-playwright)")
    if not cfg["roles"]:
        missing.append("no roles configured (add --role customer=playwright/.auth/customer.json)")
    if not cfg.get("authSetupCommand"):
        missing.append('no authSetupCommand (e.g. "python -m pytest -q tests/auth_setup.py")')
    import json

    out(f"# Witness setup\n\nWrote {rel(PROJECT, P.config)}" + (f" and added {', '.join(added)} to .gitignore" if added else "") + ".\n\n"
        + "```json\n" + json.dumps(cfg, indent=2) + "\n```\n"
        + ("\nStill needed:\n" + "\n".join(f"- {m}" for m in missing) + "\n" if missing else "\nReady to record.\n"))
    return 0


def cmd_doctor(a: argparse.Namespace) -> int:
    lines = ["# Witness doctor", ""]
    ok = lambda b, m: lines.append(f"- {'ok' if b else 'PROBLEM'}: {m}")  # noqa: E731
    try:
        import playwright
        from importlib.metadata import version

        ok(True, f"playwright {version('playwright')}")
    except Exception as e:  # noqa: BLE001
        ok(False, f"playwright not importable: {e}")
    try:
        import pytest_playwright  # noqa: F401

        ok(True, "pytest-playwright installed")
    except ImportError:
        ok(False, "pytest-playwright not installed")
    try:
        cfg = load_config(PROJECT)
        ok(True, f".witness/config.json (baseURL {cfg['baseURL']})")
        for name, r in cfg["roles"].items():
            ok(bool(r.get("storageState")), f"role {name}: storageState {r.get('storageState')}")
            for k in ("usernameEnv", "passwordEnv"):
                if r.get(k):
                    ok(bool(os.environ.get(r[k])), f"role {name}: env {r[k]} {'set' if os.environ.get(r[k]) else 'NOT set'}")
        try:
            with urllib.request.urlopen(cfg["baseURL"], timeout=5) as resp:
                ok(True, f"app reachable at {cfg['baseURL']} (HTTP {resp.status})")
        except Exception as e:  # noqa: BLE001
            ok(False, f"app not reachable at {cfg['baseURL']}: {e}")
        gi = (PROJECT / ".gitignore").read_text(encoding="utf-8") if (PROJECT / ".gitignore").exists() else ""
        ok(".witness/recordings/" in gi, ".witness/recordings/ is gitignored")
    except Exception as e:  # noqa: BLE001
        ok(False, str(e))
    out("\n".join(lines))
    return 0


# ------------------------------------------------------------------ record / import

def ensure_storage(cfg: dict, role: str | None) -> Path | None:
    storage = role_storage(PROJECT, cfg, role)
    if not storage:
        return None
    if cfg.get("authSetupCommand"):
        log(f"refreshing login state: {cfg['authSetupCommand']}")
        code, o = run(cfg["authSetupCommand"], PROJECT, shell=True, timeout=300)
        if code != 0 or not storage.exists():
            raise WitnessError(f"authSetupCommand failed or did not create {rel(PROJECT, storage)}:\n\n```\n{o[-2000:]}\n```")
    elif not storage.exists():
        raise WitnessError(f'no saved login for role "{role}" at {rel(PROJECT, storage)} and no authSetupCommand configured')
    return storage


def archive_existing(flow: str) -> Path | None:
    d = P.recording(flow)
    if not d.exists():
        return None
    dest = P.recordings / "_history" / flow / stamp()
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(d), str(dest))
    return dest


def update_flow_meta(flow: str, patch: dict) -> dict:
    cur = read_json(P.flow_meta(flow), {})
    nxt = {"flow": flow, **cur, **patch}
    nxt = {k: v for k, v in nxt.items() if v is not None}
    write_json(P.flow_meta(flow), nxt)
    return nxt


def new_version(flow: str, meta: dict) -> dict:
    cur = read_json(P.flow_meta(flow), {})
    version = (cur.get("version") or 0) + 1
    history = [*(cur.get("history") or []), {"version": version, "recordedAt": meta.get("recordedAt"), "author": meta.get("author"), "gitSha": meta.get("gitSha")}]
    nxt = {k: v for k, v in {**cur, "flow": flow, "role": meta.get("role"), "start": meta.get("start"), "version": version, "history": history}.items() if k not in ("checkpoints", "lockedAt")}
    write_json(P.flow_meta(flow), nxt)
    return nxt


def cmd_record(a: argparse.Namespace) -> int:
    flow = flow_name(a.flow)
    cfg = load_config(PROJECT)
    d = P.recording(flow)
    if (d / "raw_test.py").exists() and not a.replace:
        raise WitnessError(f'a recording for "{flow}" already exists. Use /witness:re-record {flow} (record {flow} --replace).')
    role = a.role or next(iter(cfg["roles"]), "none")
    start = a.start or "/"
    # A dry run only prints the command; it must not log in or touch the app.
    storage = role_storage(PROJECT, cfg, role) if a.dry_run else ensure_storage(cfg, role)
    start_url = urljoin(cfg["baseURL"], start)
    origin = "{0.scheme}://{0.netloc}".format(urlsplit(cfg["baseURL"]))
    args = ["playwright", "codegen", start_url, "--target", "python-pytest", "-o", str(d / "raw_test.py"),
            "--save-har", str(d / "network.har"), "--save-har-glob", f"{origin}/**", "--test-id-attribute", cfg.get("testIdAttribute") or "data-testid"]
    b = cfg["browser"]
    if storage:
        args += ["--load-storage", str(storage)]
    if b.get("locale"):
        args += ["--lang", b["locale"]]
    if b.get("timezoneId"):
        args += ["--timezone", b["timezoneId"]]
    if b.get("viewport"):
        args += ["--viewport-size", f"{b['viewport'][0]}, {b['viewport'][1]}"]
    if b.get("channel"):
        args += ["--channel", b["channel"]]
    if a.dry_run:
        out("```\n" + " ".join(f'"{x}"' if " " in x else x for x in args) + "\n```")
        return 0
    archived = archive_existing(flow) if a.replace else None
    d.mkdir(parents=True, exist_ok=True)
    meta = {"flow": flow, "role": role, "start": start, "startUrl": start_url, "baseURL": cfg["baseURL"], "language": "python",
            "recordedAt": now_iso(), **git_info(PROJECT), "status": "recording", "browser": b}
    write_json(d / "meta.json", meta)
    log(f'recording "{flow}" as {role} from {start_url}. Close the browser window when you are done.')
    try:
        code = subprocess.call(args, cwd=PROJECT, timeout=int(a.timeout_min) * 60)
    except subprocess.TimeoutExpired:
        code = 124
    spec = d / "raw_test.py"
    if not spec.exists():
        meta["status"] = "abandoned"
        write_json(d / "meta.json", meta)
        raise WitnessError(f"no recording was saved (codegen exit {code}). Run the command again to retry.")
    source = strip_har_replay(spec.read_text(encoding="utf-8"))
    spec.write_text(source, encoding="utf-8")
    actions = len(re.findall(r"^\s+page\.", source, re.M))
    meta.update(status="recorded", recordedEndedAt=now_iso())
    write_json(d / "meta.json", meta)
    fm = new_version(flow, meta)
    out(f"# Recording saved: {flow}\n\n- {actions} recorded actions\n- raw: {rel(PROJECT, spec)}\n- network: {rel(PROJECT, d / 'network.har')}\n- version: v{fm['version']}"
        + (f" (previous recording archived to {rel(PROJECT, archived)})" if archived else "") + f"\n\nNext: python -m witness_py analyze {flow}")
    return 0


def cmd_import(a: argparse.Namespace) -> int:
    flow = flow_name(a.flow)
    src = Path(getattr(a, "from")).resolve()
    d = P.recording(flow)
    if d.exists() and not a.replace:
        raise WitnessError(f'a recording for "{flow}" already exists (use --replace)')
    cfg = load_config(PROJECT)
    if a.replace:
        archive_existing(flow)
    shutil.copytree(src, d)
    raw = d / "raw_test.py"
    if raw.exists():
        raw.write_text(strip_har_replay(raw.read_text(encoding="utf-8")), encoding="utf-8")
    meta = {"flow": flow, "role": a.role or "none", "start": a.start or "/", "baseURL": cfg["baseURL"], "language": "python",
            "recordedAt": now_iso(), **git_info(PROJECT), **read_json(d / "meta.json", {}), "status": "recorded", "imported": True}
    if a.role:
        meta["role"] = a.role
    write_json(d / "meta.json", meta)
    new_version(flow, meta)
    out(f'Imported recording "{flow}" from {src}.')
    return 0


# ------------------------------------------------------------------ analyze / verify / lock

def cmd_analyze(a: argparse.Namespace) -> int:
    flow = flow_name(a.flow)
    cfg = load_config(PROJECT)
    d = P.recording(flow)
    meta = read_json(d / "meta.json", None)
    if not meta:
        raise WitnessError(f"no recording for \"{flow}\". Run /witness:record {flow} first.")
    spec = Path(a.spec).resolve() if a.spec else d / "raw_test.py"
    storage = ensure_storage(cfg, meta.get("role"))
    runs = []
    for i in range(int(a.runs)):
        r = run_spec(PROJECT, cfg, spec, "observe", raw=True, storage=storage, label=f"analyze-{flow}-{i + 1}")
        if not r["evidence"]:
            raise WitnessError(f"replay {i + 1} produced no evidence. pytest output:\n\n```\n{r['output'][-3000:]}\n```")
        runs.append(r["evidence"][0])
        write_json(d / "evidence" / f"{'prepared' if a.spec else 'raw'}-run-{i + 1}.json", r["evidence"][0])
        # A failed replay says what is wrong; repeating it only repeats the same timeouts.
        if r["evidence"][0]["status"] != "passed" and not a.all_runs:
            if i + 1 < int(a.runs):
                log("replay failed; skipping further runs (use --all-runs to force)")
            break
    har = None if (a.spec and not a.compare_har) else read_har(d / "network.har")
    origin = "{0.scheme}://{0.netloc}".format(urlsplit(cfg["baseURL"]))
    analysis = build_analysis(flow, runs, har, origin)
    analysis["spec"] = rel(PROJECT, spec)
    analysis["kind"] = "prepared" if a.spec else "raw"
    write_json(d / "analysis.json", analysis)
    md = analysis_summary(analysis, "python")
    (d / "analysis.md").write_text(md, encoding="utf-8")
    out(md + f"\nFull detail: {rel(PROJECT, d / 'analysis.json')}")
    return 0


def cmd_verify(a: argparse.Namespace) -> int:
    flow = flow_name(a.flow)
    if not a.spec:
        raise WitnessError("--spec <path to the generated test> is required")
    cfg = load_config(PROJECT)
    d = P.recording(flow)
    analysis = read_json(d / "analysis.json", None)
    if not analysis:
        raise WitnessError(f'no analysis for "{flow}". Run analyze {flow} first.')
    spec = Path(a.spec).resolve()
    report: dict = {"flow": flow, "spec": rel(PROJECT, spec), "verifiedAt": now_iso(), "checks": {}}
    obs = run_spec(PROJECT, cfg, spec, "observe", label=f"verify-{flow}-observe")
    if not obs["evidence"]:
        raise WitnessError(f"the test produced no evidence (did it run?). pytest output:\n\n```\n{obs['output'][-3000:]}\n```")
    ev = obs["evidence"][0]
    if len(obs["evidence"]) > 1:
        report["note"] = f'file has {len(obs["evidence"])} tests; verified the first ("{ev["title"]}")'
    report["checks"]["run"] = {"ok": ev["status"] == "passed", "errors": [] if ev["status"] == "passed" else [f"test {ev['status']}: {ev.get('error') or ''}"]}
    report["checks"]["fidelity"] = compare_fidelity(analysis["baseline"], ev)
    plan = vacuity_plan(ev)
    if ev["status"] == "passed" and plan["assertions"]:
        vac = run_spec(PROJECT, cfg, spec, "vacuity", plan=plan, label=f"verify-{flow}-vacuity")
        report["checks"]["vacuity"] = vacuity_results(plan, vac["evidence"][0]) if vac["evidence"] else {"ok": False, "errors": ["vacuity run produced no evidence"], "warnings": []}
    else:
        report["checks"]["vacuity"] = {"ok": False, "errors": ["skipped: test did not pass"] if plan["assertions"] else ["no locator or page assertions to check"], "warnings": []}
    repeat = int(a.repeat or cfg["verify"].get("repeat") or 3)
    throttle = float(a.throttle if a.throttle is not None else cfg["verify"].get("cpuThrottle", 4))
    if not a.skip_repeat and ev["status"] == "passed":
        rep = run_spec(PROJECT, cfg, spec, "plain", repeat=repeat, throttle=throttle, label=f"verify-{flow}-repeat")
        passed = len([e for e in rep["evidence"] if e["status"] == "passed"])
        first_fail = next((e for e in rep["evidence"] if e["status"] != "passed"), None)
        report["checks"]["repeat"] = {"ok": passed == repeat and len(rep["evidence"]) == repeat, "runs": repeat, "passed": passed, "cpuThrottle": throttle,
                                      "errors": [] if passed == repeat else [f"passed {passed}/{repeat} repeated runs" + (f"; first failure: {(first_fail.get('error') or '').splitlines()[0] if first_fail.get('error') else ''}" if first_fail else "")]}
    else:
        report["checks"]["repeat"] = {"ok": bool(a.skip_repeat), "skipped": True, "errors": [] if a.skip_repeat else ["skipped: test did not pass"], "warnings": ["repeat runs skipped"] if a.skip_repeat else []}
    report["checks"]["lint"] = lint(spec)
    report["checks"]["secrets"] = secret_scan(spec, credential_values(cfg), PROJECT)
    fm = read_json(P.flow_meta(flow), {})
    report["checks"]["lock"] = lock_check(fm, ev)
    report["assertions"] = [{"order": x["order"], "afterStep": x["afterStep"], "locator": x["locator"], "matcher": x["matcher"], "pyMatcher": x.get("pyMatcher"),
                             "isNot": x["isNot"], "args": x["args"], "kwargs": x.get("kwargs"), "signature": assertion_signature(x), "passed": x.get("passed")}
                            for x in ev.get("assertions") or []]
    report["ok"] = all(c["ok"] for c in report["checks"].values())
    write_json(d / "verify-report.json", report)
    write_json(d / "evidence" / "verify-observe.json", ev)
    rp = report["checks"]["repeat"]
    update_flow_meta(flow, {"spec": report["spec"], "lastVerified": {"at": report["verifiedAt"], "ok": report["ok"], "repeat": f"{rp['passed']}/{rp['runs']}" if "passed" in rp else None}})
    names = {"run": "Test passes", "fidelity": "Matches the recording", "vacuity": "Assertions are meaningful", "repeat": "Stable on repeat",
             "lint": "Test hygiene", "secrets": "No credentials in code", "lock": "Assertions match lock"}
    L = [f"# Witness verify: {flow} — {'PASS' if report['ok'] else 'FAIL'}", "", f"Spec: {report['spec']}"]
    if report.get("note"):
        L.append(f"Note: {report['note']}")
    for k, c in report["checks"].items():
        extra = f" ({c['passed']}/{c['runs']}, cpu x{c['cpuThrottle']:g})" if k == "repeat" and c.get("runs") else ""
        extra += f" ({c['stats']['matchedRequired']}/{c['stats']['requiredActions']} recorded actions)" if k == "fidelity" else ""
        L += ["", f"## {'ok' if c['ok'] else 'FAIL'} — {names[k]}{extra}"]
        L += [f"- error: {e}" for e in c.get("errors") or []]
        L += [f"- warning: {w}" for w in c.get("warnings") or []]
        L += [f"- info: {i}" for i in (c.get("info") or [])[:8]]
    L += ["", "## Assertions"] + [f"- after step {x['afterStep']}: {x['locator']}.{'not_' if x['isNot'] else ''}{x.get('pyMatcher') or x['matcher']} {'' if x['passed'] else '(FAILED)'}" for x in report["assertions"]]
    out("\n".join(L))
    return 0 if report["ok"] else 1


def cmd_lock(a: argparse.Namespace) -> int:
    flow = flow_name(a.flow)
    report = read_json(P.recording(flow) / "verify-report.json", None)
    if not report:
        raise WitnessError(f'no verify report for "{flow}"')
    blocking = [k for k, c in report["checks"].items() if k != "lock" and not c["ok"]]
    if blocking:
        raise WitnessError(f"cannot lock: verify has failing checks ({', '.join(blocking)})")
    cps = [{"signature": x["signature"], "locator": x["locator"], "matcher": x["matcher"], "isNot": x["isNot"], "afterStep": x["afterStep"]} for x in report["assertions"] if x.get("locator")]
    update_flow_meta(flow, {"spec": report["spec"], "checkpoints": cps, "lockedAt": now_iso()})
    out(f'Locked {len(cps)} checkpoint(s) for "{flow}" in {rel(PROJECT, P.flow_meta(flow))}:\n' + "\n".join(f"- {c['locator']} {c['signature']}" for c in cps))
    return 0


def cmd_status(a: argparse.Namespace) -> int:
    flows = [read_json(f) for f in sorted(P.flows.glob("*.json"))] if P.flows.exists() else []
    if not flows:
        out("No flows recorded yet. Start with /witness:record <flow>.")
        return 0
    rows = ["| Flow | Version | Spec | Locked | Last verified |", "|---|---|---|---|---|"]
    for f in flows:
        lv = f.get("lastVerified")
        rows.append(f"| {f['flow']} | v{f.get('version', 1)} | {f.get('spec') or '—'} | {str(len(f['checkpoints'])) + ' checkpoints' if f.get('checkpoints') else 'no'} | "
                    + (f"{'pass' if lv['ok'] else 'FAIL'} {lv['at'][:16]}{' (' + lv['repeat'] + ')' if lv.get('repeat') else ''}" if lv else "—") + " |")
    out("\n".join(rows))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m witness_py", description="Witness: turn recorded browser flows into verified Playwright tests.")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("setup")
    s.add_argument("--base-url")
    s.add_argument("--test-dir")
    s.add_argument("--auth-setup")
    s.add_argument("--channel")
    s.add_argument("--role", action="append")
    s.add_argument("--role-env", action="append")
    sub.add_parser("doctor")
    s = sub.add_parser("record")
    s.add_argument("flow")
    s.add_argument("--role")
    s.add_argument("--start")
    s.add_argument("--replace", action="store_true")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--timeout-min", default=30)
    s = sub.add_parser("import")
    s.add_argument("flow")
    s.add_argument("--from", required=True)
    s.add_argument("--role")
    s.add_argument("--start")
    s.add_argument("--replace", action="store_true")
    s = sub.add_parser("analyze")
    s.add_argument("flow")
    s.add_argument("--spec")
    s.add_argument("--runs", default=2)
    s.add_argument("--compare-har", action="store_true")
    s.add_argument("--all-runs", action="store_true")
    s = sub.add_parser("verify")
    s.add_argument("flow")
    s.add_argument("--spec")
    s.add_argument("--repeat")
    s.add_argument("--throttle", type=float)
    s.add_argument("--skip-repeat", action="store_true")
    s = sub.add_parser("lock")
    s.add_argument("flow")
    sub.add_parser("status")
    a = p.parse_args(argv)
    cmds = {"setup": cmd_setup, "doctor": cmd_doctor, "record": cmd_record, "import": cmd_import, "analyze": cmd_analyze,
            "verify": cmd_verify, "lock": cmd_lock, "status": cmd_status}
    if not a.cmd:
        p.print_help()
        return 0
    try:
        return cmds[a.cmd](a)
    except (WitnessError, RuntimeError) as e:
        out(f"**Witness error:** {e}")
        return 2 if isinstance(e, WitnessError) else 1
