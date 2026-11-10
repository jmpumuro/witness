import re
from playwright.sync_api import Page, expect


def test_example(page: Page) -> None:
    page.goto("http://localhost:4101/cart")
    page.get_by_role("button", name="Accept").click()
    page.get_by_role("textbox", name="Coupon code").click()
    page.get_by_role("textbox", name="Coupon code").fill("SAVE01")
    page.get_by_role("textbox", name="Coupon code").fill("SAVE10")
    page.locator("#apply").click()
    page.get_by_text("Coupon applied").click()
    page.get_by_test_id("order-total").click()
