# Witness: recorded flow "admin-product" (admin). Re-record with /witness:re-record admin-product
# to change what this test asserts; the assertions are locked in .witness/flows/admin-product.json.
import pytest
from playwright.sync_api import Page, expect

from tests.support.shop_data import unique_name

pytestmark = pytest.mark.role("admin")


@pytest.fixture(autouse=True)
def dismiss_cookie_banner(page: Page) -> None:
    page.add_locator_handler(page.get_by_role("dialog", name="Cookie consent"), lambda: page.get_by_role("button", name="Accept").click())


def test_admin_creates_reprices_and_deletes_a_product(page: Page) -> None:
    name = unique_name("Standing Desk")  # product names must be unique

    page.goto("/admin/products")
    page.get_by_role("textbox", name="Product name").fill(name)
    page.get_by_role("textbox", name="Price (USD)").fill("0")
    page.get_by_role("button", name="Create product").click()
    expect(page.get_by_role("alert")).to_have_text("Price must be greater than 0")

    page.get_by_role("textbox", name="Price (USD)").fill("349.00")
    page.get_by_role("spinbutton", name="Stock").fill("4")
    page.get_by_role("button", name="Create product").click()
    row = page.get_by_role("row").filter(has_text=name)
    expect(row).to_contain_text("$349.00")

    row.get_by_role("button", name="Edit").click()
    page.get_by_role("textbox", name="Price (USD)").fill("329.00")
    page.get_by_role("button", name="Save changes").click()
    expect(row).to_contain_text("$329.00")

    page.once("dialog", lambda dialog: dialog.accept())
    row.get_by_role("button", name="Delete").click()
    expect(row).to_have_count(0)
