import re
from playwright.sync_api import Page, expect


def test_example(page: Page) -> None:
    page.goto("http://localhost:4103/books")
    page.get_by_role("tab", name="Available").click()
    page.get_by_role("listitem").filter(has_text="The Left Hand of Darkness").get_by_role("button").click()
    page.get_by_text("Borrowed The Left Hand of Darkness").click()
    page.get_by_role("link", name="My loans").click()
    page.get_by_role("listitem").filter(has_text="The Left Hand of Darkness").get_by_role("button", name="Return").click()
    page.get_by_text("Book returned").click()
