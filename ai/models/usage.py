"""
LLM usage metering: how many model calls a Coach turn made, per role, with token counts and latency.

Before this, nothing in the platform recorded token usage, so cost and latency claims could not be checked. The meter is opt-in and
fail-safe: `metered()` opens a meter for the current context (one Coach turn, one verification), `get_structured_llm` attaches
`UsageCallback` to every model it builds, and the callback adds to whichever meter is open. No meter open -> nothing is recorded; a
provider that reports no usage -> the call is still counted, with tokens unknown. A metering failure never affects the call itself.
"""
from __future__ import annotations

import contextlib
import contextvars
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional
from uuid import UUID

try:  # langchain_core is a hard dependency of the AI package; the guard keeps this module importable in isolation
    from langchain_core.callbacks import BaseCallbackHandler
except Exception:  # pragma: no cover
    BaseCallbackHandler = object  # type: ignore[misc,assignment]


@dataclass
class _RoleUsage:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    tokens_unknown: int = 0          # calls whose provider reported no usage
    errors: int = 0
    latency_ms: float = 0.0


@dataclass
class UsageMeter:
    roles: dict[str, _RoleUsage] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, role: str, *, input_tokens: Optional[int], output_tokens: Optional[int], latency_ms: float, error: bool = False) -> None:
        with self._lock:
            r = self.roles.setdefault(role, _RoleUsage())
            r.calls += 1
            r.latency_ms += latency_ms
            if error:
                r.errors += 1
            if input_tokens is None and output_tokens is None:
                r.tokens_unknown += 1
            else:
                r.input_tokens += int(input_tokens or 0)
                r.output_tokens += int(output_tokens or 0)

    def summary(self) -> dict[str, Any]:
        with self._lock:
            roles = {k: {"calls": v.calls, "input_tokens": v.input_tokens, "output_tokens": v.output_tokens,
                         "tokens_unknown": v.tokens_unknown, "errors": v.errors, "latency_ms": round(v.latency_ms, 1)}
                     for k, v in self.roles.items()}
        return {
            "llm_calls": sum(r["calls"] for r in roles.values()),
            "input_tokens": sum(r["input_tokens"] for r in roles.values()),
            "output_tokens": sum(r["output_tokens"] for r in roles.values()),
            "calls_without_usage": sum(r["tokens_unknown"] for r in roles.values()),
            "by_role": roles,
        }


_current: contextvars.ContextVar[Optional[UsageMeter]] = contextvars.ContextVar("socratiq_llm_usage", default=None)


@contextlib.contextmanager
def metered(meter: Optional[UsageMeter] = None) -> Iterator[UsageMeter]:
    meter = meter or UsageMeter()
    token = _current.set(meter)
    try:
        yield meter
    finally:
        _current.reset(token)


def current_meter() -> Optional[UsageMeter]:
    return _current.get()


def _usage_from(response: Any) -> tuple[Optional[int], Optional[int]]:
    """Token counts from an LLMResult, whichever shape the provider integration used."""
    try:
        for gens in getattr(response, "generations", None) or []:
            for g in gens or []:
                um = getattr(getattr(g, "message", None), "usage_metadata", None)
                if um:
                    return um.get("input_tokens"), um.get("output_tokens")
        out = getattr(response, "llm_output", None) or {}
        tu = out.get("token_usage") or out.get("usage") or {}
        if tu:
            return tu.get("prompt_tokens", tu.get("input_tokens")), tu.get("completion_tokens", tu.get("output_tokens"))
    except Exception:
        pass
    return None, None


class UsageCallback(BaseCallbackHandler):  # type: ignore[misc,valid-type]
    """Attached to every structured model (see ai.models.llm). Records into the meter that was open when the call STARTED, so a call that
    runs on a worker thread still lands on the right turn. Also counts fallbacks: each model attempt is its own call."""

    raise_error = False

    def __init__(self, role: str):
        self.role = role
        self._starts: dict[UUID, tuple[float, Optional[UsageMeter]]] = {}

    def _start(self, run_id: UUID) -> None:
        self._starts[run_id] = (time.monotonic(), _current.get())

    def on_chat_model_start(self, serialized, messages, *, run_id: UUID, **kwargs):  # noqa: D401
        self._start(run_id)

    def on_llm_start(self, serialized, prompts, *, run_id: UUID, **kwargs):
        self._start(run_id)

    def _finish(self, run_id: UUID, response: Any = None, error: bool = False) -> None:
        started, meter = self._starts.pop(run_id, (None, None))
        meter = meter or _current.get()
        if meter is None:
            return
        latency = (time.monotonic() - started) * 1000 if started else 0.0
        inp, out = _usage_from(response) if response is not None else (None, None)
        meter.add(self.role, input_tokens=inp, output_tokens=out, latency_ms=latency, error=error)

    def on_llm_end(self, response, *, run_id: UUID, **kwargs):
        try:
            self._finish(run_id, response)
        except Exception:
            pass

    def on_llm_error(self, error, *, run_id: UUID, **kwargs):
        try:
            self._finish(run_id, None, error=True)
        except Exception:
            pass
