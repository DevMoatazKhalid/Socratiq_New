"""HTTP contract of the visual assistant: /smartboard/image (JSON and Server-Sent Events), /smartboard/image/candidate, and the
`mode` switch on /generate-image. The providers are scripted; the logic itself is covered in test_visual_assistant.py."""
from __future__ import annotations

import base64
import io
import json
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import image_search as S
from backend.app import visual_assistant as V
from backend.app.auth import CurrentUser, get_current_user
from backend.app.main import create_app

SB = "/api/v1/smartboard"


def _png(size=(64, 48)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (30, 140, 120)).save(buf, "PNG")
    return buf.getvalue()


class _R:
    def __init__(self, status=200, body=None, content=b""):
        self.status_code, self._b, self.content, self.text = status, body, content, ""
        self.headers = {"content-type": "image/png"} if content else {}

    def json(self):
        return self._b


def _text(obj):
    return _R(200, {"candidates": [{"content": {"parts": [{"text": json.dumps(obj)}]}}]})


INTENT = {"subject": "red fox", "category": "organism", "strategy": "search", "confidence": 0.9, "reason": "A real animal.", "wants": "photo",
          "queries": ["red fox"], "must_show": [], "avoid": [], "real_person": False, "authenticity": True}
JUDGE = {"results": [{"index": 1, "relevance": 9, "accuracy": 9, "educational": 9, "quality": 8, "shows_subject": True, "misleading": False,
                      "inappropriate": False, "kind": "photo", "caption": "A red fox", "issue": ""}]}
PAGES = {"query": {"pages": {"1": {"title": "File:Red_fox.jpg", "index": 1, "imageinfo": [{
    "url": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Red_fox.jpg",
    "thumburl": "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Red_fox.jpg/1280px-Red_fox.jpg",
    "descriptionurl": "https://commons.wikimedia.org/wiki/File:Red_fox.jpg", "mime": "image/jpeg", "width": 2400, "height": 1600,
    "extmetadata": {"LicenseShortName": {"value": "CC BY-SA 4.0"}, "Artist": {"value": "Jane Doe"}}}]}}}}


class _FakeHttpx:
    calls: list = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def _route(self, method, url, body):
        _FakeHttpx.calls.append((method, url))
        if ":generateContent" in url:
            parts = (body or {}).get("contents", [{}])[0].get("parts", [])
            if any("inlineData" in p for p in parts):
                return _text(JUDGE)
            return _text(INTENT)
        if ":predict" in url:
            return _R(200, {"predictions": [{"bytesBase64Encoded": base64.b64encode(_png()).decode(), "mimeType": "image/png"}]})
        if "commons.wikimedia.org/w/api.php" in url:
            return _R(200, PAGES)
        if "upload.wikimedia.org" in url:
            return _R(200, content=_png((1280, 853) if "1280px" in url else (500, 333)))
        return _R(404, {})

    async def post(self, url, json=None, headers=None):
        return self._route("POST", url, json)

    async def get(self, url, headers=None, **kw):
        return self._route("GET", url, None)


@pytest.fixture
def fake(monkeypatch):
    _FakeHttpx.calls = []
    S.clear_caches()
    V.INTENT_CACHE.clear()
    monkeypatch.setenv("GEMINI_API_KEY", "TESTKEY")
    monkeypatch.setenv("SMARTBOARD_IMAGE_SEARCH_PROVIDERS", "commons")
    monkeypatch.setenv("SMARTBOARD_IMAGE_MODELS", "imagen-4.0-generate-001")
    monkeypatch.setenv("SMARTBOARD_IMAGE_PLANNER", "1")
    monkeypatch.setenv("BOARD_SIGNING_SECRET", "test-secret-for-candidates")
    monkeypatch.setattr(httpx, "AsyncClient", _FakeHttpx)
    return _FakeHttpx


def _client(user_id="s1"):
    app = create_app(db=MagicMock(), storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    me = CurrentUser(user_id=user_id, auth_user_id="a", university_id="u", role="TEACHER", email="t@t.c", first_name="T", last_name="T")
    app.dependency_overrides[get_current_user] = lambda: me
    return TestClient(app)


def test_json_request_returns_a_retrieved_image_with_attribution_and_signed_alternatives(fake):
    r = _client().post(f"{SB}/image", json={"prompt": "show me a red fox"})
    body = r.json()
    assert r.status_code == 200 and body["status"] == "ok" and body["source"] == "retrieved" and body["ai_generated"] is False
    assert body["imageUrl"].startswith("data:image/") and body["attribution"]["license"] == "CC BY-SA 4.0"
    assert body["candidates"][0]["token"] and body["decision"]["searched"] is True
    assert not any(":predict" in u for _, u in fake.calls)                       # nothing was generated
    assert all("TESTKEY" not in u for _, u in fake.calls)


def test_streamed_request_reports_the_real_stages_then_the_result(fake):
    r = _client().post(f"{SB}/image", json={"prompt": "show me a red fox"}, headers={"Accept": "text/event-stream"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = [(b.split("\n")[0][7:], json.loads(b.split("\n")[1][6:])) for b in r.text.strip().split("\n\n") if b.startswith("event: ")]
    stages = [d["stage"] for e, d in events if e == "stage"]
    assert stages[:3] == ["understanding", "searching", "evaluating"] and events[-1][0] == "final"
    assert events[-1][1]["source"] == "retrieved"


def test_generate_mode_skips_the_search(fake):
    r = _client().post(f"{SB}/image", json={"prompt": "a red fox", "mode": "generate"})
    assert r.status_code == 200 and r.json()["source"] == "generated" and r.json()["ai_generated"] is True
    assert not any("commons.wikimedia.org/w/api.php" in u for _, u in fake.calls)


@pytest.mark.parametrize("field,value", [("mode", "magic"), ("prompt", ""), ("exclude", ["x"] * 41)])
def test_invalid_requests_are_rejected(fake, field, value):
    assert _client().post(f"{SB}/image", json={"prompt": "a fox", field: value}).status_code == 422


def test_choosing_another_result_needs_a_valid_token_for_this_user(fake):
    body = _client().post(f"{SB}/image", json={"prompt": "show me a red fox"}).json()
    tok = body["candidates"][0]["token"]
    ok = _client().post(f"{SB}/image/candidate", json={"token": tok})
    assert ok.status_code == 200 and ok.json()["source"] == "retrieved" and ok.json()["attribution"]["author"] == "Jane Doe"
    assert _client(user_id="someone-else").post(f"{SB}/image/candidate", json={"token": tok}).status_code == 422
    assert _client().post(f"{SB}/image/candidate", json={"token": tok[:-3] + "AAA"}).status_code == 422


def test_generate_image_keeps_its_behaviour_and_can_route_through_the_assistant(fake):
    gen = _client().post(f"{SB}/generate-image", json={"prompt": "a red fox"})
    assert gen.status_code == 200 and gen.json()["source"] == "generated"
    auto = _client().post(f"{SB}/generate-image", json={"prompt": "a red fox", "mode": "auto"})
    assert auto.status_code == 200 and auto.json()["source"] == "retrieved"
