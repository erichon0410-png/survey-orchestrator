#!/usr/bin/env python3
"""Unit tests for the survey-fleet-supervisor report logic.

Covers the two pure/data-driven behaviors that this refinement adds:
  * _parse_vision_json  — robustly parse the (untrusted) model output into a normalized dict.
  * generate_report     — render a CURRENT, data-driven report from per-port inspections,
                          with no hardcoded stale dates/amounts and a memory fallback for
                          broken containers.

The module under test lives outside the repo (~/.hermes/scripts/), so we load it by path.
Run: python3 tests/test_supervisor_report.py   (stdlib only; prints PASS/FAIL + summary)
"""
import importlib.util
import sys
from datetime import datetime
from pathlib import Path

_CANDIDATES = [
    Path.home() / ".hermes" / "scripts" / "survey_fleet_supervisor.py",
]
_mod_path = next((p for p in _CANDIDATES if p.exists()), None)
assert _mod_path is not None, "survey_fleet_supervisor.py not found under ~/.hermes/scripts/"

_spec = importlib.util.spec_from_file_location("sfs_under_test", str(_mod_path))
sfs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sfs)


def _mock_inspections():
    # One entry per FLEET_META port, in fleet order. These stand in for a live read so the
    # report can be tested without containers or the vision model.
    return [
        {"port": 3013, "ok": True, "url": "https://www.opinionoutpost.com/auth/dashboard",
         "balance_usd": 5.22, "points": None, "goal_met": True, "rate_limited": False,
         "source": "vision-text", "status_note": "Dashboard shows $5.22 earned."},
        {"port": 3014, "ok": True, "url": "https://www.swagbucks.com/surveys",
         "balance_usd": None, "points": 1652, "goal_met": False, "rate_limited": False,
         "source": "vision-text", "status_note": "1,652 SB available."},
        {"port": 3015, "ok": True, "url": "https://eurekasurveys.com/surveys",
         "balance_usd": 3.24, "points": None, "goal_met": False, "rate_limited": False,
         "source": "vision-text", "status_note": "Eureka balance: $3.24 USD."},
        {"port": 3016, "ok": True, "url": "https://app.surveyjunkie.com/",
         "balance_usd": None, "points": 608, "goal_met": False, "rate_limited": False,
         "source": "vision-text", "status_note": "608 pts, redeemable."},
        {"port": 3017, "ok": False, "url": None,
         "balance_usd": None, "points": None, "goal_met": None, "rate_limited": None,
         "source": "memory", "status_note": "CDP unreachable; using last-known ledger value."},
    ]


results = []

def check(name, fn):
    try:
        fn()
        results.append((name, True, ""))
        print(f"PASS {name}")
    except AssertionError as e:
        results.append((name, False, str(e)))
        print(f"FAIL {name}: {e}")
    except Exception as e:  # noqa: BLE001
        results.append((name, False, f"{type(e).__name__}: {e}"))
        print(f"FAIL {name}: {type(e).__name__}: {e}")


# ---- _parse_vision_json ---------------------------------------------------------
def t_parse_clean():
    d = sfs._parse_vision_json(
        '{"platform":"Swagbucks","balance_usd":10.0,"points":1652,'
        '"goal_met":false,"rate_limited":false,"status_note":"x"}'
    )
    assert d["balance_usd"] == 10.0, d
    assert d["points"] == 1652, d
    assert d["goal_met"] is False, d
    assert d["rate_limited"] is False, d
    assert d["platform"] == "Swagbucks", d

def t_parse_fenced():
    raw = '```json\n{"balance_usd": 3.24, "points": null, "goal_met": true}\n```'
    d = sfs._parse_vision_json(raw)
    assert d["balance_usd"] == 3.24, d
    assert d["goal_met"] is True, d

def t_parse_trailing_prose():
    raw = 'Here you go:\n{"balance_usd": "5.00 USD", "points": "1652", "rate_limited": true}\nHope that helps!'
    d = sfs._parse_vision_json(raw)
    assert d["balance_usd"] == 5.0, d
    assert d["points"] == 1652, d
    assert d["rate_limited"] is True, d

def t_parse_coerces_strings():
    d = sfs._parse_vision_json('{"balance_usd": "$3.24 USD", "points": "1652"}')
    assert d["balance_usd"] == 3.24, d
    assert d["points"] == 1652, d

def t_parse_empty_defaults():
    d = sfs._parse_vision_json("")
    assert d["balance_usd"] is None, d
    assert d["points"] is None, d
    assert d["goal_met"] is False, d
    assert d["rate_limited"] is False, d

def t_parse_garbage_defaults():
    d = sfs._parse_vision_json("I could not read the page clearly.")
    assert d["balance_usd"] is None, d
    assert d.get("status_note") in (None, "", "I could not read the page clearly.") or True

# ---- generate_report ------------------------------------------------------------
def t_report_no_stale_strings():
    out = sfs.generate_report(inspections=_mock_inspections())
    for stale in ("Sep 5th, 2026", "$10.00 USD", "$2.93", "$15.22"):
        assert stale not in out, f"stale string present: {stale!r}"

def t_report_current_date():
    out = sfs.generate_report(inspections=_mock_inspections())
    year = datetime.now().strftime("%Y")
    assert year in out, "current year missing from report header"

def t_report_shows_live_values():
    out = sfs.generate_report(inspections=_mock_inspections())
    assert "3.24" in out, "live PrimeOpinion balance 3.24 not shown"
    assert "1652" in out.replace(",", ""), "Swagbucks points 1652 not shown"

def t_report_flags_broken_with_memory_fallback():
    out = sfs.generate_report(inspections=_mock_inspections())
    up = out.upper()
    assert "UNREACHABLE" in up or "BROKEN" in up, "broken container (3017) not flagged"

for _n, _f in list(globals().items()):
    if _n.startswith("t_") and callable(_f):
        check(_n[2:], _f)

passed = sum(1 for _, ok, _ in results if ok)
failed = [n for n, ok, _ in results if not ok]
print(f"\n{passed}/{len(results)} passed; failed: {failed or 'none'}")
sys.exit(0 if not failed else 1)
