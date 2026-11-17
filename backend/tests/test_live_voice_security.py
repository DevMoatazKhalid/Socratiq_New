import json
from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient
from backend.app.main import create_app
from backend.app.auth import CurrentUser
import backend.app.routers.smartboard as sb_module


@pytest.fixture(autouse=True)
def clean_active_users():
    sb_module._active_live_users.clear()
    yield
    sb_module._active_live_users.clear()


def test_live_relay_forbidden_origin():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)

    with pytest.raises(Exception):
        with client.websocket_connect(
            "/api/v1/smartboard/live",
            headers={"Origin": "https://attacker-domain.evil.com"}
        ) as ws:
            pass


def test_live_relay_missing_token_rejected():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)

    with patch.object(sb_module, "_get_gemini_keys", return_value=["test_gemini_key"]):
        with client.websocket_connect("/api/v1/smartboard/live") as ws:
            # Client sends setup message without authentication token
            ws.send_text(json.dumps({
                "setup": {
                    "model": "models/gemini-3.8-live"
                }
            }))
            # Server closes with 1008
            msg = ws.receive()
            assert msg["type"] == "websocket.close"
            assert msg.get("code") == 1008


def test_live_relay_invalid_token_rejected():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)

    with patch.object(sb_module, "_get_gemini_keys", return_value=["test_gemini_key"]):
        with patch.object(sb_module, "_authenticate_token", return_value=None):
            with client.websocket_connect("/api/v1/smartboard/live") as ws:
                ws.send_text(json.dumps({
                    "token": "invalid_forged_token",
                    "setup": {
                        "model": "models/gemini-3.8-live"
                    }
                }))
                msg = ws.receive()
                assert msg["type"] == "websocket.close"
                assert msg.get("code") == 1008


def test_live_relay_concurrent_session_limit():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)

    dummy_user = CurrentUser(
        user_id="std_123",
        auth_user_id="auth_123",
        university_id="uni_123",
        role="STUDENT",
        email="student@uni.edu",
        first_name="Test",
        last_name="Student"
    )

    # Pre-populate active users with MAX_CONCURRENT_LIVE_PER_USER sessions
    sb_module._active_live_users["std_123"] = {MagicMock(), MagicMock()}

    with patch.object(sb_module, "_get_gemini_keys", return_value=["test_gemini_key"]):
        with patch.object(sb_module, "_authenticate_token", return_value=dummy_user):
            with client.websocket_connect("/api/v1/smartboard/live") as ws:
                ws.send_text(json.dumps({
                    "token": "valid_token_student",
                    "setup": {"model": "models/gemini-3.8-live"}
                }))
                msg = ws.receive()
                assert msg["type"] == "websocket.close"
                assert msg.get("code") == 1008


def test_live_relay_payload_size_limit():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)

    with patch.object(sb_module, "_get_gemini_keys", return_value=["test_gemini_key"]):
        with client.websocket_connect("/api/v1/smartboard/live") as ws:
            # Send message larger than 2MB
            oversized_text = "x" * (2 * 1024 * 1024 + 100)
            ws.send_text(oversized_text)
            msg = ws.receive()
            assert msg["type"] == "websocket.close"
            assert msg.get("code") == 1009


def test_server_owned_system_instruction_and_tools():
    # Verify that the server's declared system instruction contains pedagogical guardrails and English policy
    inst = sb_module.SERVER_SMARTBOARD_SYSTEM_INSTRUCTION
    assert "SocratiQ Socratic Coach" in inst
    assert "single pedagogical authority" in inst
    assert "Never write the final direct solution" in inst
    assert "Always speak and respond in ENGLISH by default" in inst or "speak and respond in ENGLISH by default" in inst
    assert "Do NOT speak or respond in Spanish" in inst
    assert "NEVER delete, move, overwrite, or cover content authored by the student" in inst

    # Verify that all 15 whiteboard tools are properly registered on the server
    tool_names = {t["name"] for t in sb_module.SERVER_WHITEBOARD_TOOLS}
    expected_tools = {
        "pan_view", "move_element_at", "delete_element_at",
        "draw_rectangle", "draw_circle", "draw_triangle",
        "draw_line", "draw_arrow", "write_text", "add_equation",
        "search_course_materials", "get_board_context",
        "generate_vector_drawing", "generate_image", "generate_simulation"
    }
    for expected in expected_tools:
        assert expected in tool_names, f"Missing tool: {expected}"
