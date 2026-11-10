"""Witness instrumentation for pytest-playwright (sync API).

Loaded by the Witness runner with ``-p witness_py.pytest_plugin``; user files are never modified.
Writes the same evidence JSON as the Node shim (runtime/node/shim/witness-shim.ts), with method and
matcher names normalized to their camelCase equivalents so the analysis is shared.

Modes (env WITNESS_MODE): observe | vacuity | plain — see the Node shim for details.
Raw replays: WITNESS_CONTEXT_OVERRIDES (JSON) is merged into every browser.new_context() call, which is
how a recording's saved login, locale, timezone and viewport are applied without touching conftest.py.
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Callable

import pytest
from playwright.sync_api import Browser, Locator, Page
from playwright.sync_api import expect as _expect
from playwright.sync_api._generated import LocatorAssertions, PageAssertions

MODE = os.environ.get("WITNESS_MODE", "plain")
OUT_DIR = os.environ.get("WITNESS_EVIDENCE_DIR", "")
SETTLE_MAX = int(os.environ.get("WITNESS_SETTLE_MAX_MS", "5000"))
SETTLE_QUIET = int(os.environ.get("WITNESS_SETTLE_QUIET_MS", "800"))
THROTTLE = float(os.environ.get("WITNESS_CPU_THROTTLE", "0") or 0)
TEST_ID_ATTR = os.environ.get("WITNESS_TEST_ID_ATTRIBUTE", "data-testid")
REPEAT_INDEX = int(os.environ.get("WITNESS_REPEAT_INDEX", "0") or 0)
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _load_plan() -> dict:
    try:
        f = os.environ.get("WITNESS_VACUITY_PLAN")
        if not f:
            return {"assertions": [], "values": []}
        p = json.loads(Path(f).read_text(encoding="utf-8"))
        return {"assertions": p, "values": []} if isinstance(p, list) else {"assertions": p.get("assertions") or [], "values": p.get("values") or []}
    except Exception:  # noqa: BLE001
        return {"assertions": [], "values": []}


VACUITY = _load_plan()

LOCATOR_ACTIONS = ["click", "dblclick", "fill", "press", "press_sequentially", "type", "check", "uncheck", "set_checked",
                   "select_option", "set_input_files", "hover", "tap", "drag_to", "clear", "select_text", "dispatch_event"]
PAGE_ACTIONS = ["goto", "reload", "go_back", "go_forward"]
PRIMARY_KW = {"fill": "value", "type": "text", "press_sequentially": "text", "press": "key", "select_option": "value", "goto": "url"}
NO_EXPECTED = {"to_be_visible", "to_be_hidden", "to_be_enabled", "to_be_disabled", "to_be_checked", "to_be_editable",
               "to_be_empty", "to_be_focused", "to_be_attached", "to_be_in_viewport"}
ACRONYMS = {"Url": "URL", "Css": "CSS", "Js": "JS", "Id": "Id"}


def camel(name: str) -> str:
    parts = name.split("_")
    out = parts[0] + "".join(ACRONYMS.get(p.capitalize(), p.capitalize()) for p in parts[1:])
    return out


# ------------------------------------------------------------------ serialization

def ser(v: Any, depth: int = 0) -> Any:
    if isinstance(v, re.Pattern):
        flags = "".join(f for f, bit in (("i", re.I), ("m", re.M), ("s", re.S)) if v.flags & bit)
        return {"$regex": v.pattern, "flags": flags}
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, (list, tuple)):
        return "[array]" if depth > 3 else [ser(x, depth + 1) for x in v]
    if isinstance(v, dict):
        return "[object]" if depth > 3 else {str(k): ser(x, depth + 1) for k, x in v.items() if not callable(x)}
    if isinstance(v, Locator):
        return {"$locator": locator_code(v)}
    return str(v)


def deser(v: Any) -> Any:
    if isinstance(v, dict):
        if "$regex" in v:
            flags = 0
            for f, bit in (("i", re.I), ("m", re.M), ("s", re.S)):
                if f in (v.get("flags") or ""):
                    flags |= bit
            return re.compile(v["$regex"], flags)
        return {k: deser(x) for k, x in v.items()}
    if isinstance(v, list):
        return [deser(x) for x in v]
    return v


# ------------------------------------------------------------------ locator descriptions

def selector_of(loc: Any) -> str | None:
    impl = getattr(loc, "_impl_obj", loc)
    return getattr(impl, "_selector", None)


_ATTR = re.compile(r'^\[([\w-]+)="((?:[^"\\]|\\.)*)"([is]?)\]$')


def _q(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def selector_to_python(sel: str | None) -> str:
    """Readable Python for Playwright's internal selector syntax (best effort, display only)."""
    if not sel:
        return "page"
    out = "page"
    for part in sel.split(" >> "):
        m = re.match(r'^internal:role=(\w+)((?:\[[^\]]*\])*)$', part)
        if m:
            role, props = m.group(1), m.group(2)
            args = [_q(role)]
            for pm in re.finditer(r'\[(\w+)=("(?:[^"\\]|\\.)*")([is]?)\]|\[(\w+)\]', props):
                if pm.group(1) == "name":
                    args.append(f"name={pm.group(2)}")
                    if pm.group(3) == "s":
                        args.append("exact=True")
                elif pm.group(1):
                    args.append(f"{pm.group(1)}={pm.group(2)}")
            out += f".get_by_role({', '.join(args)})"
            continue
        m = re.match(r'^internal:(label|text|has-text|has-not-text)=("(?:[^"\\]|\\.)*")([is]?)$', part)
        if m:
            kind, val, flag = m.groups()
            if kind == "label":
                out += f".get_by_label({val}{', exact=True' if flag == 's' else ''})"
            elif kind == "text":
                out += f".get_by_text({val}{', exact=True' if flag == 's' else ''})"
            elif kind == "has-text":
                out += f".filter(has_text={val})"
            else:
                out += f".filter(has_not_text={val})"
            continue
        m = re.match(r'^internal:testid=\[[\w-]+="((?:[^"\\]|\\.)*)"[is]?\]$', part)
        if m:
            out += f".get_by_test_id({_q(m.group(1))})"
            continue
        m = re.match(r'^internal:attr=\[(placeholder|alt|title)="((?:[^"\\]|\\.)*)"([is]?)\]$', part)
        if m:
            fn = {"placeholder": "get_by_placeholder", "alt": "get_by_alt_text", "title": "get_by_title"}[m.group(1)]
            out += f".{fn}({_q(m.group(2))}{', exact=True' if m.group(3) == 's' else ''})"
            continue
        m = re.match(r"^nth=(-?\d+)$", part)
        if m:
            n = int(m.group(1))
            out += ".first" if n == 0 else ".last" if n == -1 else f".nth({n})"
            continue
        out += f".locator({_q(part)})"
    return out


