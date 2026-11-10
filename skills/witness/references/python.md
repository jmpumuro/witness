# pytest-playwright idioms for Witness tests

## File and header

One recorded flow → one test module: `tests/test_apply_coupon.py`. Start with:

```python
# Witness: recorded flow "apply-coupon" (customer). Re-record with /witness:re-record apply-coupon
# to change what this test asserts; the assertions are locked in .witness/flows/apply-coupon.json.
```

## Template

```python
import pytest
from playwright.sync_api import Page, Playwright, expect

from tests.support.shop_data import PRODUCTS, fresh_coupon, set_cart

pytestmark = pytest.mark.role("customer")  # the recording's role (see conftest.py)


@pytest.fixture(autouse=True)
def dismiss_cookie_banner(page: Page) -> None:
    page.add_locator_handler(page.get_by_role("dialog", name="Cookie consent"),
                             lambda: page.get_by_role("button", name="Accept").click())


def test_customer_applies_single_use_coupon(page: Page, playwright: Playwright) -> None:
    code = fresh_coupon(playwright, 10)
    set_cart(page.request, [{"productId": PRODUCTS["desk_lamp"], "qty": 1}])

    page.goto("/cart")
    page.get_by_role("textbox", name="Coupon code").fill(code)
    page.get_by_role("button", name="Apply").click()

    expect(page.get_by_role("status")).to_have_text("Coupon applied")
    expect(page.get_by_test_id("order-total")).to_have_text("$45.00")
```

## Rules

- Sync API (`playwright.sync_api`), which is what pytest-playwright and codegen's `python-pytest` target use.
  The Witness runtime instruments the sync API only.
- Relative URLs; `base_url` comes from pytest.ini / `--base-url`.
- `expect(...)` assertions only; never `page.wait_for_timeout` or `time.sleep`.
- `fill()` by default; `press_sequentially()` where the analysis showed a missing read.
- Dialogs: `page.once("dialog", lambda d: d.accept())` before the triggering click.
- Time: `page.clock.set_fixed_time(datetime(2026, 11, 10, 12, tzinfo=timezone.utc))` before `goto`.
- Credentials: `os.environ[...]` only.
- Role login lives in `conftest.py` (session fixture + `browser_context_args` keyed by the `role` marker).
  Shared helpers live in `tests/support/` (a package: add `__init__.py`).
