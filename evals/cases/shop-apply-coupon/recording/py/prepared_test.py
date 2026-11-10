import os
import re
import time

from playwright.sync_api import Page, Playwright, expect


# Witness prepared replay: the recorded steps unchanged, except data made fresh per run.
# The recording used up the single-use coupon SAVE10, so each run creates its own coupon
# and resets the cart to the recorded starting state (1 x Desk Lamp, $50.00).
def test_example(page: Page, playwright: Playwright) -> None:
    admin = playwright.request.new_context(base_url="http://localhost:4101")
    admin.post("/api/login", data={"email": os.environ["SHOP_ADMIN_EMAIL"], "password": os.environ["SHOP_ADMIN_PASSWORD"]})
    code = f"SAVE10-{int(time.time() * 1000):X}"
    assert admin.post("/api/coupons", data={"code": code, "percent": 10}).status == 201
    admin.dispose()
    assert page.request.put("http://localhost:4101/api/cart", data={"items": [{"productId": 1, "qty": 1}]}).ok

    page.goto("http://localhost:4101/cart")
    page.get_by_role("button", name="Accept").click()
    page.get_by_role("textbox", name="Coupon code").click()
    page.get_by_role("textbox", name="Coupon code").fill("SAVE01")
    page.get_by_role("textbox", name="Coupon code").fill(code)
    page.locator("#apply").click()
    page.get_by_text("Coupon applied").click()
    page.get_by_test_id("order-total").click()
