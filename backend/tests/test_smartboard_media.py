"""Image and simulation generation: real output or an honest error, never a fabricated success."""
from __future__ import annotations

import base64
import io
import logging
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app.auth import CurrentUser, get_current_user
from backend.app.main import create_app
from backend.app.smartboard_media import MediaRejected, extract_simulation_code, validate_image, validate_simulation
from unittest.mock import MagicMock

SB = "/api/v1/smartboard"


def _img(fmt="PNG", size=(32, 24)) -> str:
    buf = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(buf, fmt)
    return base64.b64encode(buf.getvalue()).decode()


# ------------------------------------------------------------------------------------------------------------ image validation
@pytest.mark.parametrize("fmt,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")])
def test_valid_images_are_accepted_and_typed_from_their_bytes(fmt, mime):
    v = validate_image(_img(fmt), "image/png")                 # the provider's claimed type is ignored
    assert v.mime == mime and (v.width, v.height) == (32, 24) and v.data_url.startswith(f"data:{mime};base64,")


@pytest.mark.parametrize("bad", [None, "", "   ", "not base64!!", base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>").decode(),
                                 base64.b64encode(b"GIF89a....").decode(), base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 40).decode()])
def test_invalid_or_malicious_images_are_rejected(bad):
    with pytest.raises(MediaRejected):
        validate_image(bad, "image/png")


def test_oversized_dimensions_and_bytes_are_rejected():
    with pytest.raises(MediaRejected):
        validate_image(_img("PNG", (5000, 10)))
    with pytest.raises(MediaRejected):
        validate_image(_img("PNG", (2, 2)))                  # below the minimum
    with pytest.raises(MediaRejected):
        validate_image("A" * (6 * 1024 * 1024))              # far over the byte cap


def test_declared_unsupported_mime_is_rejected():
    with pytest.raises(MediaRejected):
        validate_image(_img("PNG"), "image/svg+xml")


# ------------------------------------------------------------------------------------------------------------ simulation validation
GOOD = "<div id=a>0</div><button onclick='go()'>go</button><script>function go(){a.textContent=+a.textContent+1}</script>"


def test_good_simulation_passes_and_fences_are_stripped():
    assert validate_simulation(extract_simulation_code("Here you go:\n```html\n" + GOOD + "\n```\nenjoy")) == GOOD
    assert extract_simulation_code("```" + GOOD + "```") == GOOD


@pytest.mark.parametrize("bad,why", [
    ("", "empty"), ("<p>just text</p>", "no script"), ("<script>window.parent.postMessage(1,'*')</script>", "window.parent"),
    ("<script>localStorage.x=1</script>", "localStorage"), ("<iframe src=x></iframe><script>1</script>", "frames"),
    ("<script>" + "a" * 130_000 + "</script>", "too large"), ("<script>document.cookie</script>", "cookie"),
])
def test_unsafe_or_non_interactive_simulations_are_rejected(bad, why):
    with pytest.raises(MediaRejected):
        validate_simulation(bad)


# ------------------------------------------------------------------------------------------------------------ routes
def _client():
    app = create_app(db=MagicMock(), storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    me = CurrentUser(user_id="s1", auth_user_id="a", university_id="u", role="STUDENT", email="s@t.c", first_name="S", last_name="T")
    app.dependency_overrides[get_current_user] = lambda: me
    return TestClient(app)


class _Resp:
    def __init__(self, status=200, body=None):
        self.status_code, self._b, self.text = status, body or {}, ""

    def json(self):
        return self._b


class _FakeHttpx:
    """Stands in for httpx.AsyncClient; records every request so tests can assert how the key is sent."""
    calls: list = []
    plan: list = []

    def __init__(self, *a, **k): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False

    async def post(self, url, json=None, headers=None):
        _FakeHttpx.calls.append((url, headers))
        r = _FakeHttpx.plan.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


@pytest.fixture
def fake(monkeypatch):
    _FakeHttpx.calls, _FakeHttpx.plan = [], []
    monkeypatch.setenv("GEMINI_API_KEY", "TESTKEY-never-log-me")
    monkeypatch.setattr(httpx, "AsyncClient", _FakeHttpx)
    return _FakeHttpx


def _imagen(b64): return _Resp(200, {"predictions": [{"bytesBase64Encoded": b64, "mimeType": "image/png"}]})


def test_generate_image_returns_the_real_validated_image_and_never_puts_the_key_in_the_url(fake, caplog):
    fake.plan = [_imagen(_img("PNG"))]
    with caplog.at_level(logging.DEBUG):
        r = _client().post(f"{SB}/generate-image", json={"prompt": "a red cube"})
    assert r.status_code == 200 and r.json()["imageUrl"].startswith("data:image/png;base64,") and r.json()["width"] == 32
    url, headers = fake.calls[0]
    assert "key=" not in url and "TESTKEY" not in url and headers["x-goog-api-key"] == "TESTKEY-never-log-me"
    assert "TESTKEY" not in caplog.text


def test_generate_image_falls_back_to_the_second_provider_when_the_first_fails(fake):
    inline = {"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/jpeg", "data": _img("JPEG")}}]}}]}
    fake.plan = [_Resp(500), _Resp(200, inline)]
    r = _client().post(f"{SB}/generate-image", json={"prompt": "a tree"})
    assert r.status_code == 200 and r.json()["mimeType"] == "image/jpeg"


def test_generate_image_never_fabricates_a_placeholder_when_providers_fail(fake):
    fake.plan = [_Resp(500), _Resp(429)]
    r = _client().post(f"{SB}/generate-image", json={"prompt": "<script>alert(1)</script> & co"})
    assert r.status_code == 502 and "imageUrl" not in r.text and "svg" not in r.text.lower()


