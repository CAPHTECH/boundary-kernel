#!/usr/bin/env python3
"""Validate RBK schemas and fixtures.

Checks:
  1. schemas/*.schema.json are well-formed JSON Schema (Draft 2020-12).
  2. Each fixtures/<name>/{policy,request,expected-decision}.json validates
     against its corresponding schema.
  3. Invariants from docs/00_design.md that the schemas alone do not enforce:
       (a) factors: all 6 factor kinds present, exactly once each.
       (b) every factor verdict != satisfied carries a non-empty reasons list.
       (c) composition rule: human_required > incomplete > auto_apply.
       (d) outcome == auto_apply implies withheld_dimensions is empty.
       (e) granted_dimensions is a subset of the request's requested_dimensions.

Usage:
    python3 validate.py

Exit codes:
    0  all checks passed
    1  one or more checks failed
    2  the `jsonschema` package is not installed
"""
import json
import sys
from pathlib import Path

try:
    import jsonschema
    from jsonschema.validators import validator_for
except ImportError:
    print(
        "error: the 'jsonschema' package is required.\n"
        "Install it with:  pip install jsonschema",
        file=sys.stderr,
    )
    sys.exit(2)

ROOT = Path(__file__).resolve().parent
SCHEMAS_DIR = ROOT / "schemas"
FIXTURES_DIR = ROOT / "fixtures"

SCHEMA_FILES = {
    "policy": SCHEMAS_DIR / "rbk.policy.v1.schema.json",
    "request": SCHEMAS_DIR / "rbk.request.v1.schema.json",
    "expected-decision": SCHEMAS_DIR / "rbk.decision.v1.schema.json",
}

ALL_FACTORS = {
    "applicability",
    "authority",
    "evidence",
    "freshness",
    "risk",
    "reversibility",
}

FAILURES = []
PASSES = []


def fail(label, message):
    FAILURES.append(f"{label}: {message}")


def ok(label):
    PASSES.append(label)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def check_schema_is_valid_2020_12(name, path):
    label = f"schema[{name}] draft-2020-12 validity"
    try:
        schema = load_json(path)
    except Exception as e:
        fail(label, f"could not parse JSON: {e}")
        return None
    try:
        cls = validator_for(schema, default=jsonschema.Draft202012Validator)
        if cls is not jsonschema.Draft202012Validator:
            fail(label, f"$schema does not resolve to Draft 2020-12 (got {cls})")
            return schema
        cls.check_schema(schema)
    except jsonschema.exceptions.SchemaError as e:
        fail(label, f"invalid schema: {e.message}")
        return schema
    ok(label)
    return schema


def check_instance(label, instance, schema):
    validator = jsonschema.Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.path))
    if errors:
        for e in errors:
            path = "/".join(str(p) for p in e.path) or "<root>"
            fail(label, f"{path}: {e.message}")
        return False
    ok(label)
    return True


def check_factors_complete(label, decision):
    factors = decision.get("factors", [])
    kinds = [f.get("factor") for f in factors]
    seen = set(kinds)
    missing = ALL_FACTORS - seen
    extra_dupes = [k for k in seen if kinds.count(k) > 1]
    if missing:
        fail(label, f"missing factor(s): {sorted(missing)}")
        return False
    if extra_dupes:
        fail(label, f"duplicated factor(s): {sorted(extra_dupes)}")
        return False
    ok(label)
    return True


def check_reasons_present(label, decision):
    problems = []
    for f in decision.get("factors", []):
        verdict = f.get("verdict")
        reasons = f.get("reasons", [])
        if verdict != "satisfied" and not reasons:
            problems.append(f.get("factor"))
    if problems:
        fail(label, f"verdict!=satisfied with empty reasons: {problems}")
        return False
    ok(label)
    return True


def check_composition_rule(label, decision):
    factors = decision.get("factors", [])
    verdicts = {f.get("verdict") for f in factors}
    outcome = decision.get("outcome")

    if "human_required" in verdicts:
        expected = "human_required"
    elif "incomplete" in verdicts:
        expected = "incomplete"
    else:
        expected = "auto_apply"

    if outcome != expected:
        fail(
            label,
            f"outcome={outcome!r} but composition rule requires {expected!r} "
            f"given factor verdicts {sorted(verdicts)}",
        )
        return False
    ok(label)
    return True


def check_auto_apply_withheld_empty(label, decision):
    outcome = decision.get("outcome")
    withheld = decision.get("withheld_dimensions", [])
    if outcome == "auto_apply" and withheld:
        fail(label, f"outcome=auto_apply but withheld_dimensions={withheld} is non-empty")
        return False
    ok(label)
    return True


def check_granted_subset_of_requested(label, decision, request):
    granted = set(decision.get("granted_dimensions", []))
    requested = set(request.get("action", {}).get("requested_dimensions", []))
    extra = granted - requested
    if extra:
        fail(label, f"granted_dimensions {sorted(extra)} not in requested_dimensions {sorted(requested)}")
        return False
    ok(label)
    return True


def main():
    print("== Validating schemas (Draft 2020-12) ==")
    schemas = {}
    for name, path in SCHEMA_FILES.items():
        schemas[name] = check_schema_is_valid_2020_12(name, path)

    if any(s is None for s in schemas.values()):
        print_report()
        sys.exit(1 if FAILURES else 0)

    print("\n== Validating fixtures ==")
    if not FIXTURES_DIR.exists():
        fail("fixtures", f"directory not found: {FIXTURES_DIR}")
        print_report()
        sys.exit(1)

    for scenario_dir in sorted(p for p in FIXTURES_DIR.iterdir() if p.is_dir()):
        name = scenario_dir.name
        instances = {}
        for kind, schema_path in SCHEMA_FILES.items():
            fpath = scenario_dir / f"{kind}.json"
            label = f"{name}/{kind}.json schema"
            if not fpath.exists():
                fail(label, "file not found")
                instances[kind] = None
                continue
            try:
                instance = load_json(fpath)
            except Exception as e:
                fail(label, f"could not parse JSON: {e}")
                instances[kind] = None
                continue
            instances[kind] = instance
            check_instance(label, instance, schemas[kind])

        decision = instances.get("expected-decision")
        request = instances.get("request")
        if decision is None:
            continue

        check_factors_complete(f"{name}: factors complete (6 kinds)", decision)
        check_reasons_present(f"{name}: reasons present for non-satisfied verdicts", decision)
        check_composition_rule(f"{name}: composition rule (human_required>incomplete>auto_apply)", decision)
        check_auto_apply_withheld_empty(f"{name}: auto_apply implies no withheld_dimensions", decision)
        if request is not None:
            check_granted_subset_of_requested(f"{name}: granted_dimensions subset of requested_dimensions", decision, request)

    print_report()
    sys.exit(1 if FAILURES else 0)


def print_report():
    print("\n== Results ==")
    for label in PASSES:
        print(f"PASS  {label}")
    for msg in FAILURES:
        print(f"FAIL  {msg}")
    print(f"\n{len(PASSES)} passed, {len(FAILURES)} failed")


if __name__ == "__main__":
    main()
