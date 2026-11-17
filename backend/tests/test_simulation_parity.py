"""The browser keeps a mirror of the server's simulation deny-list. If the two drift, the server would accept code the browser refuses to run (or the reverse)."""
import re
from pathlib import Path

from ai.whiteboard.simulation import BLOCKED_SIM_PATTERNS, MAX_SIM_CHARS

TS = Path(__file__).resolve().parents[2] / "frontend/src/lib/smartboard/simulationDoc.ts"


def _ts_patterns():
    src = TS.read_text(encoding="utf-8")
    return re.findall(r'pattern:\s*/(.+?)/i,\s*label:\s*"(.+?)"', src)


def test_frontend_and_backend_deny_lists_are_identical():
    ts = [(p, l) for p, l in _ts_patterns()]
    py = [(p.pattern.replace('\\"', '"'), l) for p, l in BLOCKED_SIM_PATTERNS]
    assert len(ts) == len(py) >= 10
    assert ts == py


def test_size_cap_is_identical():
    m = re.search(r"MAX_SIMULATION_CHARS\s*=\s*([\d_]+)", TS.read_text(encoding="utf-8"))
    assert int(m.group(1).replace("_", "")) == MAX_SIM_CHARS
