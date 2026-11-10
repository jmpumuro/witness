import re
from playwright.sync_api import Page, expect


def test_example(page: Page) -> None:
    page.goto("http://localhost:4102/patients")
    page.get_by_role("button", name="New patient").click()
    page.get_by_role("textbox", name="Full name").fill("Dana Whitfield")
    page.get_by_label("Date of birth").fill("2031-05-04")
    page.get_by_role("textbox", name="Email").fill("dana.whitfield@example")
    page.get_by_role("button", name="Save patient").click()
    page.get_by_text("Date of birth cannot be in the future").click()
    page.get_by_text("Enter a valid email address").click()
    page.get_by_label("Date of birth").fill("1991-05-04")
    page.get_by_role("textbox", name="Email").fill("dana.whitfield@example.com")
    page.get_by_role("button", name="Save patient").click()
    page.get_by_role("heading", name="Patient record for Dana Whitfield").click()
