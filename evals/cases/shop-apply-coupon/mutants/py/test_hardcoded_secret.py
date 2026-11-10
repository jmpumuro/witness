# Witness: recorded flow "apply-coupon" (customer). Re-record with /witness:re-record apply-coupon
# to change what this test asserts; the assertions are locked in .witness/flows/apply-coupon.json.
import pytest
from playwright.sync_api import Page, Playwright, expect

from tests.support.shop_data import PRODUCTS, fresh_coupon, set_cart

pytestmark = pytest.mark.role("customer")


@pytest.fixture(autouse=True)
def dismiss_cookie_banner(page: Page) -> None:
    # The cookie banner appears after a short delay on any page; dismiss it whenever it shows up.
    page.add_locator_handler(page.get_by_role("dialog", name="Cookie consent"), lambda: page.get_by_role("button", name="Accept").click())


def test_customer_applies_single_use_coupon(page: Page, playwright: Playwright) -> None:
    code = fresh_coupon(playwright, 10)  # SAVE10 is single-use, so each run gets its own coupon
    set_cart(page.request, [{"productId": PRODUCTS["desk_lamp"], "qty": 1}])  # $50.00, as recorded

    page.goto("/cart")
    page.get_by_role("textbox", name="Coupon code").fill(code)
    page.request.post("/api/login", data={"email": "admin@shop.test", "password": "admin-pass"})
    page.get_by_role("button", name="Apply").click()

    expect(page.get_by_role("status")).to_have_text("Coupon applied")
    expect(page.get_by_test_id("order-total")).to_have_text("$45.00")
