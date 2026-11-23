# Interactive Run Code Blocks: Root Cause and Fix

Date: 2026-11-23 · Scope: SocratiQ Coach chat only (SmartBoard not inspected or changed)

## 1. Exact root cause

The interactive block (`RunnableCodeBlock`, with a Run button) needs three things. First, the model has to write a closed ``` fence. Second, the fence tag has to name a runnable language exactly (`python`, `py` or `python3`). Third, the runtime lookup has to report the runner as enabled. When any of these fails, the reply quietly falls back to plain text or a copy-only block.

The regression came from the generation contract. Nothing in the code broke.

1. **The AI was never told how to format code (main cause).** The code runner arrived in commit `1eeb299` ("sandboxed code runner"). The Coach prompt was not updated then and has never mentioned code formatting. Prompt v4 (the merge of `feature/assessment-integration`, KaTeX rendering) added *"Never put math inside code blocks"* plus a 2–6 sentence limit. Both push the model away from fenced code. As a result, how a reply rendered depended on the model's habits on each turn:
   * code written as plain text or in single backticks rendered as ordinary text;
   * code in an untagged ``` fence rendered as a copy-only block labelled "code" with no Run button;
   * a fence tag with extra info (```` ```Python title=x ````) also gave a copy-only block, because the tag `python title=x` matched no alias;
   * a missing closing fence showed the raw ```` ``` ```` text, with no block at all.
2. **The frontend was stricter than it needed to be.** `RichText` only recognised *closed* fences. `RunnableCodeBlock` compared the raw fence tag to the alias list as-is, and treated an untagged fence as never runnable.
3. **"Off" was cached for 5 minutes (why Run came and went).** `fetchCodeRuntime()` kept an `enabled:false` answer for 5 minutes, and blocks already on screen never asked again. If the runner was still starting, or briefly unreachable, when the chat opened, every block stayed without Run until the page was reloaded.

The execution engine, the API, streaming, persistence and the wiring from `RichText` to `RunnableCodeBlock` in `AiCoach.tsx` all work. Running the original code against the real runner proves it: a well-formed ```` ```python ```` reply got a working Run button before this change too (see §6).

## 2. Why code showed as ordinary Markdown instead of the interactive component

`RichText` splits the text on closed fences and passes each block to `renderCodeBlock`. `AiCoach`'s `Bubble` hands that to `RunnableCodeBlock` once the message is final (its id is no longer `streaming-…`). Inside, `runnableLanguage(runtime, lang)` returned `null` for an empty tag, an info-string tag, or a disabled runtime. The component then rendered without Run, Edit or output. That looks exactly like a normal Markdown code block. An unclosed fence never reached the renderer at all.

## 3. Where it originated

| Layer | Finding |
|---|---|
| AI generation | **Origin.** No instruction to use language-tagged, closed fences; v4 added wording that discourages code blocks. |
| Parsing / detection | Contributing: only closed fences were recognised, and fence tags were not normalised. |
| Rendering (`AiCoach` → `RichText` → `RunnableCodeBlock`) | Unchanged since the code-runner commit (diffed against git objects of `1eeb299`). Correct. |
| Streaming / persistence | Correct. The server sends only the approved, stored text (`segment_text` concatenates back exactly). History reloads with DB ids, so it is runnable. |
| Execution | Healthy. Sandbox suite: 30/30 passed as root. Real runs succeed, fail, time out and cancel correctly. |
| Runtime availability | Contributing: the 5-minute negative cache. **On this machine `.env` has no `CODE_RUNNER_URL` / `CODE_RUNNER_TOKEN`**, so `/student/code/runtime` reports `enabled:false` and *no* block can show Run until the runner is configured and started (see §9). |

## 4. Files modified

| File | Reason |
|---|---|
| `ai/prompts/coach/response_prompt.py` | Adds the code-formatting rule; prompt version v4 → v5. |
| `frontend/src/lib/codeRunner.ts` | Adds `fenceLanguage()` (normalises the tag) and `guessFenceLanguage()` (conservative Python detection for untagged fences). `runnableLanguage()` accepts the code. An "off" or failed runtime is cached for 30 s, and the hook re-checks up to 3 times. |
| `frontend/src/components/socratiq/RunnableCodeBlock.tsx` | Uses the normalised or detected tag for the Run decision, the label and highlighting. Nothing else changed. |
| `frontend/src/components/ui/RichText.tsx` | In a *finished* reply, a final fence that was never closed still becomes a code block. While streaming it stays text, as before. |
| `frontend/src/components/ui/RichText.test.tsx` | The "unfinished fence" test now passes `streaming`, which is what its title says it tests. Adds tests for an unclosed final fence, text plus several blocks in order with their own indexes, and an info-string tag. |
| `frontend/src/components/socratiq/RunnableCodeBlock.test.tsx` | Adds tests for an info-string tag, an untagged Python fence, untagged JS staying copy-only, and recovery when the runner was off at load. |
| `ai/tests/test_response_prompt_code_blocks.py` (new) | Pins the prompt contract for every policy, persona and board turn, and checks the rule never outranks the policy. |

## 5. Exact implementation changes

* **Prompt (v5)**, inserted after the LaTeX rule. Code goes in a fenced block whose opening line names the language (```` ```python ````), with a closing ```` ``` ```` on its own line. Multi-line code never goes in plain text, indented text or single backticks. Python blocks have a Run button, so a small example should print its result. A code block doesn't count toward the sentence limit. *This formatting never relaxes the policy: never put the assignment's solution in a code block.* The answer-leak validators are unchanged.
* **`fenceLanguage(info)`** takes the first word of the tag, lower-cased, without braces, a leading `.` or `language-`. For example `Python title=x` becomes `python`, `{python}` becomes `python`, `.py` becomes `py`.
* **`guessFenceLanguage(code)`** is used only for *untagged* fences. It returns `"python"` only when the code has a clear Python marker (`print(`, `def f():`, `class A:`, `import …`, `for x in y:`, `if/while/with …:`) and no non-Python markers (`;`/`{` line endings, a line starting with `}`, `const/let/function/console./=>/#include`, `$`/`>>>` prompts, markup). Anything ambiguous stays copy-only.
* **Runtime cache:** a working runtime is kept for 5 minutes, as before. An off or failed answer is kept for 30 s. A mounted block re-checks up to 3 times through the shared cache, so all blocks together make one request.
* **`RichText`:** the fence handling became one `pushFence` helper (same behaviour for maths fences and compact mode). The `UNCLOSED_FENCE` check runs only on the text after the last closed fence, and only when the reply is not streaming. The block keeps its stable index, so stored run results still line up.

No new components, no new execution engine, no database migration, and no change to SmartBoard, chat–board sync, the API or the backend execution code.

## 6. Real execution test results

These ran in a real Chrome browser (puppeteer). The bundle contained the real `RichText`, `RunnableCodeBlock`, `CodeEditor`, `codeRunner.ts`, `api.ts` and KaTeX, plus a verbatim copy of `AiCoach`'s `Bubble` render logic. It talked to the real `CodeService` from `backend/app/code_runner.py` (copied unchanged, run with production rules), and that called the **real sandbox runner** running as root with full isolation (`uid_separation`, `network_blocked`, `secrets_unreadable` all true). FastAPI is not installed in this environment, so a small stdlib HTTP shim stood in for the routing and auth layer.

| Test | Before (original code) | After |
|---|---|---|
| Python ```` ```python ```` | Run ✓ | Run ✓ → `[1, 2, 3]\n[3, 1, 2]` "Completed in 53 ms" |
| JavaScript ```` ```javascript ```` | copy-only | copy-only, labelled "javascript" (runner supports Python only: graceful fallback) |
| Code with explanation | ✓ | text before, between and after kept in order ✓ |
| Multiple blocks | ✓ | each runs on its own; block 2 `ZeroDivisionError` in stderr, "Failed · exit code 1" |
| Untagged Python fence | **no Run** | Run ✓ → `0\n1\n4` |
| Unclosed final fence | **raw ```` ``` ```` text, no block** | Run ✓ → `closing fence missing` |
| ```` ```Python title=demo.py ```` | **no Run** | Run ✓ |
| ```` ``` python ```` (space) | ✓ | ✓ |
| Normal Markdown (`bash`, untagged config) | copy-only | copy-only (unchanged) |
| Maths reply | KaTeX | KaTeX (unchanged) |
| Infinite loop | — | "Stopped: took longer than 5.0 s" |
| Concurrent runs (2 at once) | — | first completes (2.1 s); second shows "Another of your programs is still running…" (server's one-run-per-student rule, HTTP 409) |
| Runner off at page load, started afterwards | **never got Run (waited 100 s)** | Run appeared after **30 s**, no reload |

## 7. Streaming and persistence

* **Streaming:** each reply was streamed with the backend's real `segment_text()` segments, using the same three state updates as `AiCoach.handleSend`. While streaming, no frame ever showed Run, and code showed as a plain `<pre>`. The finished message then rendered the interactive block. An interrupted or unclosed fence during streaming stays text, and becomes a block only once the reply is final.
* **Reload:** after a full page reload, the stored messages (DB ids) showed two interactive blocks. Both ran again, with correct output and stderr.

## 8. Test results

| Suite | Result |
|---|---|
| `sandbox/code_runner/tests/test_sandbox.py` (as root) | **30 passed, 0 skipped** |
| Browser E2E above (real runner) | all scenarios as in §6 |
| `ai/tests/test_response_prompt_code_blocks.py` (real `policy.py` and `personas.py`; `langchain_core` stubbed) | **6 passed** |
| Fence-language unit cases (21 cases plus `runnableLanguage`) | all pass |
| `tsc` strict on the 3 changed source files (React types stubbed) | clean |
| esbuild bundle of the changed files | clean |

**Not run here.** This environment has no network for package installs, and no shell on your machine. Please run these locally:

```bash
cd frontend && npx vitest run src/components/ui/RichText.test.tsx src/components/socratiq/RunnableCodeBlock.test.tsx && npm run build && npm run lint
cd .. && pytest ai/tests/test_response_prompt_code_blocks.py backend/tests/test_code_runner_api.py backend/tests/test_coach_stream.py -q
```

## 9. Remaining limitations

* **Your `.env` does not configure the runner.** Without `CODE_RUNNER_URL`, `CODE_RUNNER_TOKEN` and a running `code-runner` service, the API correctly reports the feature as off and no Run button can appear. See `docs/CODE_RUNNER.md`. Locally: `openssl rand -hex 32 > secrets/code_runner_token`, set `CODE_RUNNER_URL=http://code-runner:8080` and the same token in `.env`, then `docker compose --profile code-runner up -d --build`. I did not edit `.env`, because it holds secrets.
* Only Python is executable. That is the existing runner's language set. JavaScript and other blocks are copy-only by design.
* Following the format is now an instruction to the model, which follows it far more reliably but not with a guarantee. The frontend fallbacks (untagged Python, unclosed fence, info strings) cover the common slips. Code written as indented text or in single backticks still renders as text.
* Under GUIDED policy the existing answer-leak guardrails can still refuse a full solution in code. That is intended.

## 10. Unrelated functionality

No SmartBoard files, chat–board communication, sync or events, other chat features, layout, execution engine, backend API or database were modified. Changes are limited to the files in §4 (six modified, one new test) and this report.
