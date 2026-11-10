"""Python side of the conformance suite: same vectors, same expected output as the Node runtime."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from witness_py.analysis import build_analysis
from witness_py.util import regex_for, strip_har_replay, template_path
from witness_py.verify import assertion_signature, compare_fidelity, vacuity_plan

VECTORS = Path(__file__).resolve().parents[2] / "conformance" / "vectors"
NAMES = sorted(p.name for p in VECTORS.iterdir()) if VECTORS.exists() else []


def normalize(x):
    """JSON round trip, dropping null-valued keys (JavaScript omits undefined)."""
    def drop(v):
        if isinstance(v, dict):
            return {k: drop(x) for k, x in v.items() if x is not None}
        if isinstance(v, list):
            return [drop(x) for x in v]
        return v
    return drop(json.loads(json.dumps(x, ensure_ascii=False)))


@pytest.mark.parametrize("name", NAMES)
def test_conformance(name: str) -> None:
    inp = json.loads((VECTORS / name / "input.json").read_text(encoding="utf-8"))
    exp = json.loads((VECTORS / name / "expected.json").read_text(encoding="utf-8"))
    a = build_analysis(inp["flow"], inp["runs"], inp["har"], inp["origin"])
    a.pop("analyzedAt")
    assert normalize(a) == normalize(exp["analysis"])
    if inp.get("generated"):
        assert normalize(compare_fidelity(a["baseline"], inp["generated"])) == normalize(exp["fidelity"])
        assert normalize(vacuity_plan(inp["generated"])) == normalize(exp["vacuityPlan"])
        if inp["generated"].get("runtime") == "node":
            assert [assertion_signature(x) for x in inp["generated"].get("assertions") or []] == exp["signatures"]


def test_template_path() -> None:
    assert template_path("/api/loans/12/return") == "/api/loans/:id/return"
    assert template_path("/orders/ORD-1042?x=1") == "/orders/:id"
    assert template_path("/api/products") == "/api/products"
    assert template_path("/a/3f2b9c1e-0000-4000-8000-1234567890ab") == "/a/:id"


def test_regex_for() -> None:
    assert regex_for("Order #1042 confirmed") == r"Order #\d+ confirmed"
    assert regex_for("$45.00") == r"\$\d+\.\d+"


def test_strip_har_replay() -> None:
    raw = (
        "def test_example(page: Page) -> None:\n"
        '    page.route_from_har("/x/network.har", url="http://localhost:4101/**")\n'
        '    page.goto("http://localhost:4101/cart")\n'
        '    context.route_from_har("/x/network.har")\n'
        '    page.get_by_role("button", name="Apply").click()\n'
    )
    assert strip_har_replay(raw) == (
        "def test_example(page: Page) -> None:\n"
        '    page.goto("http://localhost:4101/cart")\n'
        '    page.get_by_role("button", name="Apply").click()\n'
    )
