"""Reads the HAR saved by `playwright codegen --save-har` (mirror of runtime/node/lib/har.mjs)."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit

from .util import MUTATING, query_keys, read_json, template_path


def read_har(file: str | Path | None, origin: str | None = None) -> list[dict] | None:
    if not file or not Path(file).exists():
        return None
    har = read_json(file)
    out = []
    for e in (har.get("log") or {}).get("entries") or []:
        try:
            u = urlsplit(e["request"]["url"])
        except Exception:  # noqa: BLE001
            continue
        if not u.scheme or not u.netloc:
            continue
        resp = e.get("response") or {}
        mime = (resp.get("content") or {}).get("mimeType") or ""
        rtype = e.get("_resourceType") or ("fetch" if "json" in mime else "other")
        method = e["request"]["method"]
        if rtype not in ("document", "xhr", "fetch") and method not in MUTATING:
            continue
        path = u.path + (("?" + u.query) if u.query else "")
        o = f"{u.scheme}://{u.netloc}"
        out.append({
            "method": method,
            "path": path,
            "template": template_path(u.path),
            "queryKeys": query_keys(path),
            "status": resp.get("status"),
            "resourceType": rtype,
            "sameOrigin": not origin or o == origin,
            "origin": o,
            "startedDateTime": e.get("startedDateTime"),
            "responseExcerpt": ((resp.get("content") or {}).get("text") or "")[:300],
        })
    out.sort(key=lambda c: str(c.get("startedDateTime")))
    return out