def locator_code(loc: Any) -> str:
    return selector_to_python(selector_of(loc))


def _role_code(role: str, name: str | None) -> str:
    return f"get_by_role({_q(role)}, name={_q(name)}, exact=True)" if name else f"get_by_role({_q(role)})"


ARIA_LINE = re.compile(r'^-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*(?::\s*(.*))?$')


def parse_aria_line(snapshot: str) -> dict:
    first = next((l for l in (snapshot or "").split("\n") if l.strip()), "").strip()
    m = ARIA_LINE.match(first)
    if not m:
        return {"ariaLine": first, "role": None, "name": None, "text": None}
    return {"ariaLine": first, "role": m.group(1), "name": m.group(2).replace('\\"', '"') if m.group(2) else None, "text": m.group(4)}


def lines_with_path(snapshot: str) -> list[dict]:
    out, stack = [], []
    for raw in (snapshot or "").split("\n"):
        if not raw.strip():
            continue
        indent = len(raw) - len(raw.lstrip())
        line = raw.strip()
        while stack and stack[-1][0] >= indent:
            stack.pop()
        out.append({"line": line, "path": [re.sub(r":$", "", s[1]) for s in stack]})
        stack.append((indent, line))
    return out


def diff_snapshots(before: str, after: str) -> dict:
    b, a = lines_with_path(before), lines_with_path(after)
    key = lambda x: " > ".join(x["path"]) + " >> " + x["line"]  # noqa: E731
    count: dict[str, int] = {}
    for x in b:
        count[key(x)] = count.get(key(x), 0) + 1
    added = []
    for x in a:
        k = key(x)
        if count.get(k, 0) > 0:
            count[k] -= 1
        else:
            added.append(x)
    count_a: dict[str, int] = {}
    for x in a:
        count_a[key(x)] = count_a.get(key(x), 0) + 1
    removed = []
    for x in b:
        k = key(x)
        if count_a.get(k, 0) > 0:
            count_a[k] -= 1
        else:
            removed.append(x)
    return {"added": added, "removed": removed}


