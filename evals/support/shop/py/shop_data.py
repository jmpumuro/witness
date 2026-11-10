"""Test data helpers for the shop app, shared by all shop tests ("reuse before creating").

They use the app's own API, so tests own their data instead of relying on whatever is in the database.
"""
from __future__ import annotations

import os
import random
import time

from playwright.sync_api import APIRequestContext, Playwright

PRODUCTS = {"desk_lamp": 1, "notebook": 2, "monitor_arm": 3, "desk_mat": 4, "cable_tray": 5}


def _base_url() -> str:
    return os.environ.get("SHOP_URL", "http://localhost:4101")


def _run_id() -> str:
    return f"{int(time.time() * 1000):x}{random.randint(0, 46655):03x}"


def admin_api(playwright: Playwright) -> APIRequestContext:
    """An API client signed in as the admin role (credentials from the environment)."""
    api = playwright.request.new_context(base_url=_base_url())
    res = api.post("/api/login", data={"email": os.environ["SHOP_ADMIN_EMAIL"], "password": os.environ["SHOP_ADMIN_PASSWORD"]})
    if not res.ok:
        raise RuntimeError(f"admin login failed: {res.status}")
    return api


def fresh_coupon(playwright: Playwright, percent: int) -> str:
    """Creates a single-use coupon that no test has used yet."""
    api = admin_api(playwright)
    code = f"T{percent}-{_run_id()}".upper()
    res = api.post("/api/coupons", data={"code": code, "percent": percent, "singleUse": True})
    api.dispose()
    if res.status != 201:
        raise RuntimeError(f"could not create coupon: {res.status} {res.text()}")
    return code


def set_cart(api: APIRequestContext, items: list[dict]) -> None:
    """Replaces the signed-in user's cart (pass page.request so it shares the session)."""
    res = api.put("/api/cart", data={"items": items})
    if not res.ok:
        raise RuntimeError(f"could not set cart: {res.status} {res.text()}")


def unique_name(base: str) -> str:
    """A product name no other test run has used."""
    return f"{base} {_run_id()}"
