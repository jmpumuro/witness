"""Test data helpers for the library app, shared by all library tests ("reuse before creating")."""
from __future__ import annotations

from datetime import datetime, timezone

from playwright.sync_api import APIRequestContext

# The fixed "now" used by tests that check due dates: 9 days after Dune's due date in the seed data.
LIBRARY_NOW = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)


def return_loans_of(api: APIRequestContext, title: str) -> None:
    """Returns any active loan of the given title for the signed-in member (pass page.request)."""
    res = api.get("/api/loans")
    if not res.ok:
        raise RuntimeError(f"could not list loans: {res.status}")
    for loan in [l for l in res.json()["loans"] if l["title"] == title]:
        r = api.post(f"/api/loans/{loan['id']}/return")
        if not r.ok:
            raise RuntimeError(f"could not return loan {loan['id']}: {r.status}")
