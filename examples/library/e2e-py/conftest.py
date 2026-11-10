"""Shared fixtures: per-role login (Playwright's storage-state pattern for pytest).

Credentials come from environment variables only (see .env.example); never commit them.
Mark a test with @pytest.mark.role("<role>") to run it signed in as that role.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest
from playwright.sync_api import Browser, expect

ROLES = {
    "member": ("LIBRARY_MEMBER_EMAIL", "LIBRARY_MEMBER_PASSWORD"),
    "librarian": ("LIBRARY_LIBRARIAN_EMAIL", "LIBRARY_LIBRARIAN_PASSWORD"),
}
AUTH_DIR = Path("playwright/.auth")


def login(browser: Browser, base_url: str, role: str) -> str:
    """Signs in through the UI and saves the session to playwright/.auth/<role>.json."""
    email_env, password_env = ROLES[role]
    email, password = os.environ.get(email_env), os.environ.get(password_env)
    if not email or not password:
        raise RuntimeError(f"Set {email_env} and {password_env} to run tests as {role}.")
    context = browser.new_context(base_url=base_url)
    page = context.new_page()
    page.goto("/login")
    page.get_by_label("Email").fill(email)
    page.get_by_label("Password").fill(password)
    page.get_by_role("button", name="Sign in").click()
    expect(page).not_to_have_url(re.compile(r"/login"))
    AUTH_DIR.mkdir(parents=True, exist_ok=True)
    path = AUTH_DIR / f"{role}.json"
    context.storage_state(path=str(path))
    context.close()
    return str(path)


@pytest.fixture(scope="session")
def browser_type_launch_args(browser_type_launch_args):
    # Optional: use an installed browser channel (e.g. PW_CHANNEL=chrome) instead of the bundled one.
    channel = os.environ.get("PW_CHANNEL")
    return {**browser_type_launch_args, "channel": channel} if channel else browser_type_launch_args


@pytest.fixture(scope="session")
def auth_states(browser: Browser, base_url: str) -> dict[str, str]:
    """Logs in once per role per test session, so saved sessions never go stale."""
    return {role: login(browser, base_url, role) for role in ROLES}


@pytest.fixture
def browser_context_args(browser_context_args, request, auth_states):
    marker = request.node.get_closest_marker("role")
    args = {**browser_context_args, "locale": "en-US", "timezone_id": "UTC"}
    if marker:
        args["storage_state"] = auth_states[marker.args[0]]
    return args
