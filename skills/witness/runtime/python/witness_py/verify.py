"""Checks a generated test against the raw-replay baseline (mirror of runtime/node/lib/verify.mjs)."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .analysis import action_class, lcs, mutations_of
from .util import status_class, template_path

VALUE_METHODS = ("fill", "type", "pressSequentially", "press", "selectOption", "goto")


def _sig(step: dict) -> dict:
    cls = action_class(step["method"])
    t = step.get("target") or {}
    a = step.get("args") if isinstance(step.get("args"), list) else []
    return {
        "index": step["index"], "class": cls, "role": t.get("role"), "name": t.get("name"),
        "testId": (t.get("attrs") or {}).get("testId"), "label": (t.get("attrs") or {}).get("label"),
        "locator": t.get("locator"), "value": (a[0] if a else None) if step["method"] in VALUE_METHODS else None,
        "nav": template_path(re.sub(r"^https?://[^/]+", "", str((a[0] if a else "") or ""))) if cls == "nav" else None,
    }


def _same_action(b: dict, g: dict) -> bool:
    cls = lambda x: "input" if x == "key" else x  # noqa: E731
    if cls(b["class"]) != cls(g["class"]):
        return False
    if b["class"] == "nav":
        return b.get("nav") == g.get("nav")
    if b.get("role") and g.get("role") and b.get("name") and g.get("name"):
        return b["role"] == g["role"] and b["name"].lower() == g["name"].lower()
    if b.get("testId") and g.get("testId"):
        return b["testId"] == g["testId"]
    if b.get("label") and g.get("label"):
        return b["label"] == g["label"]
    if b.get("role") and g.get("role") and not b.get("name") and not g.get("name"):
        return b["role"] == g["role"]
    return False


def _fmt(a: dict) -> str:
    return (a["class"] + (f" {a['nav']}" if a.get("nav") else "") + (f" {a['role']}" if a.get("role") else "")
            + (f' "{a["name"]}"' if a.get("name") else "") + (f" [testid={a['testId']}]" if a.get("testId") else ""))


def compare_fidelity(baseline: dict, ev: dict) -> dict:
    errors, warnings, info = [], [], []
    gen = [_sig(s) for s in ev.get("steps") or []]
    base = baseline["actions"]
    required = [a for a in base if not a.get("optional")]
    r = lcs(base, gen, _same_action, lambda a: 1 if a.get("optional") else 1000)
    for a in r["onlyA"]:
        if a.get("optional"):
            info.append(f"dropped optional step {a['index']} ({a['optional']}): {_fmt(a)}")
        else:
            errors.append(f"missing action from the recording: step {a['index']} {_fmt(a)}")
    for g in r["onlyB"]:
        if g["class"] in ("hover", "nav"):
            warnings.append(f"extra action not in the recording: {_fmt(g)}")
        else:
            errors.append(f"extra action not in the recording: {_fmt(g)} ({g.get('locator') or ''})")
    for b, g in r["pairs"]:
        if b.get("value") is not None and g.get("value") is not None and json.dumps(b["value"]) != json.dumps(g["value"]) and b["class"] != "nav":
            info.append(f"value substituted at recorded step {b['index']}: {json.dumps(b['value'])} → {json.dumps(g['value'])}")
    matched_required = len([1 for b, _ in r["pairs"] if not b.get("optional")])

    gen_nav = [template_path(x["path"]) for x in ev.get("requests") or [] if x.get("sameOrigin") and x.get("resourceType") == "document"]
    gen_nav = [x for i, x in enumerate(gen_nav) if i == 0 or x != gen_nav[i - 1]]
    nc = lcs(baseline["navigation"], gen_nav, lambda a, b: a == b)
    errors += [f"page visited in the recording but not by the test: {n}" for n in nc["onlyA"]]
    warnings += [f"page visited by the test but not in the recording: {n}" for n in nc["onlyB"]]

    gen_mut = [{"method": m["method"], "template": m["template"], "statusClass": status_class(m["status"])} for m in mutations_of(ev)]
    mc = lcs(baseline["mutations"], gen_mut, lambda a, b: a["method"] == b["method"] and a["template"] == b["template"])
    errors += [f"app call in the recording missing from the test: {m['method']} {m['template']} ({m['statusClass']})" for m in mc["onlyA"]]
    errors += [f"app call made by the test but not in the recording: {m['method']} {m['template']} ({m['statusClass']})" for m in mc["onlyB"]]
    for a, b in mc["pairs"]:
        if a["statusClass"] != b["statusClass"]:
            errors.append(f"app call {a['method']} {a['template']} returned {b['statusClass']}, recording had {a['statusClass']}")
    return {"ok": not errors, "errors": errors, "warnings": warnings, "info": info,
            "stats": {"requiredActions": len(required), "matchedRequired": matched_required, "generatedActions": len(gen)}}


def vacuity_plan(ev: dict) -> dict:
    assertions = [
        {k: a.get(k) for k in ("order", "afterStep", "kind", "matcher", "pyMatcher", "isNot", "args", "kwargs", "selector", "locator")}
        for a in ev.get("assertions") or [] if a.get("kind") in ("locator", "page") and a.get("afterStep") is not None and a["afterStep"] >= 0
    ]
    values = [{"step": s["index"], "value": s["args"][0]} for s in ev.get("steps") or []
              if s["method"] in ("fill", "type", "pressSequentially", "selectOption") and isinstance(s.get("args"), list) and s["args"] and isinstance(s["args"][0], str)]
    return {"assertions": assertions, "values": values}


def _desc(p: dict) -> str:
    args = [json.dumps(x) for x in p.get("args") or [] if not (isinstance(x, dict) and "$regex" not in x)]
    return f"{p.get('locator')}{'.not' if p.get('isNot') else ''}.{p.get('pyMatcher') or p.get('matcher')}({', '.join(args)})"


def vacuity_results(plan: dict, ev: dict) -> dict:
    errors, warnings = [], []
    by_order = {v["order"]: v for v in ev.get("vacuity") or []}
    for p in plan["assertions"]:
        r = by_order.get(p["order"])
        if not r or not r.get("checked"):
            warnings.append(f"could not check whether assertion is vacuous: {_desc(p)}")
        elif r.get("passedBeforeAction"):
            errors.append(f"vacuous assertion (already true before the action it follows, step {p['afterStep']}): {_desc(p)}")
    return {"ok": not errors, "errors": errors, "warnings": warnings, "checked": len(plan["assertions"])}


def assertion_signature(a: dict) -> str:
    args = [x for x in a.get("args") or [] if not (isinstance(x, dict) and "$regex" not in x and "$locator" not in x)]
    kw = {k: v for k, v in (a.get("kwargs") or {}).items() if k not in ("timeout",)}
    sig = f"{'not.' if a.get('isNot') else ''}{a.get('matcher')}({json.dumps(args, separators=(',', ':'), ensure_ascii=False)}"
    return sig + (f",{json.dumps(kw, sort_keys=True, separators=(',', ':'))})" if kw else ")")


def lock_check(flow_meta: dict | None, ev: dict) -> dict:
    if not flow_meta or not flow_meta.get("checkpoints"):
        return {"ok": True, "locked": False, "errors": [], "warnings": ["assertions are not locked yet (run `lock` after the first passing verify)"]}
    want = sorted(c["signature"] for c in flow_meta["checkpoints"])
    have = sorted(assertion_signature(a) for a in ev.get("assertions") or [] if a.get("kind") != "value")
    w, h = list(want), list(have)
    for s in want:
        if s in h:
            h.remove(s)
            w.remove(s)
    errors = [f"locked checkpoint missing or changed: {s}" for s in w] + [f"assertion not in the locked set: {s}" for s in h]
    if errors:
        errors.append("Assertions can only change through a re-record (/witness:re-record).")
    return {"ok": not errors, "locked": True, "errors": errors, "warnings": []}


LINT = [
    (re.compile(r"wait_for_timeout\s*\(|time\.sleep\s*\("), "uses a fixed sleep (wait_for_timeout/time.sleep hide timing bugs); wait on an expect() assertion instead", "error"),
    (re.compile(r"\.pause\s*\(\s*\)"), "contains page.pause()", "error"),
    (re.compile(r"nth-child|nth-of-type"), "uses positional CSS (nth-child/nth-of-type)", "error"),
    (re.compile(r"locator\(\s*['\"](?:#|\.|div|span|button|input|//)"), "uses a CSS/XPath locator; prefer role, label or test id (fine only when no accessible alternative exists)", "warning"),
    (re.compile(r"\.(first|last)\b(?!\s*\()|\.nth\(\d+\)"), "uses .first/.last/.nth(); scope the locator to a row or list item instead", "warning"),
]


def lint(spec_file: str | Path) -> dict:
    src = Path(spec_file).read_text(encoding="utf-8")
    errors, warnings = [], []
    for rx, msg, level in LINT:
        if rx.search(src):
            (errors if level == "error" else warnings).append(msg)
    n = len(re.findall(r"\bexpect\s*\(", src))
    if n == 0:
        errors.append("no assertions: a Witness test must assert the checkpoints")
    if n > 8:
        warnings.append(f"{n} assertions: keep 2–5 checkpoints per flow")
    return {"ok": not errors, "errors": errors, "warnings": warnings}


def secret_scan(spec_file: str | Path, credentials: list[dict], root: str | Path | None = None) -> dict:
    spec = Path(spec_file)
    files = [spec]
    src = spec.read_text(encoding="utf-8")
    bases = [spec.parent] + ([Path(root)] if root else [])
    for m in re.finditer(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))", src, re.M):
        mod = (m.group(1) or m.group(2)).lstrip(".")
        for base in bases:
            p = base / (mod.replace(".", "/") + ".py")
            if p.is_file() and p not in files:
                files.append(p)
    errors = []
    for f in files:
        text = f.read_text(encoding="utf-8")
        for c in credentials:
            if c["value"] in text:
                errors.append(f"{f.name} contains the value of {c['name']}; read it from os.environ instead")
    return {"ok": not errors, "errors": errors, "scanned": [f.name for f in files]}