def redact(s: str) -> str:
    out = s
    for k, v in os.environ.items():
        if v and len(v) >= 4 and re.search(r"(PASS|SECRET|TOKEN|KEY|PWD)", k, re.I):
            out = out.replace(v, f"«redacted:{k}»")
    return re.sub(r'("(?:password|pass|secret|token|apiKey|api_key)"\s*:\s*")[^"]*"', r'\1«redacted»"', out, flags=re.I)


ATTRS_JS = """(el, testIdAttr) => {
  const label = el.labels && el.labels[0] ? el.labels[0].innerText.trim() : null;
  const container = el.closest('tr,li,[role=row],[role=listitem],article,[role=dialog],dialog,form,section');
  let containerRole = null, containerText = null;
  if (container) {
    const tag = container.tagName.toLowerCase();
    containerRole = container.getAttribute('role') || ({ tr: 'row', li: 'listitem', article: 'article', dialog: 'dialog', form: 'form', section: 'region' })[tag] || null;
    const key = container.querySelector('strong,h1,h2,h3,h4,td,th,legend');
    containerText = key ? key.innerText.trim().slice(0, 60) : null;
  }
  return {
    tag: el.tagName.toLowerCase(), id: el.id || null, testId: el.getAttribute(testIdAttr), nameAttr: el.getAttribute('name'),
    type: el.getAttribute('type'), placeholder: el.getAttribute('placeholder'), ariaLabel: el.getAttribute('aria-label'),
    title: el.getAttribute('title'), label, text: (el.innerText || '').trim().slice(0, 80) || null, containerRole, containerText,
  };
}"""


# ------------------------------------------------------------------ recorder

