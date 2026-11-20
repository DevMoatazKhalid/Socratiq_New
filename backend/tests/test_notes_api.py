"""Student notes API against the real migrated database: CRUD, safe retries, duplicate prevention, concurrent edits and ownership isolation."""
from __future__ import annotations

import concurrent.futures as cf
import uuid

import pytest

from .helpers import API

N = f"{API}/student/notes"


def nid() -> str:
    return "note_" + uuid.uuid4().hex


def create(w, who="S1", **body):
    body.setdefault("id", nid())
    return w.client.post(N, json=body, headers=w.h(who))


# ------------------------------------------------------------------ CRUD
def test_create_read_update_list_delete(world):
    r = create(world, title="Gradient descent", content="**step** = lr * grad\n\n```py\nx -= lr * g\n```\n")
    assert r.status_code == 201
    note = r.json()
    assert note["version"] == 1 and note["title"] == "Gradient descent" and note["content"].endswith("```\n")     # text kept byte-for-byte
    got = world.client.get(f"{N}/{note['id']}", headers=world.h("S1")).json()
    assert got == note
    up = world.client.patch(f"{N}/{note['id']}", json={"base_version": 1, "content": "updated"}, headers=world.h("S1"))
    assert up.status_code == 200 and up.json()["version"] == 2 and up.json()["content"] == "updated" and up.json()["title"] == "Gradient descent"
    lst = world.client.get(N, headers=world.h("S1")).json()["notes"]
    assert [n["id"] for n in lst] == [note["id"]] and lst[0]["preview"] == "updated" and "content" not in lst[0]
    assert world.client.delete(f"{N}/{note['id']}", headers=world.h("S1")).status_code == 204
    assert world.client.get(f"{N}/{note['id']}", headers=world.h("S1")).status_code == 404
    assert world.client.delete(f"{N}/{note['id']}", headers=world.h("S1")).status_code == 404      # a retried delete: already gone


def test_notes_are_not_tied_to_a_course_and_persist_across_sessions(world):
    a = create(world, title="anywhere").json()
    # a "new session": a fresh client and a fresh request with the same identity sees the stored note (nothing lives in the browser)
    from fastapi.testclient import TestClient
    fresh = TestClient(world.app, raise_server_exceptions=False)
    assert fresh.get(f"{N}/{a['id']}", headers=world.h("S1")).json()["title"] == "anywhere"
    assert world.q("select student_id, university_id from student_notes where note_id=%s", a["id"]) == [{"student_id": "S1", "university_id": "U1"}]


def test_list_is_newest_first_and_search_filters_title_and_text(world):
    ids = [create(world, title=t, content=c).json()["id"] for t, c in (("Loops", "for i in range"), ("Recursion", "base case"), ("Misc", "100% sure_thing"))]
    titles = [n["title"] for n in world.client.get(N, headers=world.h("S1")).json()["notes"]]
    assert titles == ["Misc", "Recursion", "Loops"]
    s = lambda q: [n["title"] for n in world.client.get(N, params={"q": q}, headers=world.h("S1")).json()["notes"]]   # noqa: E731
    assert s("recur") == ["Recursion"] and s("RANGE") == ["Loops"]
    assert s("%") == ["Misc"] and s("_") == ["Misc"] and s("nothing-matches") == []                 # LIKE wildcards are literal
    assert len(ids) == 3


def test_validation(world):
    assert create(world, id="note_123").status_code == 422
    assert create(world, title="x" * 201).status_code == 422
    assert create(world, content="x" * 100_001).status_code == 422
    assert create(world, student_id="S2").status_code == 422                         # identity never comes from the body
    assert create(world, source_kind="coach_message").status_code == 422             # kind without ref
    n = create(world).json()
    assert world.client.patch(f"{N}/{n['id']}", json={"base_version": 1}, headers=world.h("S1")).status_code == 422
    assert world.client.get(f"{N}/not-a-note-id", headers=world.h("S1")).status_code == 404


# ------------------------------------------------------------------ safe retries / duplicates / concurrency
def test_retried_create_never_makes_a_second_note(world):
    body = {"id": nid(), "title": "t", "content": "c"}
    first = world.client.post(N, json=body, headers=world.h("S1"))
    again = world.client.post(N, json=body, headers=world.h("S1"))
    assert first.status_code == 201 and again.status_code == 200 and again.json()["id"] == first.json()["id"]
    assert world.q("select count(*) n from student_notes")[0]["n"] == 1


