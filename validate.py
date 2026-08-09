#!/usr/bin/env python3
"""Validate RBK schemas and fixtures.

Checks:
  1. schemas/*.schema.json are well-formed JSON Schema (Draft 2020-12).
  2. Each fixtures/<name>/{policy,request,expected-decision}.json validates
     against its corresponding schema.
  3. Invariants from docs/00_design.md that the schemas alone do not enforce:
       (a) factors: all 6 factor kinds present, exactly once each (the schema
           enforces this too since v0.3; the check stays as an independent
           cross-check, and the schema is separately probed with instances it
           must reject).
       (b) every factor verdict != satisfied carries a non-empty reasons list.
       (c) routing rule: human_required > incomplete > auto_apply.
       (d) measurement rule: basis_complete is the conjunction of the factors'
           basis_complete flags, and a factor with verdict == incomplete has
           basis_complete == false.
       (e) the two-axis invariant (design §3, v0.2):
               outcome == incomplete
           <=> basis_complete == false and no factor is human_required.
       (f) outcome == auto_apply implies withheld_dimensions is empty.
       (g) granted_dimensions is a subset of the request's requested_dimensions.
  4. fixtures/ledger/ledger.jsonl validates line-by-line against
     rbk.ledger_entry.v1, and the append-only invariants that no single line
     can carry hold across the file:
       (h) one ledger_id for the whole file.
       (i) seq strictly increasing — a rewritten line is what a repeated or
           rewound sequence number looks like.
       (j) a correction supersedes an earlier line and carries that line's
           decision_id; the envelope may be restated, the decision may not.
       (k) requested_at never falls after the decision's computed_at, so a
           later latency figure cannot come out negative.

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
    from referencing import Registry, Resource
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
    "expected-decision": SCHEMAS_DIR / "rbk.decision.v3.schema.json",
}

# The ledger schema is validated like the others but is not part of a fixture
# scenario triple: a scenario is (policy, request, decision), and the ledger is
# a separate artifact that *records* decisions.
LEDGER_SCHEMA_FILE = SCHEMAS_DIR / "rbk.ledger_entry.v1.schema.json"
LEDGER_FILE = FIXTURES_DIR / "ledger" / "ledger.jsonl"
LEDGER_DIR_NAME = "ledger"

ALL_FACTORS = {
    "applicability",
    "authority",
    "evidence",
    "freshness",
    "risk",
    "reversibility",
}

# The schema-enforcement probes need one decision that is known valid; any
# fixture would do, and this one is the simplest.
FIRST_FIXTURE_FOR_SCHEMA_PROBES = "01-auto-apply"

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


def check_instance(label, instance, schema, registry=None):
    validator = jsonschema.Draft202012Validator(
        schema, **({"registry": registry} if registry is not None else {})
    )
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
            f"outcome={outcome!r} but the routing rule requires {expected!r} "
            f"given factor verdicts {sorted(verdicts)}",
        )
        return False
    ok(label)
    return True


def check_measurement_rule(label, decision):
    """basis_complete is the conjunction over factors, and an incomplete
    verdict always implies a missing basis."""
    factors = decision.get("factors", [])
    problems = []

    for f in factors:
        if f.get("verdict") == "incomplete" and f.get("basis_complete") is not False:
            problems.append(
                f"factor {f.get('factor')!r}: verdict=incomplete but "
                f"basis_complete={f.get('basis_complete')!r}"
            )

    expected = all(f.get("basis_complete") is True for f in factors)
    actual = decision.get("basis_complete")
    if actual != expected:
        short = [f.get("factor") for f in factors if f.get("basis_complete") is not True]
        problems.append(
            f"basis_complete={actual!r} but the factors give {expected!r} "
            f"(factors with a missing basis: {short})"
        )

    if problems:
        fail(label, "; ".join(problems))
        return False
    ok(label)
    return True


def check_two_axis_invariant(label, decision):
    """outcome == incomplete <=> basis_complete is False and nothing is
    human_required (design §3, v0.2). This is the invariant v0.1 violated:
    a human_required factor used to discard a co-occurring incomplete."""
    factors = decision.get("factors", [])
    any_human_required = any(f.get("verdict") == "human_required" for f in factors)
    basis_short = decision.get("basis_complete") is False
    outcome = decision.get("outcome")

    lhs = outcome == "incomplete"
    rhs = basis_short and not any_human_required

    if lhs != rhs:
        fail(
            label,
            f"outcome={outcome!r}, basis_complete={decision.get('basis_complete')!r}, "
            f"any human_required factor={any_human_required} — "
            f"'outcome == incomplete' ({lhs}) must equal "
            f"'basis missing and nothing human_required' ({rhs})",
        )
        return False
    ok(label)
    return True


def check_basis_gap_is_actionable(label, decision):
    """A missing basis must always say what to observe next — whatever the
    routing says. Otherwise the gap is recorded but unactionable."""
    if decision.get("basis_complete") is not False:
        ok(label)
        return True
    modes = decision.get("routing", {}).get("required_evidence_modes", [])
    if not modes:
        fail(label, "basis_complete=false but routing.required_evidence_modes is empty/absent")
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


def check_schema_rejects(label, instance, schema, registry=None):
    """The mirror image of check_instance: the schema must *reject* this."""
    validator = jsonschema.Draft202012Validator(
        schema, **({"registry": registry} if registry is not None else {})
    )
    if next(validator.iter_errors(instance), None) is None:
        fail(label, "the schema accepted an instance it claims to forbid")
        return False
    ok(label)
    return True


def parse_iso(value):
    """Minimal RFC 3339 parse, enough to order two timestamps."""
    from datetime import datetime

    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def check_ledger_invariants(entries):
    """Invariants that live across lines, not within one (checks h–k).

    The per-line contract is the ledger schema's job; these are the ones that
    only exist once the file is read as a sequence.
    """
    ledger_ids = {e.get("ledger_id") for e in entries}
    label = "ledger: one ledger_id for the whole file"
    if len(ledger_ids) > 1:
        fail(label, f"mixed ledger_ids {sorted(str(i) for i in ledger_ids)}")
    else:
        ok(label)

    label = "ledger: seq strictly increasing (append-only)"
    seqs = [e.get("seq") for e in entries]
    if any(b is None or a is None or b <= a for a, b in zip(seqs, seqs[1:])):
        fail(label, f"seq sequence is not strictly increasing: {seqs}")
    else:
        ok(label)

    label = "ledger: a correction supersedes an earlier line, and only its envelope"
    problems = []
    seen = {}
    for e in entries:
        seq = e.get("seq")
        kind = e.get("record_kind")
        supersedes = e.get("supersedes")
        if kind == "correction":
            target = seen.get((supersedes or {}).get("seq"))
            if target is None:
                problems.append(f"seq {seq}: supersedes a line that does not precede it")
            elif target["decision"]["decision_id"] != e["decision"]["decision_id"]:
                problems.append(
                    f"seq {seq}: supersedes seq {supersedes['seq']} but carries a different "
                    f"decision_id — a correction may restate the envelope, never the decision"
                )
        elif supersedes is not None:
            problems.append(f"seq {seq}: record_kind 'decision' must not supersede anything")
        seen[seq] = e
    if problems:
        fail(label, "; ".join(problems))
    else:
        ok(label)

    label = "ledger: requested_at never falls after the decision's computed_at"
    problems = []
    for e in entries:
        if "requested_at" not in e:
            continue
        requested = parse_iso(e["requested_at"])
        decided = parse_iso(e["decision"]["computed_at"])
        if requested is None or decided is None:
            problems.append(f"seq {e.get('seq')}: unparsable timestamp")
        elif requested > decided:
            problems.append(
                f"seq {e.get('seq')}: requested_at {e['requested_at']} is after "
                f"computed_at {e['decision']['computed_at']}"
            )
    if problems:
        fail(label, "; ".join(problems))
    else:
        ok(label)

    label = "ledger: both axes are recorded, neither collapsed into the other"
    problems = []
    for e in entries:
        decision = e.get("decision", {})
        if "outcome" not in decision or "basis_complete" not in decision:
            problems.append(
                f"seq {e.get('seq')}: the entry does not carry both outcome (routing) and "
                f"basis_complete (measurement)"
            )
    if problems:
        fail(label, "; ".join(problems))
    else:
        ok(label)


def check_ledger_schema_claims_are_enforced(entry, schema, registry):
    """The ledger schema says a correction points at what it corrects, and that
    a plain decision replaces nothing. Both are if/then constraints, so probe
    them with instances they must reject."""
    orphan = {k: v for k, v in entry.items() if k != "supersedes"}
    orphan["record_kind"] = "correction"
    check_schema_rejects(
        "schema[ledger_entry] rejects a correction with no supersedes", orphan, schema, registry
    )

    replacing = {**entry, "record_kind": "decision", "supersedes": {"seq": 0, "reason": "x"}}
    check_schema_rejects(
        "schema[ledger_entry] rejects a decision that supersedes a line", replacing, schema, registry
    )

    unreasoned = {**entry, "record_kind": "correction", "supersedes": {"seq": 0}}
    check_schema_rejects(
        "schema[ledger_entry] rejects a correction with no reason", unreasoned, schema, registry
    )


def check_factors_claim_is_enforced(decision, schema):
    """The decision schema says factors carries all six kinds, once each. A
    contract that only says so in a `description` does not say it: until v0.3
    duplicates and seventh entries validated. These checks confirm the schema
    itself now rejects them, so the claim and the constraint cannot drift."""
    factors = decision.get("factors", [])
    if len(factors) != 6:
        fail("schema[decision]: factors enforcement", "sample decision does not carry six factors")
        return

    duplicated = {**decision, "factors": factors[:5] + [dict(factors[0])]}
    check_schema_rejects(
        "schema[decision] rejects a duplicated factor kind", duplicated, schema
    )

    seventh = {**decision, "factors": factors + [dict(factors[0])]}
    check_schema_rejects("schema[decision] rejects a seventh factor", seventh, schema)

    missing = {**decision, "factors": factors[:5]}
    check_schema_rejects("schema[decision] rejects a missing factor", missing, schema)


def main():
    print("== Validating schemas (Draft 2020-12) ==")
    schemas = {}
    for name, path in SCHEMA_FILES.items():
        schemas[name] = check_schema_is_valid_2020_12(name, path)
    schemas["ledger_entry"] = check_schema_is_valid_2020_12("ledger_entry", LEDGER_SCHEMA_FILE)

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
        if name == LEDGER_DIR_NAME:
            continue
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
        check_composition_rule(f"{name}: routing rule (human_required>incomplete>auto_apply)", decision)
        check_measurement_rule(f"{name}: measurement rule (basis_complete = AND over factors)", decision)
        check_two_axis_invariant(f"{name}: outcome==incomplete <=> basis missing and nothing human_required", decision)
        check_basis_gap_is_actionable(f"{name}: a missing basis names what to observe next", decision)
        check_auto_apply_withheld_empty(f"{name}: auto_apply implies no withheld_dimensions", decision)
        if request is not None:
            check_granted_subset_of_requested(f"{name}: granted_dimensions subset of requested_dimensions", decision, request)

        if name == FIRST_FIXTURE_FOR_SCHEMA_PROBES:
            print("\n== Probing the decision schema with instances it must reject ==")
            check_factors_claim_is_enforced(decision, schemas["expected-decision"])

    validate_ledger(schemas)

    print_report()
    sys.exit(1 if FAILURES else 0)


def validate_ledger(schemas):
    print("\n== Validating the ledger (rbk.ledger_entry.v1) ==")
    if not LEDGER_FILE.exists():
        fail("ledger", f"file not found: {LEDGER_FILE}")
        return

    # A ledger entry embeds a whole decision by $ref, so the decision schema has
    # to be resolvable by its $id.
    decision_schema = schemas["expected-decision"]
    registry = Registry().with_resources(
        [(decision_schema["$id"], Resource.from_contents(decision_schema))]
    )
    ledger_schema = schemas["ledger_entry"]

    entries = []
    for lineno, raw in enumerate(LEDGER_FILE.read_text(encoding="utf-8").split("\n"), start=1):
        if not raw.strip():
            continue
        label = f"ledger line {lineno} schema"
        try:
            entry = json.loads(raw)
        except Exception as e:
            fail(label, f"could not parse JSON: {e}")
            continue
        if check_instance(label, entry, ledger_schema, registry):
            entries.append(entry)

    if not entries:
        fail("ledger", "no valid entries to check invariants against")
        return

    check_ledger_invariants(entries)

    print("\n== Probing the ledger schema with instances it must reject ==")
    check_ledger_schema_claims_are_enforced(entries[0], ledger_schema, registry)


def print_report():
    print("\n== Results ==")
    for label in PASSES:
        print(f"PASS  {label}")
    for msg in FAILURES:
        print(f"FAIL  {msg}")
    print(f"\n{len(PASSES)} passed, {len(FAILURES)} failed")


if __name__ == "__main__":
    main()
