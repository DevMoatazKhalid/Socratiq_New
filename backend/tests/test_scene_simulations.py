"""Simulations on the native board: where their source lives, what the server accepts, and that a save can no longer be bricked by one.

Regression for the persistence root cause: the simulation card used to carry its whole source in `customData`, which is capped at 4000
characters; any real simulation exceeded that and `sanitize_scene` rejected the ENTIRE scene (HTTP 422), so autosave stopped for the board.
"""
import pytest
from pydantic import ValidationError

from ai.whiteboard.scene import MAX_SIMULATIONS, SceneError, sanitize_scene
from backend.app.schemas import WhiteboardIn

DYNAMIC = "<canvas id=c></canvas><script>function f(){requestAnimationFrame(f)}f()</script>"


def _scene(sims=None, ref="s1", inline=None, extra=None):
    cd = {"socratiq": {"author": "ai", "role": "simulation"}}
    if ref:
        cd["simulationRef"] = {"id": ref, "title": "Pendulum"}
    if inline:
        cd["simulation"] = inline
    els = [{"id": "card", "type": "rectangle", "x": 0, "y": 0, "width": 520, "height": 420, "groupIds": [], "customData": cd},
           {"id": "other", "type": "rectangle", "x": 600, "y": 0, "width": 40, "height": 40}] + (extra or [])
    s = {"type": "excalidraw", "version": 2, "appState": {}, "files": {}, "elements": els}
    if sims is not None:
        s["simulations"] = sims
    return s


def _rec(code=DYNAMIC, sid="s1"):
    return {sid: {"id": sid, "title": "Pendulum", "code": code}}


def test_realistic_sized_simulation_is_accepted_and_survives_unchanged():
    code = DYNAMIC + "<!--" + "x" * 60_000 + "-->"
    out = sanitize_scene(_scene(_rec(code)))
    assert out["simulations"]["s1"]["code"] == code
    assert {e["id"] for e in out["elements"]} == {"card", "other"}          # the rest of the board is untouched


def test_the_old_inline_form_is_still_cap_limited_and_still_valid_when_small():
    assert sanitize_scene(_scene(ref=None, inline={"id": "s1", "title": "t", "code": "<script>1</script>"}))   # existing small boards keep loading
    with pytest.raises(SceneError, match="oversized custom data"):
        sanitize_scene(_scene(ref=None, inline={"id": "s1", "title": "t", "code": "x" * 6000}))          # the cap is unchanged for everything else


def test_unreferenced_simulation_records_are_not_stored():
    out = sanitize_scene(_scene({**_rec(), **_rec(sid="orphan")}))
    assert list(out["simulations"]) == ["s1"]
    assert "simulations" not in sanitize_scene(_scene({"orphan": {"id": "orphan", "title": "", "code": DYNAMIC}}, ref=None))


@pytest.mark.parametrize("code,fragment", [
    ("<script>window.parent.x</script>", "window.parent"),
    ("<script>localStorage.a=1</script>", "localStorage"),
    ("<iframe src=x></iframe>", "nested frames"),
    ("x" * 130_000, "too large"),
])
def test_unsafe_or_oversized_simulation_code_is_refused_on_the_server_even_if_the_client_skipped_checks(code, fragment):
    with pytest.raises(SceneError, match=fragment):
        sanitize_scene(_scene(_rec(code)))


@pytest.mark.parametrize("bad", [
    {"../x": {"id": "../x", "title": "", "code": DYNAMIC}},
    {"s1": "not an object"},
    {"s1": {"id": "other-id", "title": "", "code": DYNAMIC}},               # key and id must agree
    {"s1": {"id": "s1", "title": "t" * 300, "code": DYNAMIC}},
    {"s1": {"id": "s1", "title": "", "code": "   "}},
    {"s1": {"id": "s1", "title": "", "code": 42}},
])
def test_malformed_records_are_rejected(bad):
    with pytest.raises(SceneError):
        sanitize_scene(_scene(bad, ref=next(iter(bad))))


def test_count_and_total_size_are_bounded():
    many = {f"s{i}": {"id": f"s{i}", "title": "", "code": DYNAMIC} for i in range(MAX_SIMULATIONS + 1)}
    with pytest.raises(SceneError, match="at most"):
        sanitize_scene(_scene(many))
    big = "<script>requestAnimationFrame(f)</script>" + "x" * 100_000
    sims, extra = {}, []
    for i in range(7):                                                      # 7 x ~100k > 600k total
        sims[f"b{i}"] = {"id": f"b{i}", "title": "", "code": big}
        extra.append({"id": f"c{i}", "type": "rectangle", "x": i * 10, "y": 0, "width": 5, "height": 5, "groupIds": [],
                      "customData": {"simulationRef": {"id": f"b{i}"}}})
    with pytest.raises(SceneError, match="too large"):
        sanitize_scene(_scene(sims, ref=None, extra=extra))


def test_save_payload_with_a_real_simulation_passes_the_api_schema_not_422():
    """The route validates through WhiteboardIn; this is the exact path that used to reject the whole board."""
    body = WhiteboardIn(scene=_scene(_rec(DYNAMIC + "<!--" + "x" * 20_000 + "-->")))
    assert body.scene["simulations"]["s1"]["id"] == "s1"
    with pytest.raises(ValidationError):
        WhiteboardIn(scene=_scene(_rec("<script>document.cookie</script>")))


def test_embeddable_elements_are_still_dropped_no_security_regression():
    out = sanitize_scene(_scene(_rec(), extra=[{"id": "e", "type": "embeddable", "x": 0, "y": 0, "width": 9, "height": 9, "link": "https://evil.example"}]))
    assert "e" not in {e["id"] for e in out["elements"]}
