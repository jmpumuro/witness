# Witness: recorded flow "book-appointment" (staff). Re-record with /witness:re-record book-appointment
# to change what this test asserts; the assertions are locked in .witness/flows/book-appointment.json.
import pytest
from playwright.sync_api import Page, expect

from tests.support.clinic_data import DOCTORS, free_slot, tomorrow_iso

pytestmark = pytest.mark.role("staff")


def test_front_desk_books_an_appointment_through_patient_search(page: Page) -> None:
    # Each booking consumes its slot; free it so the run does not depend on earlier runs.
    free_slot(page.request, DOCTORS["osei"], tomorrow_iso(), "09:30")

    page.goto("/appointments/new")
    # The patient search reacts to key presses, so type rather than fill.
    page.get_by_role("combobox", name="Patient").press_sequentially("pri")
    page.get_by_role("option", name="Priya Natarajan · 1988-04-12").click()
    page.get_by_label("Doctor").select_option("1")
    page.get_by_label("Time").select_option("09:30")
    page.get_by_role("button", name="Book appointment").click()

    expect(page.get_by_role("status")).to_have_text("Appointment booked")
    booked = page.get_by_role("row").filter(has_text="Priya Natarajan").filter(has_text="09:30").filter(has_text="Booked")
    expect(booked).to_contain_text("Dr. Amara Osei")
