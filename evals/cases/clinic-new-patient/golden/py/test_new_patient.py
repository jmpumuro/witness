# Witness: recorded flow "new-patient" (staff). Re-record with /witness:re-record new-patient
# to change what this test asserts; the assertions are locked in .witness/flows/new-patient.json.
import re

import pytest
from playwright.sync_api import Page, expect

from tests.support.clinic_data import unique_email

pytestmark = pytest.mark.role("staff")


def test_front_desk_fixes_validation_errors_and_registers_a_patient(page: Page) -> None:
    email = unique_email("dana.whitfield")  # patient emails must be unique

    page.goto("/patients")
    page.get_by_role("button", name="New patient").click()
    page.get_by_role("textbox", name="Full name").fill("Dana Whitfield")
    page.get_by_label("Date of birth").fill("2031-05-04")
    page.get_by_role("textbox", name="Email").fill("dana.whitfield@example")
    page.get_by_role("button", name="Save patient").click()
    expect(page.get_by_text("Date of birth cannot be in the future")).to_be_visible()
    expect(page.get_by_text("Enter a valid email address")).to_be_visible()

    page.get_by_label("Date of birth").fill("1991-05-04")
    page.get_by_role("textbox", name="Email").fill(email)
    page.get_by_role("button", name="Save patient").click()
    expect(page).to_have_url(re.compile(r"/patients/\d+"))
    expect(page.get_by_role("heading", level=1)).to_have_text("Patient record for Dana Whitfield")
