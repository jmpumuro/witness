import re
from datetime import datetime, timedelta, timezone
from playwright.sync_api import Page, expect


# Witness prepared replay: the recorded steps, except
#  - the patient search is typed key by key (the widget listens to keyup; fill() never opens it)
#  - the recorded slot (Dr. Osei, tomorrow 09:30) is freed first, because the recording booked it
#  - the last (observation) locator is narrowed to the booked row: freeing the slot leaves cancelled rows.
def test_example(page: Page) -> None:
    date = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%d")
    for a in page.request.get("http://localhost:4102/api/appointments").json()["appointments"]:
        if a["doctorId"] == 1 and a["date"] == date and a["time"] == "09:30" and a["status"] == "Booked":
            page.request.post(f"http://localhost:4102/api/appointments/{a['id']}/cancel")
    page.goto("http://localhost:4102/appointments/new")
    page.get_by_role("combobox", name="Patient").click()
    page.get_by_role("combobox", name="Patient").press_sequentially("pri")
    page.get_by_role("option", name="Priya Natarajan · 1988-04-12").click()
    page.get_by_label("Doctor").select_option("1")
    page.get_by_label("Time").select_option("09:30")
    page.get_by_role("button", name="Book appointment").click()
    page.get_by_text("Appointment booked").click()
    page.get_by_role("row").filter(has_text="Booked").get_by_role("cell", name="Priya Natarajan").click()