class Recorder:
    def __init__(self, page: Page, item: pytest.Item):
        self.page, self.item = page, item
        self.steps: list[dict] = []
        self.assertions: list[dict] = []
        self.requests: list[dict] = []
        self.dialogs: list[dict] = []
        self.vacuity: list[dict] = []
        self.busy = False
        self.current_step: int | None = None
        self.inflight = 0
        self.origin = ""
        self.initial: dict | None = None
        self.last_snapshot = ""
        self.typed: dict[int, str] = {}
        self._reqs: dict[int, dict] = {}
        self._seq = 0

    # -- events (no blocking calls except in observe mode, wrapped in try)
    def attach(self) -> None:
        ctx = self.page.context
        ctx.on("request", self._on_request)
        ctx.on("response", self._on_response)
        ctx.on("requestfinished", self._on_done)
        ctx.on("requestfailed", self._on_failed)
        self.page.on("dialog", self._on_dialog)

    def _on_request(self, r: Any) -> None:
        self.inflight += 1
        from urllib.parse import urlsplit

        u = urlsplit(r.url)
        origin = f"{u.scheme}://{u.netloc}" if u.scheme and u.netloc else None
        if not self.origin and r.resource_type == "document" and origin:
            self.origin = origin
        rec = {"id": self._seq + 1, "method": r.method, "url": r.url, "path": (u.path + ("?" + u.query if u.query else "")) if origin else r.url,
               "resourceType": r.resource_type, "sameOrigin": bool(origin) and (not self.origin or origin == self.origin),
               "step": self.current_step, "t": int(time.time() * 1000)}
        self._seq += 1
        if MODE == "observe" and r.method != "GET":
            try:
                pd = r.post_data
                if pd:
                    rec["postData"] = redact(pd)[:2000]
            except Exception:  # noqa: BLE001
                pass
        self._reqs[id(r)] = rec
        if rec["resourceType"] in ("document", "xhr", "fetch") or rec["method"] != "GET":
            self.requests.append(rec)

    def _on_response(self, resp: Any) -> None:
        rec = self._reqs.get(id(resp.request))
        if not rec:
            return
        rec["status"] = resp.status
        if MODE == "observe" and rec["resourceType"] in ("xhr", "fetch") and (rec["method"] != "GET" or resp.status >= 400):
            try:
                rec["responseExcerpt"] = redact(resp.text())[:600]
            except Exception:  # noqa: BLE001
                pass

    def _on_done(self, r: Any) -> None:
        self.inflight = max(0, self.inflight - 1)

    def _on_failed(self, r: Any) -> None:
        self.inflight = max(0, self.inflight - 1)
        rec = self._reqs.get(id(r))
        if rec:
            rec["failure"] = r.failure or "failed"

    def _on_dialog(self, d: Any) -> None:
        self.dialogs.append({"step": self.current_step, "type": d.type, "message": d.message})
        try:  # preserve Playwright's default (auto-dismiss) when the test registered no handler of its own
            if len(self.page._impl_obj.listeners("dialog")) <= 1:
                d.dismiss()
        except Exception:  # noqa: BLE001
            pass

    # -- helpers
    def snap(self, page: Page) -> str:
        try:
            return page.locator("body").aria_snapshot(timeout=2000)
        except Exception:  # noqa: BLE001
            return ""

    def settle(self, page: Page, start: str) -> dict:
        t0 = time.time()
        last, last_change = start, 0
        while (time.time() - t0) * 1000 < SETTLE_MAX:
            page.wait_for_timeout(100)  # pumps Playwright events, unlike time.sleep
            s = self.snap(page)
            now = int((time.time() - t0) * 1000)
            if s != last:
                last, last_change = s, now
            if now - last_change >= SETTLE_QUIET and self.inflight == 0 and now >= SETTLE_QUIET:
                break
        return {"snapshot": last, "settleMs": last_change, "timedOut": (time.time() - t0) * 1000 >= SETTLE_MAX}

    def describe_target(self, loc: Locator) -> dict:
        page = loc.page
        target: dict[str, Any] = {"locator": locator_code(loc), "selector": selector_of(loc)}
        try:
            loc.wait_for(state="attached", timeout=5000)
        except Exception:  # noqa: BLE001
            target["unresolved"] = True
            return target
        handle = None
        try:
            handle = loc.element_handle(timeout=2000)
            try:
                aria = loc.aria_snapshot(timeout=2000)
            except Exception:  # noqa: BLE001
                aria = ""
            target.update(parse_aria_line(aria))
            target["inMainFrame"] = handle.owner_frame()._impl_obj is page.main_frame._impl_obj
            target["attrs"] = handle.evaluate(ATTRS_JS, TEST_ID_ATTR)
            if target["inMainFrame"]:
                target["candidates"] = self.candidates(page, target, handle)
        except Exception as e:  # noqa: BLE001
            target["describeError"] = str(e).split("\n")[0]
        finally:
            if handle:
                try:
                    handle.dispose()
                except Exception:  # noqa: BLE001
                    pass
        return target

    def candidates(self, page: Page, t: dict, handle: Any) -> list[dict]:
        a = t.get("attrs") or {}
        role, name = t.get("role"), t.get("name")
        lst: list[tuple[str, Locator, str]] = []
        role_ok = role and role not in ("text", "generic", "paragraph", "none", "presentation")
        if role_ok:
            loc = page.get_by_role(role, name=name, exact=True) if name else page.get_by_role(role)  # type: ignore[arg-type]
            lst.append(("role", loc, _role_code(role, name)))
        if a.get("label"):
            lst.append(("label", page.get_by_label(a["label"], exact=True), f"get_by_label({_q(a['label'])}, exact=True)"))
        if a.get("placeholder"):
            lst.append(("placeholder", page.get_by_placeholder(a["placeholder"], exact=True), f"get_by_placeholder({_q(a['placeholder'])}, exact=True)"))
        if a.get("testId"):
            lst.append(("testid", page.get_by_test_id(a["testId"]), f"get_by_test_id({_q(a['testId'])})"))
        if a.get("text") and len(a["text"]) <= 60 and "\n" not in a["text"]:
            lst.append(("text", page.get_by_text(a["text"], exact=True), f"get_by_text({_q(a['text'])}, exact=True)"))
        if role_ok and a.get("containerRole") and a.get("containerText"):
            scope = page.get_by_role(a["containerRole"]).filter(has_text=a["containerText"])  # type: ignore[arg-type]
            loc = scope.get_by_role(role, name=name, exact=True) if name else scope.get_by_role(role)  # type: ignore[arg-type]
            lst.append(("scoped-role", loc, f"get_by_role({_q(a['containerRole'])}).filter(has_text={_q(a['containerText'])}).{_role_code(role, name)}"))
        out = []
        for kind, loc, code in lst:
            try:
                count = loc.count()
                index = loc.evaluate_all("(els, el) => els.indexOf(el)", handle) if count else -1
                out.append({"kind": kind, "code": code, "count": count, "matchesTarget": count == 1 and index == 0, "index": index})
            except Exception as e:  # noqa: BLE001
                out.append({"kind": kind, "code": code, "error": str(e).split("\n")[0]})
        return out

    def substitute(self, text: str) -> str:
        pairs = sorted(
            [(str(v["value"]), self.typed[v["step"]]) for v in VACUITY["values"]
             if isinstance(self.typed.get(v["step"]), str) and self.typed[v["step"]] != v["value"] and len(str(v["value"])) >= 3],
            key=lambda p: -len(p[0]))
        for a, b in pairs:
            text = text.replace(a, b)
        return text

    def check_vacuity(self, page: Page, action_index: int) -> None:
        for p in [x for x in VACUITY["assertions"] if x.get("afterStep") == action_index]:
            r: dict[str, Any] = {"order": p["order"], "afterStep": p["afterStep"], "matcher": p.get("matcher"), "isNot": p.get("isNot")}
            try:
                if p.get("kind") == "locator" and not p.get("selector"):
                    r.update(checked=False, reason="no selector")
                    self.vacuity.append(r)
                    continue
                sel = self.substitute(p["selector"]) if p.get("selector") else None
                target = page if p.get("kind") == "page" else page.locator(sel)
                args = deser(json.loads(self.substitute(json.dumps(p.get("args") or []))))
                kwargs = deser(json.loads(self.substitute(json.dumps(p.get("kwargs") or {}))))
                kwargs["timeout"] = 300
                name = ("not_" if p.get("isNot") else "") + p["pyMatcher"]
                getattr(_expect(target), name)(*args, **kwargs)
                r.update(checked=True, passedBeforeAction=True)
            except AssertionError:
                r.update(checked=True, passedBeforeAction=False)
            except Exception as e:  # noqa: BLE001
                r.update(checked=True, passedBeforeAction=False, note=str(e).split("\n")[0])
            self.vacuity.append(r)

    def step(self, obj: Any, method: str, on: str, args: tuple, kwargs: dict, run: Callable[[], Any], py_name: str) -> Any:
        page: Page = obj if on == "page" else obj.page
        index = len(self.steps)
        pos = list(args)
        if not pos and PRIMARY_KW.get(py_name) in kwargs:
            pos = [kwargs[PRIMARY_KW[py_name]]]
        step: dict[str, Any] = {"index": index, "method": method, "on": on, "args": ser(pos), "kwargs": ser({k: v for k, v in kwargs.items() if k != PRIMARY_KW.get(py_name)}), "startedAt": int(time.time() * 1000)}
        self.steps.append(step)
        self.busy = True
        try:
            if MODE == "vacuity":
                if pos and isinstance(pos[0], str) and method in ("fill", "type", "pressSequentially", "selectOption"):
                    self.typed[index] = pos[0]
                self.check_vacuity(page, index)
            if MODE == "observe":
                if on == "locator":
                    step["target"] = self.describe_target(obj)
                step["urlBefore"] = page.url
                step["snapshotBefore"] = self.snap(page)
                if self.initial is None:
                    self.initial = {"url": step["urlBefore"], "snapshot": step["snapshotBefore"]}
            elif on == "locator":
                step["target"] = {"locator": locator_code(obj), "selector": selector_of(obj)}
        finally:
            self.busy = False
        self.current_step = index
        try:
            result = run()
        except Exception as e:
            step["error"] = " ".join(ANSI.sub("", str(e)).split("\n")[:3])
            step["durationMs"] = int(time.time() * 1000) - step["startedAt"]
            self.current_step = None
            raise
        self.busy = True
        try:
            if MODE == "observe":
                s = self.settle(page, self.snap(page))
                step.update(snapshotAfter=s["snapshot"], settleMs=s["settleMs"], settleTimedOut=s["timedOut"], urlAfter=page.url)
                d = diff_snapshots(step["snapshotBefore"], step["snapshotAfter"])
                step["added"], step["removed"] = d["added"], d["removed"]
        finally:
            self.busy = False
        self.current_step = None
        step["durationMs"] = int(time.time() * 1000) - step["startedAt"]
        return result

    def write(self, status: str, error: str | None) -> None:
        if not OUT_DIR:
            return
        Path(OUT_DIR).mkdir(parents=True, exist_ok=True)
        slug = lambda s: re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-")[:80]  # noqa: E731
        path = Path(str(self.item.path))
        data = {
            "version": 1, "runtime": "python", "mode": MODE, "file": str(path.resolve()), "title": self.item.name,
            "titlePath": self.item.nodeid.split("::"), "project": "", "repeat": REPEAT_INDEX, "status": status, "error": error,
            "origin": self.origin, "initial": self.initial,
            "final": {"url": None if self.page.is_closed() else self.page.url, "snapshot": self.last_snapshot} if MODE == "observe" else None,
            "steps": self.steps, "assertions": self.assertions, "requests": self.requests, "dialogs": self.dialogs, "vacuity": self.vacuity,
        }
        f = Path(OUT_DIR) / f"{slug(path.name)}__{slug(self.item.name)}__r{REPEAT_INDEX}.json"
        f.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")