def test_concurrent_creates_with_the_same_id_make_one_note(world):
    body = {"id": nid(), "title": "race"}
    with cf.ThreadPoolExecutor(6) as ex:
        codes = sorted(r.status_code for r in ex.map(lambda _: world.client.post(N, json=body, headers=world.h("S1")), range(6)))
    assert codes.count(201) == 1 and set(codes) <= {200, 201}
    assert world.q("select count(*) n from student_notes")[0]["n"] == 1


def test_saving_the_same_coach_reply_twice_returns_the_existing_note(world):
    a = create(world, title="from coach", content="x", source_kind="coach_message", source_ref="I_1")
    b = create(world, title="from coach", content="x", source_kind="coach_message", source_ref="I_1")
    assert a.status_code == 201 and b.status_code == 200 and b.json()["duplicate"] is True and b.json()["id"] == a.json()["id"]
    c = create(world, "S2", title="from coach", content="x", source_kind="coach_message", source_ref="I_1")   # another student: their own copy
    assert c.status_code == 201
    assert world.q("select count(*) n from student_notes")[0]["n"] == 2


def test_lost_response_retry_of_an_update_is_answered_as_saved(world):
    n = create(world, content="v1").json()
    first = world.client.patch(f"{N}/{n['id']}", json={"base_version": 1, "content": "v2"}, headers=world.h("S1"))
    retry = world.client.patch(f"{N}/{n['id']}", json={"base_version": 1, "content": "v2"}, headers=world.h("S1"))   # same save, resent
    assert first.status_code == retry.status_code == 200 and retry.json()["version"] == 2


def test_a_different_edit_based_on_an_old_version_is_a_conflict_not_an_overwrite(world):
    n = create(world, content="base").json()
    assert world.client.patch(f"{N}/{n['id']}", json={"base_version": 1, "content": "tab A"}, headers=world.h("S1")).status_code == 200
    stale = world.client.patch(f"{N}/{n['id']}", json={"base_version": 1, "content": "tab B"}, headers=world.h("S1"))
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "version_conflict"
    assert world.q("select content, version from student_notes")[0] == {"content": "tab A", "version": 2}


def test_concurrent_edits_from_the_same_version_exactly_one_wins(world):
    n = create(world, content="base").json()
    with cf.ThreadPoolExecutor(8) as ex:
        rs = list(ex.map(lambda i: world.client.patch(f"{N}/{n['id']}", json={"base_version": 1, "content": f"edit {i}"}, headers=world.h("S1")), range(8)))
    assert sorted(r.status_code for r in rs).count(200) == 1 and sum(r.status_code == 409 for r in rs) == 7
    row = world.q("select content, version from student_notes")[0]
    assert row["version"] == 2 and row["content"] == next(r.json()["content"] for r in rs if r.status_code == 200)


# ------------------------------------------------------------------ authorization
def test_other_students_cannot_read_change_or_delete_a_note(world):
    n = create(world, title="private", content="secret").json()
    for who in ("S2", "S3"):
        assert world.client.get(f"{N}/{n['id']}", headers=world.h(who)).status_code == 404
        assert world.client.patch(f"{N}/{n['id']}", json={"base_version": 1, "content": "hacked"}, headers=world.h(who)).status_code == 404
        assert world.client.delete(f"{N}/{n['id']}", headers=world.h(who)).status_code == 404
        assert world.client.get(N, headers=world.h(who)).json()["notes"] == []
        assert world.client.get(N, params={"q": "secret"}, headers=world.h(who)).json()["notes"] == []
        taken = world.client.post(N, json={"id": n["id"], "title": "steal"}, headers=world.h(who))     # reusing S1's id cannot touch S1's note
        assert taken.status_code == 409 and "S1" not in taken.text and "secret" not in taken.text
    assert world.q("select title, content from student_notes") == [{"title": "private", "content": "secret"}]


def test_foreign_and_missing_notes_are_indistinguishable(world):
    n = create(world).json()
    a = world.client.get(f"{N}/{n['id']}", headers=world.h("S2"))
    b = world.client.get(f"{N}/{nid()}", headers=world.h("S2"))
    assert a.status_code == b.status_code == 404 and a.json()["error"]["message"] == b.json()["error"]["message"]


@pytest.mark.parametrize("who", ["P1", "P3"])
def test_notes_are_a_student_feature(world, who):
    assert world.client.get(N, headers=world.h(who)).status_code == 403
    assert create(world, who).status_code == 403


def test_unauthenticated_requests_are_rejected(world):
    n = create(world).json()
    for m, url in (("GET", N), ("POST", N), ("GET", f"{N}/{n['id']}"), ("PATCH", f"{N}/{n['id']}"), ("DELETE", f"{N}/{n['id']}")):
        assert world.client.request(m, url).status_code == 401
        assert world.client.request(m, url, headers={"Authorization": "Bearer forged"}).status_code == 401
