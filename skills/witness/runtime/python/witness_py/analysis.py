"""Analysis of raw-replay evidence (mirror of runtime/node/lib/analysis.mjs).

Pure functions over evidence JSON. Both runtimes are checked against the same conformance
vectors (runtime/conformance), so keep this file in step with analysis.mjs.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable
from urllib.parse import urlsplit

from .util import MUTATING, digits_masked, now_iso, query_keys, regex_for, status_class, template_path

CLICKISH = {"click", "dblclick", "tap", "hover"}
# Preference order for locators. A role without an accessible name is weak (e.g. get_by_role("strong")).
CANDIDATE_ORDER = ["role", "label", "placeholder", "testid", "scoped-role", "role-unnamed", "text"]
TIME_RE = re.compile(
    r"\b(\d+\s*(?:second|minute|hour|day|week|month|year)s?|today|tomorrow|yesterday|overdue|ago|due\b|\d{1,2}:\d{2}(?::\d{2})?"
    r"|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{4}-\d{2}-\d{2})",
    re.I,
)
LINE_RE = re.compile(r'^-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*(?::\s*(.*))?$')
NAV = {"goto", "reload", "goBack", "goForward"}


def action_class(method: str) -> str:
    if method in NAV:
        return "nav"
    if method in ("click", "dblclick", "tap"):
        return "click"
    if method in ("fill", "type", "pressSequentially", "clear"):
        return "input"
    if method == "press":
        return "key"
    if method in ("check", "uncheck", "setChecked"):
        return "check"
    if method == "selectOption":
        return "select"
    if method == "setInputFiles":
        return "file"
    if method == "hover":
        return "hover"
    if method == "dragTo":
        return "drag"
    return "other"


def _step_value(step: dict) -> Any:
    a = step.get("args") if isinstance(step.get("args"), list) else []
    if step.get("method") in ("fill", "type", "pressSequentially", "press", "selectOption", "goto"):
        return a[0] if a else None
    return None


def _same_target(a: dict | None, b: dict | None) -> bool:
    if not a or not b:
        return False
    if a.get("selector") and b.get("selector") and a["selector"] == b["selector"]:
        return True
    if a.get("role") and b.get("role") and a.get("name") and b.get("name"):
        return a["role"] == b["role"] and a["name"].lower() == b["name"].lower()
    ta, tb = (a.get("attrs") or {}).get("testId"), (b.get("attrs") or {}).get("testId")
    if ta and tb:
        return ta == tb
    return False


def best_candidate(target: dict | None) -> dict | None:
    lst = (target or {}).get("candidates") or []

    def kind_of(x: dict) -> str:
        return "role-unnamed" if x["kind"] == "role" and not re.search(r"name[:=]", x.get("code") or "") else x["kind"]

    for kind in CANDIDATE_ORDER:
        for x in lst:
            if kind_of(x) == kind and x.get("matchesTarget"):
                return {**x, "kind": kind_of(x)}
    return None


def _requests_of(ev: dict, step_index: int) -> list[dict]:
    return [r for r in ev.get("requests") or [] if r.get("step") == step_index]


def _parse_line(line: str) -> dict:
    m = LINE_RE.match(str(line))
    if not m:
        return {"role": None, "name": None, "text": None}
    return {"role": m.group(1), "name": m.group(2).replace('\\"', '"') if m.group(2) else None, "text": m.group(4)}


def _url_path(u: str) -> str:
    return urlsplit(u).path


def classify_steps(ev: dict) -> list[dict]:
    steps = ev.get("steps") or []
    out = []
    for s in steps:
        reqs = _requests_of(ev, s["index"])
        dialogs = [d for d in ev.get("dialogs") or [] if d.get("step") == s["index"]]
        url_changed = s.get("urlBefore") is not None and s.get("urlAfter") is not None and s["urlBefore"] != s["urlAfter"]
        has_dom = bool(s.get("added")) or bool(s.get("removed"))
        effectful = has_dom or url_changed or bool(reqs) or bool(dialogs)
        cls = action_class(s["method"])
        kind = "action" if (cls == "nav" or s["method"] not in CLICKISH or effectful) else "observation"
        t = s.get("target")
        attrs = (t or {}).get("attrs") or {}
        out.append({
            "index": s["index"], "method": s["method"], "class": cls, "kind": kind, "value": _step_value(s),
            "recordedLocator": (t or {}).get("locator") or ("page" if s.get("on") == "page" else None),
            "target": {
                "role": t.get("role"), "name": t.get("name"), "ariaLine": t.get("ariaLine"),
                "testId": attrs.get("testId"), "label": attrs.get("label"), "containerRole": attrs.get("containerRole"),
                "containerText": attrs.get("containerText"), "tag": attrs.get("tag"), "text": t.get("text"),
            } if t else None,
            "locator": best_candidate(t),
            "candidates": [{"kind": c["kind"], "code": c.get("code"), "count": c.get("count"), "matchesTarget": bool(c.get("matchesTarget"))} for c in (t or {}).get("candidates") or []],
            "effects": {
                "added": len(s.get("added") or []), "removed": len(s.get("removed") or []), "urlChanged": url_changed,
                "urlAfter": s.get("urlAfter"),
                "requests": [f"{r['method']} {template_path(r['path'])} {r.get('status') if r.get('status') is not None else (r.get('failure') or '?')}" for r in reqs],
                "dialogs": [f"{d['type']}: {d['message']}" for d in dialogs],
            },
            "settleMs": s.get("settleMs"),
            "delayedEffect": (s.get("settleMs") or 0) >= 250,
            "error": s.get("error") or None,
            "optional": None,
        })

    for i, s in enumerate(out):
        nxt = out[i + 1] if i + 1 < len(out) else None
        raw, raw_next = steps[i], (steps[i + 1] if i + 1 < len(steps) else None)
        if (s["class"] == "click" and nxt and nxt["class"] in ("input", "key") and _same_target(raw.get("target"), (raw_next or {}).get("target"))
                and not _requests_of(ev, s["index"]) and not s["effects"]["urlChanged"]):
            s["optional"] = "focus-before-input"
            continue
        if s["kind"] == "observation":
            s["optional"] = "observation"
            continue
        if s["class"] == "input" and nxt and nxt["class"] == "input" and _same_target(raw.get("target"), (raw_next or {}).get("target")):
            s["optional"] = "superseded-input"
            continue
        removed_dialog = any(re.match(r"^-\s+dialog\b", l["line"]) for l in raw.get("removed") or [])
        if (s["class"] == "click" and (s["target"] or {}).get("containerRole") == "dialog" and removed_dialog
                and not any(r.get("resourceType") != "document" for r in _requests_of(ev, s["index"]))):
            s["optional"] = "overlay-dismiss"
    return out


def _locator_arg(s: str | None) -> str | None:
    """The text argument of a recorded get_by_text(...) locator, e.g. get_by_text("Coupon applied") → Coupon applied."""
    m = re.search(r"get_?[bB]y_?[tT]ext\((['\"])(.+?)\1", str(s or ""))
    return m.group(2) if m else None


def checkpoint_candidates(ev: dict, classified: list[dict]) -> list[dict]:
    steps = ev.get("steps") or []
    final_snap = ((ev.get("final") or {}).get("snapshot")) or (steps[-1].get("snapshotAfter") if steps else "") or ""
    final_lines = {l.strip() for l in final_snap.split("\n") if l.strip()}
    observed = [
        {"index": s["index"], "ariaLine": (s["target"] or {}).get("ariaLine"), "name": (s["target"] or {}).get("name"),
         "text": (s["target"] or {}).get("text"), "arg": _locator_arg(s.get("recordedLocator"))}
        for s in classified if s["optional"] == "observation"
    ]

    # Exact matches only: looking at "Borrowed The Left Hand…" must not mark every "Borrow" button as attended.
    def is_attended(step_index: int, line: str, text: str) -> bool:
        return any(o["index"] > step_index and (
            (o["ariaLine"] and o["ariaLine"] == line) or (text and (text == o["name"] or text == o["text"]))
            or (o["arg"] and len(o["arg"]) >= 3 and text and o["arg"] in text)) for o in observed)

    out: list[dict] = []
    for s in steps:
        c = classified[s["index"]] if s["index"] < len(classified) else None
        if not c or c["kind"] != "action" or c["optional"]:
            continue
        own = (s.get("target") or {}).get("ariaLine")
        for a in s.get("added") or []:
            if c["class"] == "input" and own and a["line"].startswith(own.split(":")[0]):
                continue
            if re.match(r"^-\s+(img|separator|generic)\b", a["line"]):
                continue
            p = _parse_line(a["line"])
            if not p["role"]:
                continue
            text = p["name"] or p["text"] or ""
            if not text and p["role"] not in ("dialog", "row", "listitem"):
                continue
            attended = bool(is_attended(s["index"], a["line"], text))
            out.append({
                "step": s["index"], "type": "appeared", "line": a["line"], "path": a.get("path"), "role": p["role"], "name": p["name"], "text": p["text"],
                "onLoad": c["class"] == "nav", "inFinal": a["line"] in final_lines, "attended": attended,
                "settleMs": s.get("settleMs"), "timeLike": bool(TIME_RE.search(a["line"])),
            })
        for r in s.get("removed") or []:
            p = _parse_line(r["line"])
            if not p["role"] or p["role"] in ("img", "separator", "generic"):
                continue
            if c["class"] == "input" and own and r["line"].startswith(own.split(":")[0]):
                continue
            if p["role"] not in ("row", "listitem", "dialog", "alert", "status", "heading", "button", "link", "cell") and not (p["name"] or p["text"]):
                continue
            out.append({"step": s["index"], "type": "disappeared", "line": r["line"], "path": r.get("path"), "role": p["role"], "name": p["name"], "text": p["text"],
                        "inFinal": False, "attended": False, "settleMs": s.get("settleMs"), "timeLike": bool(TIME_RE.search(r["line"]))})
        if c["class"] != "nav" and s.get("urlAfter") and s.get("urlBefore") != s.get("urlAfter"):
            out.append({"step": s["index"], "type": "url", "line": template_path(_url_path(s["urlAfter"])), "urlAfter": s["urlAfter"],
                        "inFinal": s["urlAfter"] == (ev.get("final") or {}).get("url"), "attended": False, "settleMs": s.get("settleMs"), "timeLike": False})
        for r in _requests_of(ev, s["index"]):
            if r["method"] not in MUTATING or not r.get("sameOrigin"):
                continue
            st = r.get("status") if r.get("status") is not None else r.get("failure")
            out.append({"step": s["index"], "type": "request", "line": f"{r['method']} {template_path(r['path'])} → {st}", "method": r["method"],
                        "template": template_path(r["path"]), "status": r.get("status"), "inFinal": False, "attended": False, "settleMs": None, "timeLike": False})
    return [{"id": f"c{i + 1}", **c} for i, c in enumerate(out)]


def mark_stability(candidates: list[dict], other_runs: list[dict]) -> list[dict]:
    if not other_runs:
        return [{**c, "stability": "unknown"} for c in candidates]
    res = []
    for c in candidates:
        stable, dynamic = True, False
        for ev in other_runs:
            steps = ev.get("steps") or []
            s = steps[c["step"]] if c["step"] < len(steps) else None
            if not s:
                stable = False
                continue
            if c["type"] in ("appeared", "disappeared"):
                pool = (s.get("added") if c["type"] == "appeared" else s.get("removed")) or []
                if any(x["line"] == c["line"] for x in pool):
                    continue
                if any(digits_masked(x["line"]) == digits_masked(c["line"]) for x in pool):
                    dynamic = True
                    continue
                stable = False
            elif c["type"] == "url":
                if not s.get("urlAfter") or template_path(_url_path(s["urlAfter"])) != c["line"]:
                    stable = False
                elif s["urlAfter"] != c.get("urlAfter"):
                    dynamic = True
            elif c["type"] == "request":
                ok = any(r.get("step") == c["step"] and r["method"] == c["method"] and template_path(r["path"]) == c["template"]
                         and status_class(r.get("status")) == status_class(c.get("status")) for r in ev.get("requests") or [])
                if not ok:
                    stable = False
        o = {**c, "stability": "unstable" if not stable else ("dynamic" if dynamic else "stable")}
        if dynamic and c["type"] in ("appeared", "disappeared"):
            o["suggestedRegex"] = regex_for(c.get("name") or c.get("text") or c["line"])
        res.append(o)
    return res


def score_candidate(c: dict) -> int:
    s = 0
    if c.get("onLoad") and not c.get("attended"):
        s -= 2
    if c.get("attended"):
        s += 3
    if c.get("role") in ("status", "alert"):
        s += 2
    if c["type"] == "url":
        s += 2
    if c.get("role") == "heading":
        s += 1
    if c.get("inFinal"):
        s += 1
    if c["type"] == "request" and status_class(c.get("status")) == "2xx":
        s += 1
    if c["type"] == "request":
        s -= 1
    if c.get("stability") == "dynamic":
        s -= 1
    if c.get("stability") == "unstable":
        s -= 5
    if c.get("timeLike"):
        s -= 1
    return s


def lcs(a: list, b: list, eq: Callable[[Any, Any], bool], weight: Callable[[Any], int] = lambda _x: 1) -> dict:
    """Weighted LCS alignment; weight lets required items win over optional ones."""
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            skip = max(dp[i + 1][j], dp[i][j + 1])
            dp[i][j] = max(skip, dp[i + 1][j + 1] + weight(a[i])) if eq(a[i], b[j]) else skip
    pairs, only_a, only_b = [], [], []
    i = j = 0
    while i < n and j < m:
        if eq(a[i], b[j]) and dp[i][j] == dp[i + 1][j + 1] + weight(a[i]):
            pairs.append((a[i], b[j]))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            only_a.append(a[i])
            i += 1
        else:
            only_b.append(b[j])
            j += 1
    only_a.extend(a[i:])
    only_b.extend(b[j:])
    return {"pairs": pairs, "onlyA": only_a, "onlyB": only_b}


def mutations_of(ev: dict) -> list[dict]:
    return [{"method": r["method"], "template": template_path(r["path"]), "status": r.get("status"), "step": r.get("step"), "message": r.get("responseExcerpt") or None}
            for r in ev.get("requests") or [] if r.get("sameOrigin") and r["method"] in MUTATING]


def divergences(har_calls: list[dict] | None, runs: list[dict], origin: str | None) -> list[dict]:
    out: list[dict] = []
    same = lambda x, y: x["method"] == y["method"] and x["template"] == y["template"]  # noqa: E731
    if har_calls is not None and runs:
        recorded = [{"method": c["method"], "template": c["template"], "status": c.get("status"), "message": c.get("responseExcerpt")}
                    for c in har_calls if (not origin or c.get("origin") == origin) and c["method"] in MUTATING]
        replay = mutations_of(runs[0])
        r = lcs(recorded, replay, same)
        for rec, p in r["pairs"]:
            if status_class(rec["status"]) == "2xx" and status_class(p["status"]) != "2xx":
                out.append({"kind": "state_dependent", "against": "recording", "method": p["method"], "template": p["template"], "recordedStatus": rec["status"], "replayStatus": p["status"], "step": p["step"], "message": p["message"]})
            elif status_class(rec["status"]) != status_class(p["status"]):
                out.append({"kind": "status_changed", "against": "recording", "method": p["method"], "template": p["template"], "recordedStatus": rec["status"], "replayStatus": p["status"], "step": p["step"], "message": p["message"]})
        for rec in r["onlyA"]:
            out.append({"kind": "missing_request", "against": "recording", "method": rec["method"], "template": rec["template"], "recordedStatus": rec["status"]})
        for p in r["onlyB"]:
            out.append({"kind": "extra_request", "against": "recording", "method": p["method"], "template": p["template"], "replayStatus": p["status"], "step": p["step"]})
        recorded_reads: list[str] = []
        for c in har_calls:
            if (not origin or c.get("origin") == origin) and c["method"] == "GET" and c.get("resourceType") in ("xhr", "fetch"):
                k = f"{c['template']}?{c['queryKeys']}"
                if k not in recorded_reads:
                    recorded_reads.append(k)
        replay_reads = {f"{template_path(r2['path'])}?{query_keys(r2['path'])}" for r2 in runs[0].get("requests") or []
                        if r2.get("sameOrigin") and r2["method"] == "GET" and r2.get("resourceType") in ("xhr", "fetch")}
        for k in recorded_reads:
            if k not in replay_reads:
                out.append({"kind": "missing_read", "against": "recording", "method": "GET", "template": re.sub(r"\?$", "", k)})
    for i in range(1, len(runs)):
        r = lcs(mutations_of(runs[i - 1]), mutations_of(runs[i]), same)
        for a, b in r["pairs"]:
            if status_class(a["status"]) == "2xx" and status_class(b["status"]) != "2xx":
                out.append({"kind": "state_dependent", "against": f"replay {i}", "method": b["method"], "template": b["template"], "recordedStatus": a["status"], "replayStatus": b["status"], "step": b["step"], "message": b["message"]})
    return out


def overlays(ev: dict, classified: list[dict]) -> list[dict]:
    out = []
    for s in ev.get("steps") or []:
        c = classified[s["index"]] if s["index"] < len(classified) else None
        if c and c["optional"] == "overlay-dismiss":
            d = next((l for l in s.get("removed") or [] if re.match(r"^-\s+dialog\b", l["line"])), None)
            out.append({"dialog": d["line"] if d else None, "dismissedAt": s["index"], "using": (c["locator"] or {}).get("code") or c["recordedLocator"]})
    return out


def api_hints(ev: dict) -> list[dict]:
    return [{"step": r.get("step"), "method": r["method"], "path": r["path"], "template": template_path(r["path"]), "status": r.get("status"),
             "requestBody": r.get("postData") or None, "responseExcerpt": r.get("responseExcerpt") or None}
            for r in ev.get("requests") or [] if r.get("sameOrigin") and r["method"] in MUTATING]


def _dedupe(lst: list) -> list:
    return [x for i, x in enumerate(lst) if i == 0 or x != lst[i - 1]]


def build_analysis(flow: str, runs: list[dict], har_calls: list[dict] | None, origin: str | None) -> dict:
    statuses = []
    for i, ev in enumerate(runs):
        failed = next((s for s in ev.get("steps") or [] if s.get("error")), None)
        statuses.append({"run": i + 1, "status": ev.get("status"), "error": ev.get("error") or None, "failedStep": failed["index"] if failed else None})
    passing = [ev for ev in runs if ev.get("status") == "passed"]
    baseline = passing[-1] if passing else runs[0]
    classified = classify_steps(baseline)
    cands = checkpoint_candidates(baseline, classified)
    cands = mark_stability(cands, [r for r in passing if r is not baseline])
    cands = [{**c, "score": score_candidate(c)} for c in cands]
    cands.sort(key=lambda c: (-c["score"], c["step"]))
    div = divergences(har_calls, runs, origin)
    nav = [template_path(r["path"]) for r in baseline.get("requests") or [] if r.get("sameOrigin") and r.get("resourceType") == "document"]

    def nav_of(s: dict) -> str | None:
        if s["class"] != "nav":
            return None
        return template_path(re.sub(r"^https?://[^/]+", "", str(s.get("value") or "")))

    return {
        "version": 1,
        "flow": flow,
        "analyzedAt": now_iso(),
        "runs": statuses,
        "repeatable": len(runs) > 1 and all(r.get("status") == "passed" for r in runs) and not any(d["kind"] == "state_dependent" for d in div),
        "steps": classified,
        "checkpointCandidates": cands,
        "divergences": div,
        "dialogs": [dict(d) for d in baseline.get("dialogs") or []],
        "overlays": overlays(baseline, classified),
        "timeDependent": [c["id"] for c in cands if c.get("timeLike")],
        "api": api_hints(baseline),
        "baseline": {
            "actions": [{"index": s["index"], "class": s["class"], "role": (s["target"] or {}).get("role"), "name": (s["target"] or {}).get("name"),
                         "testId": (s["target"] or {}).get("testId"), "label": (s["target"] or {}).get("label"), "value": s["value"],
                         "optional": s["optional"], "nav": nav_of(s)} for s in classified if s["kind"] == "action"],
            "navigation": _dedupe(nav),
            "mutations": [{"method": m["method"], "template": m["template"], "statusClass": status_class(m["status"])} for m in mutations_of(baseline)],
        },
    }


def next_steps(a: dict, lang: str = "python") -> list[str]:
    out = []
    kinds = {d["kind"] for d in a["divergences"]}
    failed = any(r["status"] != "passed" for r in a["runs"])
    prepared = "prepared_test.py" if lang == "python" else "prepared.spec.ts"
    raw = "raw_test.py" if lang == "python" else "raw.spec.ts"
    cli = "python -m witness_py" if lang == "python" else "witness"
    if "state_dependent" in kinds:
        out.append(f"The recording consumed or created data, so replays now take a different path. Write {prepared} next to {raw}: the same steps, with only data made fresh per run (unique values, or setup through the app API listed above). Then run `{cli} analyze {a['flow']} --spec .witness/recordings/{a['flow']}/{prepared}`.")
    if "missing_read" in kinds:
        out.append(f"A read request from the recording never happened in the replay: the UI probably reacts to key events, not to fill(). Use press_sequentially() for that input in {prepared}.")
    if "missing_request" in kinds and a["dialogs"]:
        out.append(f"A call from the recording is missing and a native dialog was involved: codegen records dialog.dismiss(), but the user accepted it. Accept the dialog in {prepared}.")
    elif "missing_request" in kinds:
        out.append("A call from the recording never happened in the replay; check the failing step and any dialogs.")
    if a["overlays"]:
        out.append("Dismiss overlays with page.add_locator_handler() instead of a recorded click (they may not appear every time).")
    if a["timeDependent"]:
        out.append("Some candidate text depends on the current date or time; control the clock (page.clock) or assert with a regex.")
    if failed and "state_dependent" not in kinds and "missing_read" not in kinds:
        out.append("A replay failed without a data divergence; look at the failing step error before generating anything.")
    if not failed and "state_dependent" not in kinds:
        out.append(f"The flow replays cleanly. Generate the test from the steps and candidates above, then run `{cli} verify {a['flow']} --spec <test file>`.")
    return out


def analysis_summary(a: dict, lang: str = "python") -> str:
    L = [f"# Witness analysis: {a['flow']}", ""]
    runs = ", ".join(f"#{r['run']} {r['status']}" + (f" (failed at step {r['failedStep']})" if r["failedStep"] is not None else "") for r in a["runs"])
    L.append(f"Runs: {runs}. Repeatable{'' if a.get('kind') == 'prepared' else ' as recorded'}: {'yes' if a['repeatable'] else 'no'}.")
    for r in a["runs"]:
        if r["error"]:
            L.append(f"- run {r['run']} error: {str(r['error']).splitlines()[0] if r['error'] else ''}")
    if a["divergences"]:
        L += ["", "## Divergences"]
        for d in a["divergences"]:
            if d["kind"] == "state_dependent":
                msg = f" — {d['message'][:120]}" if d.get("message") else ""
                L.append(f"- STATE-DEPENDENT (vs {d['against']}): {d['method']} {d['template']} was {d['recordedStatus']}, now {d['replayStatus']}{msg} (step {d['step']})")
            elif d["kind"] == "missing_request":
                L.append(f"- MISSING (vs {d['against']}): {d['method']} {d['template']} (recorded {d['recordedStatus']}) never happened in the replay")
            elif d["kind"] == "extra_request":
                L.append(f"- EXTRA (vs {d['against']}): {d['method']} {d['template']} → {d['replayStatus']} (step {d['step']})")
            elif d["kind"] == "missing_read":
                L.append(f"- MISSING READ: GET {d['template']} happened while recording but not in the replay (event-driven UI? try press_sequentially)")
            else:
                L.append(f"- {d['kind']}: {d['method']} {d['template']} {d.get('recordedStatus')} → {d.get('replayStatus')}")
    L += ["", "## Steps"]
    for s in a["steps"]:
        t = s["target"]
        tgt = (f"{(t.get('role') or t.get('tag') or '')}" + (f' "{t["name"]}"' if t.get("name") else "")) if t else ""
        loc = (s["locator"] or {}).get("code") or s.get("recordedLocator") or ""
        e = s["effects"]
        eff = ", ".join(x for x in [f"+{e['added']}" if e["added"] else "", f"-{e['removed']}" if e["removed"] else "", "url" if e["urlChanged"] else "", *e["requests"], *e["dialogs"]] if x)
        line = f"{s['index']}. {s['method']}" + (f" {json.dumps(s['value'])}" if s["value"] is not None else "") + f" {tgt} — {s['kind']}"
        line += f" (optional: {s['optional']})" if s["optional"] else ""
        line += f" — effects: {eff}" if eff else ""
        line += f" — settled after {s['settleMs']}ms" if s["delayedEffect"] else ""
        if loc and s["class"] != "nav":
            line += f"\n   locator: {loc}" + ("" if s["locator"] else " (no verified unique candidate)")
        if s["error"]:
            line += f"\n   ERROR: {s['error']}"
        L.append(line)
    L += ["", "## Checkpoint candidates (best first)"]
    for c in a["checkpointCandidates"][:12]:
        flags = ", ".join(x for x in [c.get("stability"), "attended" if c.get("attended") else "", "final" if c.get("inFinal") else "",
                                       "time-like" if c.get("timeLike") else "", f"regex /{c['suggestedRegex']}/" if c.get("suggestedRegex") else ""] if x)
        where = f"  (in: {' > '.join(c['path'][-2:])})" if c.get("path") else ""
        L.append(f"- {c['id']} [score {c['score']}] step {c['step']} {c['type']}: {c['line']}{where} — {flags}")
    if len(a["checkpointCandidates"]) > 12:
        L.append(f"- …{len(a['checkpointCandidates']) - 12} more in analysis.json")
    if a["overlays"]:
        L += ["", "## Overlays"] + [f"- {o['dialog']} dismissed at step {o['dismissedAt']} → use page.add_locator_handler" for o in a["overlays"]]
    if a["dialogs"]:
        L += ["", "## Native dialogs"] + [f"- step {d['step']}: {d['type']} \"{d['message']}\" (check the recording's handler: codegen dismisses by default)" for d in a["dialogs"]]
    if a["api"]:
        L += ["", "## App API calls observed (for test data provisioning)"]
        for x in a["api"][:8]:
            body = f" body {x['requestBody'][:120]}" if x.get("requestBody") else ""
            L.append(f"- {x['method']} {x['template']} → {x['status']}{body}")
    nxt = next_steps(a, lang)
    if nxt:
        L += ["", "## Next"] + [f"{i + 1}. {n}" for i, n in enumerate(nxt)]
    return "\n".join(L) + "\n"