CURRENT: Recorder | None = None


# ------------------------------------------------------------------ patching (at plugin import)

def _wrap_action(cls: type, name: str, on: str) -> None:
    orig = getattr(cls, name, None)
    if orig is None or getattr(orig, "__witness__", False):
        return
    method = camel(name)

    def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        rec = CURRENT
        if rec is None or rec.busy:
            return orig(self, *args, **kwargs)
        return rec.step(self, method, on, args, kwargs, lambda: orig(self, *args, **kwargs), name)

    wrapper.__witness__ = True  # type: ignore[attr-defined]
    wrapper.__name__, wrapper.__doc__ = orig.__name__, orig.__doc__
    setattr(cls, name, wrapper)


def _wrap_assertion(cls: type, name: str, kind: str) -> None:
    orig = getattr(cls, name, None)
    if orig is None or getattr(orig, "__witness__", False) or not callable(orig):
        return
    is_not = name.startswith("not_")
    py_matcher = name[4:] if is_not else name

    def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        rec = CURRENT
        if rec is None or rec.busy:
            return orig(self, *args, **kwargs)
        impl = self._impl_obj
        actual = getattr(impl, "_actual_locator", None) if kind == "locator" else getattr(impl, "_actual_page", None)
        sel = getattr(actual, "_selector", None) if kind == "locator" else None
        entry = {
            "order": len(rec.assertions), "afterStep": len(rec.steps) - 1, "matcher": camel(py_matcher), "pyMatcher": py_matcher,
            "isNot": is_not, "kind": kind, "args": ser(list(args)), "kwargs": ser({k: v for k, v in kwargs.items() if k != "timeout"}),
            "locator": selector_to_python(sel) if kind == "locator" else "page", "selector": sel,
        }
        rec.assertions.append(entry)
        try:
            out = orig(self, *args, **kwargs)
            entry["passed"] = True
            return out
        except Exception as e:
            entry["passed"] = False
            entry["error"] = str(e).split("\n")[0]
            raise

    wrapper.__witness__ = True  # type: ignore[attr-defined]
    wrapper.__name__, wrapper.__doc__ = orig.__name__, orig.__doc__
    setattr(cls, name, wrapper)


