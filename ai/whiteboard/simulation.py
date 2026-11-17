"""Rules for AI-generated simulation code, shared by the generation route and the scene validator.

A simulation is untrusted, model-written HTML/JS that the browser runs inside a sandboxed iframe (opaque origin, no network, see
frontend/src/lib/smartboard/simulationDoc.ts). The deny-list here is DEFENCE IN DEPTH and a way to give the user a clear message; it is not
the security boundary (the iframe sandbox + CSP are) and it is trivially bypassable by string concatenation.

Two different questions are answered separately on purpose:
  * `blocked_reasons`  - is this code allowed to be stored/run at all?  (security + size; also enforced when a saved board is validated)
  * `has_dynamic_behavior` - does it look like a simulation rather than a static picture? (a generation-time quality gate only; it must never
    be used to reject a board that was already saved, or a heuristic could brick a student's work)

The frontend keeps a mirror of the deny-list in `simulationDoc.ts`; backend/tests/test_simulation_parity.py fails if the two drift apart.
"""
from __future__ import annotations

import re

MAX_SIM_CHARS = 120_000

BLOCKED_SIM_PATTERNS: tuple[tuple[re.Pattern, str], ...] = tuple((re.compile(p, re.I), label) for p, label in (
    (r"window\s*\.\s*parent", "window.parent access"),
    (r"window\s*\.\s*top", "window.top access"),
    (r"parent\s*\.\s*postMessage", "parent.postMessage"),
    (r"document\s*\.\s*cookie", "document.cookie access"),
    (r"localStorage", "localStorage access"),
    (r"sessionStorage", "sessionStorage access"),
    (r"indexedDB", "indexedDB access"),
    (r"<meta\s+http-equiv\s*=\s*[\"']?refresh", "meta refresh redirect"),
    (r"<base\s", "base tag injection"),
    (r"window\s*\.\s*opener", "window.opener access"),
    (r"navigator\s*\.\s*sendBeacon", "sendBeacon exfiltration"),
    (r"<iframe", "nested frames"),
    (r"<object|<embed", "embedded objects"),
))

_HAS_SCRIPT = re.compile(r"<script[\s>]", re.I)
_DYNAMIC = re.compile(
    r"requestAnimationFrame|setInterval|setTimeout|addEventListener|\bon(?:click|input|change|pointer\w*|mouse\w*|key\w*|touch\w*)\s*=",
    re.I,
)


def has_script(code: str) -> bool:
    return bool(_HAS_SCRIPT.search(code))


def has_dynamic_behavior(code: str) -> bool:
    """True when the code schedules animation or listens for input: the minimum for it to be a simulation and not an illustration."""
    return bool(_DYNAMIC.search(code))


def blocked_reasons(code: object) -> list[str]:
    """Why `code` may not be stored or run. Empty list means allowed. Non-strings and oversized code are reported, never raised."""
    if not isinstance(code, str):
        return ["invalid code"]
    reasons: list[str] = []
    if len(code) > MAX_SIM_CHARS:
        reasons.append("code too large")
    reasons.extend(label for pat, label in BLOCKED_SIM_PATTERNS if pat.search(code))
    return reasons
