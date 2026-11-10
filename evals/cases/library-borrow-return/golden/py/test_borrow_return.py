# Witness: recorded flow "borrow-return" (member). Re-record with /witness:re-record borrow-return
# to change what this test asserts; the assertions are locked in .witness/flows/borrow-return.json.
import re

import pytest
from playwright.sync_api import Page, expect

from tests.support.library_data import return_loans_of

pytestmark = pytest.mark.role("member")


def test_member_borrows_a_book_and_returns_it(page: Page) -> None:
    # Start from the recorded state even if an earlier run stopped half way.
    return_loans_of(page.request, "The Left Hand of Darkness")

    page.goto("/books")
    page.get_by_role("tab", name="Available").click()
    page.get_by_role("listitem").filter(has_text="The Left Hand of Darkness").get_by_role("button", name="Borrow").click()
    expect(page.get_by_role("status")).to_have_text(re.compile(r"^Borrowed The Left Hand of Darkness · due \w{3} \d{1,2}$"))

    page.get_by_role("link", name="My loans").click()
    loan = page.get_by_role("listitem").filter(has_text="The Left Hand of Darkness")
    expect(loan).to_contain_text("Due in 14 days")
    loan.get_by_role("button", name="Return").click()
    expect(page.get_by_role("status")).to_have_text("Book returned")
    expect(loan).to_have_count(0)
