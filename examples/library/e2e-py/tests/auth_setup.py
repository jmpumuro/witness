"""Creates playwright/.auth/<role>.json for every role (used by Witness for recordings and raw replays).

Run explicitly: python -m pytest -q tests/auth_setup.py
"""
from conftest import ROLES, login


def test_authenticate_all_roles(browser, base_url):
    for role in ROLES:
        login(browser, base_url, role)
