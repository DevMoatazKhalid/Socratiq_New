"""Notes board (migration 019) against the real migrated database: organisation fields, groups, ownership and isolation from text edits."""
from __future__ import annotations

import uuid

from .helpers import API

N = f"{API}/student/notes"


def nid() -> str:
    return "note_" + uuid.uuid4().hex


def create(w, who="S1", **body):
    body.setdefault("id", nid())
    return w.client.post(N, json=body, headers=w.h(who)).json()


def meta(w, note_id, who="S1", **patch):
    return w.client.patch(f"{N}/{note_id}/meta", json=patch, headers=w.h(who))


def test_new_notes_are_unfiled_and_list_carries_groups(world):
    a = create(world, title="BST")
    assert (a["course_id"], a["assignment_id"], a["importance"], a["pinned"], a["group_ids"]) == (None, None, None, False, [])
    body = world.client.get(N, headers=world.h("S1")).json()
    assert body["groups"] == [] and body["notes"][0]["group_ids"] == []


def test_meta_sets_only_what_is_sent_and_never_bumps_the_text_version(world):
    a = create(world, title="BST", content="insert")
    r = meta(world, a["id"], importance="high", pinned=True, assignment_id="A1")
    assert r.status_code == 200
    m = r.json()
    assert (m["importance"], m["pinned"], m["course_id"], m["assignment_id"], m["version"]) == ("high", True, "C1", "A1", 1)   # the assignment implies its course
    m = meta(world, a["id"], course_id="C1").json()
    assert m["assignment_id"] == "A1" and m["importance"] == "high"                         # same course: the assignment link is kept
    m = meta(world, a["id"], importance=None).json()
    assert m["importance"] is None and m["pinned"] is True
    up = world.client.patch(f"{N}/{a['id']}", json={"base_version": 1, "content": "edited"}, headers=world.h("S1"))
    assert up.status_code == 200 and up.json()["version"] == 2 and up.json()["pinned"] is True     # organising never causes a text conflict


def test_meta_validation_and_ownership(world):
    a = create(world)
    assert meta(world, a["id"]).status_code == 422                                          # nothing to update
    assert meta(world, a["id"], pinned=None).status_code == 422
    assert meta(world, a["id"], importance="urgent").status_code == 422
    assert meta(world, a["id"], course_id="C2").status_code == 404                          # a course you are not enrolled in looks like no course
    assert meta(world, a["id"], assignment_id="A1d").status_code == 404                     # drafts are invisible to students
    assert meta(world, a["id"], course_id="C2", assignment_id="A1").status_code in (404, 422)
    assert meta(world, a["id"], who="S2", pinned=True).status_code == 404                   # another student's note does not exist for you
    assert meta(world, "note_" + "0" * 32, pinned=True).status_code == 404


def test_groups_mix_notes_replace_membership_and_survive_note_text_edits(world):
    a, b = create(world, title="a"), create(world, title="b")
    r = world.client.post(f"{N}/groups", json={"name": "Exam prep", "assignment_id": "A1", "note_ids": [a["id"], b["id"]]}, headers=world.h("S1"))
    assert r.status_code == 201
    g = r.json()
    assert g["name"] == "Exam prep" and g["assignment_id"] == "A1" and sorted(g["note_ids"]) == sorted([a["id"], b["id"]])
    g2 = world.client.post(f"{N}/groups", json={"name": "Second"}, headers=world.h("S1")).json()
    m = meta(world, b["id"], group_ids=[g2["id"]]).json()
    assert m["group_ids"] == [g2["id"]]                                                     # replaces, not appends
    lst = world.client.get(N, headers=world.h("S1")).json()
    assert {x["name"] for x in lst["groups"]} == {"Exam prep", "Second"}
    assert {n["id"]: n["group_ids"] for n in lst["notes"]} == {a["id"]: [g["id"]], b["id"]: [g2["id"]]}
    ren = world.client.patch(f"{N}/groups/{g['id']}", json={"name": "Renamed", "assignment_id": None}, headers=world.h("S1"))
    assert ren.status_code == 200 and ren.json()["name"] == "Renamed" and ren.json()["assignment_id"] is None
    assert world.client.delete(f"{N}/groups/{g['id']}", headers=world.h("S1")).status_code == 204
    assert world.client.get(f"{N}/{a['id']}", headers=world.h("S1")).json()["group_ids"] == []   # the note is kept, it just left the group
    assert world.client.delete(f"{N}/groups/{g['id']}", headers=world.h("S1")).status_code == 404


def test_groups_are_private(world):
    mine = create(world)
    g = world.client.post(f"{N}/groups", json={"name": "Mine"}, headers=world.h("S1")).json()
    theirs = create(world, who="S2")
    assert world.client.post(f"{N}/groups", json={"name": "x", "note_ids": [mine["id"]]}, headers=world.h("S2")).status_code == 404
    assert meta(world, theirs["id"], who="S2", group_ids=[g["id"]]).status_code == 404
    assert world.client.patch(f"{N}/groups/{g['id']}", json={"name": "hijack"}, headers=world.h("S2")).status_code == 404
    assert world.client.delete(f"{N}/groups/{g['id']}", headers=world.h("S2")).status_code == 404
    assert world.client.get(N, headers=world.h("S2")).json()["groups"] == []
    assert world.client.post(f"{N}/groups", json={"name": "  "}, headers=world.h("S1")).status_code == 422
    assert world.client.post(f"{N}/groups", json={"name": "x"}, headers=world.h("P1")).status_code == 403


def test_deleting_a_note_removes_it_from_groups(world):
    a = create(world)
    g = world.client.post(f"{N}/groups", json={"name": "G", "note_ids": [a["id"]]}, headers=world.h("S1")).json()
    assert world.client.delete(f"{N}/{a['id']}", headers=world.h("S1")).status_code == 204
    assert world.q("select count(*)::int as n from student_note_group_members where group_id=%s", g["id"]) == [{"n": 0}]
