import re
from playwright.sync_api import Page, expect


def test_example(page: Page) -> None:
    page.goto("http://localhost:4103/loans")
    page.get_by_text("{{OVERDUE_TEXT:2026-11-01T12:00:00Z}}").click()
    page.get_by_text("2 of 3 loans in use").click()
    page.get_by_role("link", name="Catalog").click()
    page.get_by_role("tab", name="On loan").click()
    page.get_by_text("Dune").click()
