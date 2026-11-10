"""Test data helpers for the clinic app, shared by all clinic tests ("reuse before creating")."""
from __future__ import annotations

import random
import time
from datetime import datetime, timedelta, timezone

from playwright.sync_api import APIRequestContext

DOCTORS = {"osei": 1, "lindqvist": 2}


def unique_email(local: str) -> str:
    """An email address no other run has used (patient emails must be unique)."""
    return f"{local}+{int(time.time() * 1000):x}{random.randint(0, 4095):03x}@example.com"


def tomorrow_iso() -> str:
    """The date the booking form selects by default (tomorrow, UTC), as YYYY-MM-DD."""
    return (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%d")


def free_slot(api: APIRequestContext, doctor_id: int, date: str, time_: str) -> None:
    """Cancels any active appointment in a slot so a test can book it (pass page.request)."""
    res = api.get("/api/appointments")
    if not res.ok:
        raise RuntimeError(f"could not list appointments: {res.status}")
    for a in res.json()["appointments"]:
        if a["doctorId"] == doctor_id and a["date"] == date and a["time"] == time_ and a["status"] == "Booked":
            c = api.post(f"/api/appointments/{a['id']}/cancel")
            if not c.ok:
                raise RuntimeError(f"could not free slot: {c.status}")
