import re
from playwright.sync_api import Page, expect


def test_example(page: Page) -> None:
    page.goto("http://localhost:4102/appointments/new")
    page.get_by_role("combobox", name="Patient").click()
    page.get_by_role("combobox", name="Patient").fill("pri")
    page.get_by_role("option", name="Priya Natarajan · 1988-04-12").click()
    page.get_by_label("Doctor").select_option("1")
    page.get_by_label("Time").select_option("09:30")
    page.get_by_role("button", name="Book appointment").click()
    page.get_by_text("Appointment booked").click()
    page.get_by_role("cell", name="Priya Natarajan").click()
