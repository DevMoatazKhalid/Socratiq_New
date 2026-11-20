"""In-chat code runner API. Authenticated students only; limits are the server's; code runs in the isolated runner service, never here.

    GET    /student/code/runtime                  which languages can run (empty when the runner is off or failed its isolation check)
    POST   /student/code/executions               run one program and wait for its result (bounded by the server's timeout)
    DELETE /student/code/executions/{run_id}      stop one of YOUR runs that is still going
"""
from __future__ import annotations

import asyncio
import re

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool

from ..auth import CurrentUser, require_student
from ..code_runner import CodeService
from ..errors import not_found
from ..ratelimit import code_run_rate_limit
from ..schemas import CodeRunIn

router = APIRouter(prefix="/student/code", tags=["code"])
RUN_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _svc(request: Request) -> CodeService:
    return request.app.state.code_service


@router.get("/runtime")
def runtime(request: Request, user: CurrentUser = Depends(require_student)):
    return _svc(request).runtime()


@router.post("/executions", dependencies=[Depends(code_run_rate_limit)])
async def execute(body: CodeRunIn, request: Request, user: CurrentUser = Depends(require_student)):
    svc = _svc(request)
    language = await run_in_threadpool(svc.resolve_language, body.language)
    run = svc.begin(user.user_id, body.run_id)
    try:
        task = asyncio.ensure_future(run_in_threadpool(svc.execute, run, language, body.source, body.stdin))
        while True:
            done, _ = await asyncio.wait({task}, timeout=0.25)
            if done:
                break
            if await request.is_disconnected():          # the student closed the tab or aborted: stop the job instead of letting it run on
                await run_in_threadpool(svc.cancel, user.user_id, body.run_id)
                break
        result = await task
    finally:
        svc.end(run)
    return {"run_id": body.run_id, "language": language, **result}


@router.delete("/executions/{run_id}", status_code=202)
def cancel(run_id: str, request: Request, user: CurrentUser = Depends(require_student)):
    if not RUN_ID.match(run_id) or not _svc(request).cancel(user.user_id, run_id):
        raise not_found("No such run.")
    return {"cancelled": True}
