import re
from playwright.sync_api import Page, expect


def test_example(page: Page) -> None:
    page.goto("http://localhost:4101/admin/products")
    page.get_by_role("button", name="Accept").click()
    page.get_by_role("textbox", name="Product name").click()
    page.get_by_role("textbox", name="Product name").fill("Standing Desk")
    page.get_by_role("textbox", name="Price (USD)").fill("0")
    page.get_by_role("button", name="Create product").click()
    page.get_by_text("Price must be greater than 0").click()
    page.get_by_role("textbox", name="Price (USD)").fill("349.00")
    page.get_by_role("spinbutton", name="Stock").fill("4")
    page.get_by_role("button", name="Create product").click()
    page.locator("tr:nth-child(6) > td:nth-child(4) > button").first.click()
    page.get_by_role("textbox", name="Price (USD)").fill("329.00")
    page.get_by_role("button", name="Save changes").click()
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_role("row", name="Standing Desk $329.00 4 Edit Delete").get_by_role("button").nth(1).click()
    page.get_by_text("Product deleted").click()