for _n in LOCATOR_ACTIONS:
    _wrap_action(Locator, _n, "locator")
for _n in PAGE_ACTIONS:
    _wrap_action(Page, _n, "page")
for _cls, _kind in ((LocatorAssertions, "locator"), (PageAssertions, "page")):
    for _n in dir(_cls):
        if _n.startswith(("to_", "not_to_")):
            _wrap_assertion(_cls, _n, _kind)

_OVERRIDES = json.loads(os.environ.get("WITNESS_CONTEXT_OVERRIDES") or "{}")
if _OVERRIDES:
    _orig_new_context = Browser.new_context

    def _new_context(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        merged = {**kwargs, **{k: v for k, v in _OVERRIDES.items() if v is not None}}
        return _orig_new_context(self, *args, **merged)

    Browser.new_context = _new_context  # type: ignore[method-assign]


# ------------------------------------------------------------------ pytest hooks / fixture

@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):  # type: ignore[no-untyped-def]
    outcome = yield
    rep = outcome.get_result()
    setattr(item, f"_witness_rep_{rep.when}", rep)


@pytest.fixture(autouse=True)
def _witness(request):  # type: ignore[no-untyped-def]
    global CURRENT
    if "page" not in request.fixturenames:
        yield
        return
    page = request.getfixturevalue("page")
    if os.environ.get("WITNESS_ACTION_TIMEOUT_MS"):  # raw replays: fail fast on a step that cannot happen
        page.set_default_timeout(int(os.environ["WITNESS_ACTION_TIMEOUT_MS"]))
    if THROTTLE > 1:
        try:
            page.context.new_cdp_session(page).send("Emulation.setCPUThrottlingRate", {"rate": THROTTLE})
        except Exception:  # noqa: BLE001
            pass
    rec = Recorder(page, request.node)
    rec.attach()
    CURRENT = rec
    try:
        yield
    finally:
        if MODE == "observe" and not page.is_closed():
            rec.busy = True
            rec.last_snapshot = rec.snap(page)
            rec.busy = False
        CURRENT = None
        rep = getattr(request.node, "_witness_rep_call", None) or getattr(request.node, "_witness_rep_setup", None)
        status = "passed" if rep is not None and rep.passed and rep.when == "call" else ("skipped" if rep is not None and rep.skipped else "failed")
        error = None
        if rep is not None and rep.failed:
            error = "\n".join(ANSI.sub("", rep.longreprtext).strip().split("\n")[-6:])
        rec.write(status, error)
