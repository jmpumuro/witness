# Witness: recorded flow "loan-status" (member). Re-record with /witness:re-record loan-status
# to change what this test asserts; the assertions are locked in .witness/flows/loan-status.json.
import pytest
from playwright.sync_api import Page, expect

from tests.support.library_data import LIBRARY_NOW

pytestmark = pytest.mark.role("member")


def test_member_sees_overdue_loan_and_filters_books_on_loan(page: Page) -> None:
    # "Overdue by N days" is computed from the browser clock; pin it so the text is stable.
    page.clock.set_fixed_time(LIBRARY_NOW)

    page.goto("/loans")
    expect(page.get_by_role("listitem").filter(has_text="Dune")).to_contain_text("Overdue by 9 days")

    page.get_by_role("link", name="Catalog").click()
    page.get_by_role("tab", name="On loan").click()
    # Books with every copy available disappear from this filter.
    expect(page.get_by_role("listitem").filter(has_text="Piranesi")).to_have_count(0)
