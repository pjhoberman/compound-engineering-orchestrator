#!/usr/bin/env python3
"""Circuit breaker for orch-fanout: halt a fan-out run after K consecutive failures.

orch-fanout drives waves of /lfg runs. A systematic problem — a bad base commit, a broken
test harness, an environment fault — tends to fail every wave, burning the whole run instead
of one node. This breaker is the policy the executor consults after each wave: it counts the
trailing run of consecutive failures and trips (halt + escalate) once it reaches the
threshold, so a doomed run stops early and the recovery manifest preserves where to resume.

Usage:
    python3 circuit_breaker.py --outcomes <outcomes.json> [--threshold N]

`outcomes.json` is a JSON array of "pass"/"fail" strings in wave order (the executor's running
record). A pass resets the streak. Emits {tripped, consecutive_failures, threshold, reason}.
Exit 0, 2 on usage error.
"""
import argparse
import json
import sys

DEFAULT_THRESHOLD = 3
VALID_OUTCOMES = {"pass", "fail"}


def fail(msg):
    sys.stderr.write(f"circuit_breaker.py: {msg}\n")
    sys.exit(2)


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read {path}: {exc}")


def evaluate(outcomes, threshold):
    """Trip when the trailing run of consecutive failures reaches the threshold.

    The executor consults after each wave with its running outcome list, so only the current
    trailing streak matters — a pass resets it, and the function re-derives the streak from the
    full list each call (it holds no state between calls; the executor owns accumulation).
    Validates its input and exits 2 via fail() on a malformed list, so it is not side-effect-free.
    """
    if not isinstance(outcomes, list):
        fail("outcomes must be a JSON array of 'pass'/'fail' strings")
    consecutive = 0
    for outcome in outcomes:
        if outcome not in VALID_OUTCOMES:
            fail(f"outcome {outcome!r} is not 'pass' or 'fail'")
        consecutive = consecutive + 1 if outcome == "fail" else 0
    tripped = consecutive >= threshold
    reason = (
        f"{consecutive} consecutive failures >= threshold {threshold} — halt and escalate"
        if tripped
        else f"{consecutive} consecutive failure(s); threshold {threshold} not reached"
    )
    return {
        "tripped": tripped,
        "consecutive_failures": consecutive,
        "threshold": threshold,
        "reason": reason,
    }


def main(argv):
    parser = argparse.ArgumentParser(description="Trip after K consecutive fan-out failures.")
    parser.add_argument("--outcomes", required=True, help="JSON array of 'pass'/'fail' in wave order")
    parser.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD,
                        help=f"consecutive failures that trip the breaker (default {DEFAULT_THRESHOLD})")
    args = parser.parse_args(argv[1:])  # argparse exits 2 on usage error
    if args.threshold < 1:
        fail("--threshold must be >= 1")
    print(json.dumps(evaluate(load(args.outcomes), args.threshold), indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv)