def test_generate_image_reports_a_timeout_as_504(fake):
    fake.plan = [httpx.ReadTimeout("slow"), httpx.ReadTimeout("slow")]
    assert _client().post(f"{SB}/generate-image", json={"prompt": "a tree"}).status_code == 504


def test_generate_image_rejects_a_malicious_provider_payload(fake):
    evil = base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>").decode()
    fake.plan = [_imagen(evil), _Resp(200, {"candidates": []})]
    r = _client().post(f"{SB}/generate-image", json={"prompt": "x"})
    assert r.status_code == 502 and "imageUrl" not in r.text


@pytest.mark.parametrize("prompt", ["", "   ", "x" * 801])
def test_generate_image_validates_the_prompt(fake, prompt):
    assert _client().post(f"{SB}/generate-image", json={"prompt": prompt}).status_code == 422
    assert fake.calls == []                                   # nothing was sent to the provider


def _gem(text): return _Resp(200, {"candidates": [{"content": {"parts": [{"text": text}]}}]})


def test_generate_simulation_returns_validated_code(fake):
    fake.plan = [_gem("```html\n" + GOOD + "\n```")]
    r = _client().post(f"{SB}/generate-simulation", json={"prompt": "pendulum"})
    assert r.status_code == 200 and r.json()["code"] == GOOD
    assert "TESTKEY" not in fake.calls[0][0] and fake.calls[0][1]["x-goog-api-key"]


@pytest.mark.parametrize("model_text", ["<p>static</p>", "<script>window.parent.x=1</script>", ""])
def test_generate_simulation_refuses_unsafe_or_static_output(fake, model_text):
    fake.plan = [_gem(model_text)]
    r = _client().post(f"{SB}/generate-simulation", json={"prompt": "pendulum"})
    assert r.status_code == 502 and "code" not in r.json()


def test_generate_simulation_validates_the_prompt(fake):
    assert _client().post(f"{SB}/generate-simulation", json={"prompt": " "}).status_code == 422
    assert _client().post(f"{SB}/generate-simulation", json={"prompt": "x" * 1001}).status_code == 422


# ------------------------------------------------------------------------------------------------------------ vector drawings
from backend.app.smartboard_media import validate_vector  # noqa: E402


def test_valid_shapes_are_kept_and_normalised():
    out = validate_vector({"elements": [
        {"type": "rect", "x": 0, "y": 0, "width": 100, "height": 80, "color": "#2563eb", "filled": True},
        {"type": "circle", "x": 50, "y": 50, "radius": 40},
        {"type": "line", "x1": 0, "y1": 0, "x2": 100, "y2": 100, "strokeWidth": 3},
        {"type": "path", "pathData": "M 0 0 L 50 50 Z", "color": "red"},
    ]})
    assert [e["type"] for e in out] == ["rect", "circle", "line", "path"] and out[0]["filled"] is True and out[2]["strokeWidth"] == 3


@pytest.mark.parametrize("bad", [None, [], {}, {"elements": "x"}, {"elements": []}, {"elements": [{"type": "script", "x": 1}]},
                                 {"elements": [{"type": "rect", "x": 1e9, "y": 0, "width": 1, "height": 1}]},
                                 {"elements": [{"type": "rect", "x": float("nan"), "y": 0, "width": 1, "height": 1}]},
                                 {"elements": [{"type": "circle", "x": 0, "y": 0, "radius": -5}]},
                                 {"elements": [{"type": "path", "pathData": "M0 0 <script>alert(1)</script>"}]}])
def test_malformed_vector_output_is_an_error_not_an_empty_success(bad):
    with pytest.raises(MediaRejected):
        validate_vector(bad)


def test_unsafe_color_is_neutralised_and_the_list_is_bounded():
    out = validate_vector({"elements": [{"type": "circle", "x": 0, "y": 0, "radius": 5, "color": "red;background:url(http://x)"}] + [{"type": "circle", "x": 0, "y": 0, "radius": 1}] * 500})
    assert out[0]["color"] == "#000000" and len(out) == 200


def test_generate_vector_route_returns_validated_shapes_or_an_error(fake):
    good = '{"elements":[{"type":"rect","x":0,"y":0,"width":10,"height":10},{"type":"nope"}]}'
    fake.plan = [_gem(good)]
    r = _client().post(f"{SB}/generate-vector", json={"prompt": "a house"})
    assert r.status_code == 200 and len(r.json()["elements"]) == 1
    fake.plan = [_gem("not json at all")]
    assert _client().post(f"{SB}/generate-vector", json={"prompt": "a house"}).status_code == 502
    fake.plan = [_gem('{"elements": []}')]
    assert _client().post(f"{SB}/generate-vector", json={"prompt": "a house"}).status_code == 502


# ------------------------------------------------------------------------------------------------------------ static "simulations" are not simulations
@pytest.mark.parametrize("static", [
    "<div>pendulum</div><script>1</script>",
    "<canvas id=c></canvas><script>document.getElementById('c').getContext('2d').fillRect(0,0,9,9)</script>",
])
def test_script_that_neither_animates_nor_listens_is_rejected_not_reported_as_success(static):
    with pytest.raises(MediaRejected, match="does not animate"):
        validate_simulation(static)


@pytest.mark.parametrize("dynamic", [
    "<script>requestAnimationFrame(function f(){requestAnimationFrame(f)})</script>",
    "<script>setInterval(function(){},16)</script>",
    "<input id=s type=range><script>s.addEventListener('input',function(){})</script>",
    "<button onclick='go()'>go</button><script>function go(){}</script>",
])
def test_animation_or_input_hooks_are_accepted(dynamic):
    assert validate_simulation(dynamic) == dynamic
