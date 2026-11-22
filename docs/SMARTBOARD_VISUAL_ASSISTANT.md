# SmartBoard visual assistant: search first, generate when needed

One image request on the SmartBoard. SocratiQ decides by itself whether to retrieve an existing image or create a new one:

**understand the request → decide → search → evaluate → use the best suitable result → otherwise generate → otherwise offer the options**

## Files

| File | Role |
|---|---|
| `backend/app/visual_assistant.py` | Understanding (LLM + rules fallback), the decision, orchestration, the result payload |
| `backend/app/image_search.py` | Search providers, licences, heuristic scoring, de-duplication, the vision judge, caching, signed result tokens, safe downloads |
| `backend/app/image_generation.py` | The existing generation pipeline (art-director plan, model chain, optimisation). Now also receives the request analysis and lesson context |
| `backend/app/routers/smartboard.py` | `POST /smartboard/image` (SSE or JSON), `POST /smartboard/image/candidate`, `mode` on `/generate-image` |
| `frontend/src/components/smartboard/VisualResult.tsx` | Progress trail, result card, "nothing good enough" card |
| `frontend/src/components/smartboard/SmartBoardWorkspace.tsx` | Runs the request, places the image with its caption, swaps results, regenerates |
| `frontend/src/components/smartboard/ImageOptions.tsx` | Source (Smart / Real images / AI-generated), style, shape, quality |

## 1. Understanding

A fast Gemini text model reads the request with the **lesson context** (course, assignment title, core concepts, the last turns of the shared
Chat/Board/Voice transcript, and any text the student selected on the board). All of it is passed as fenced DATA. It returns: the subject in
English, a category (`real_person`, `historical_event`, `place`, `organism`, `specimen`, `artifact`, `documented_diagram`, `map`, `artwork`,
`scientific_process`, `abstract_concept`, `fictional`, `creative_scene`, `custom_diagram`, `other`), a strategy (`search` / `generate` /
`either`), the kind of image that teaches best (`photo`, `diagram`, `map`, `illustration`), 1–3 search queries, what a correct image must show,
and look-alikes to avoid. When the model is unavailable, a keyword analysis in English and Arabic gives the same structure.

## 2. Decision

| Situation | What happens |
|---|---|
| Default (Smart) | Search first. Generate only if nothing found is suitable |
| Clearly creative, fictional, abstract or a custom composition (e.g. "a dragon reading a book", a sketch or infographic style) | Generate directly (no wasted search) |
| A real person | Search only. **No AI likeness is ever generated.** If nothing reliable is found, the closest results and other options are offered |
| Other documentary subjects (historical events, places, artworks, artefacts) when generation is the fallback | An honest **illustration**, never a fake photograph, labelled AI-generated |
| "Real images" | Search only, never generates; offers "Create an AI image" if nothing fits |
| "AI-generated" | Generate directly |

## 3. Search and evaluation

Providers, chosen by category: Wikipedia lead images (canonical pictures of people, places, events, species), Wikimedia Commons (photos,
specimens, historical photographs, documented diagrams; SVG diagrams arrive as PNG renders), Openverse (openly licensed media, downloaded through
Openverse's own proxy), and Pexels (optional, `PEXELS_API_KEY`).

1. **Licence filter.** A result without a known reusable licence (CC0, public domain, CC BY / BY-SA / NC / ND, Pexels licence) is dropped.
2. **Heuristic score** from metadata: subject and must-show words in the title and description, resolution, shape, the kind of image wanted,
   misleading titles (stamp, logo, toy, statue, poster… unless asked for), provider reliability, licence restrictions.
3. **De-duplication** by URL, title and a perceptual hash of the thumbnail.
4. **Vision judge.** The best six thumbnails are shown to a multimodal Gemini model with the request, what must be visible and the lesson. It
   scores relevance, accuracy, educational value and quality, and flags wrong subjects, misleading or inappropriate images. A result is used only
   if it shows the subject, is not misleading, scores relevance ≥ 7 and accuracy ≥ 6, and passes `SMARTBOARD_IMAGE_SEARCH_MIN_SCORE`.
   Without the judge, only a near-certain metadata match is accepted.
5. **Refinement.** If the first query finds nothing suitable, the alternative queries (and a "diagram" / "photograph" variant) are tried before
   giving up on search.

## 4. Generation fallback

`generate_board_image` receives the original request (language and wording preserved), the chosen style/shape/quality, what must be shown, the
lesson context and, for documentary subjects, the illustration-only rule. Its own Wikimedia fallback is switched off after a search, so the same
library is not searched twice.

## 5. The experience

- Live stages from the server (Understand → Search → Check → Create → Place), with elapsed time.
- Every image is badged **Real photo / Real diagram** or **AI-generated**. Retrieved images show author, licence, library and a link to the source
  page, and the same credit is written in the caption on the board, so attribution travels with the board.
- Other good matches appear as thumbnails; clicking one swaps it in place.
- "Create an AI image instead" on a retrieved image; "Regenerate" and "Find real images" on a generated one. The old image is replaced only
  when the new one is ready.
- When nothing is good enough: the reason, the closest results (marked as unverified), and only the next steps that make sense
  (create an AI image, find real images, draw it as a diagram, rephrase).

## Security and reliability

- The visual policy gate (`_gate_visual`) runs before anything is searched, exactly as for generation; the outcome is recorded in the shared transcript.
- Downloads go only to `upload.wikimedia.org`, `api.openverse.org` and `images.pexels.com` over HTTPS, are size-limited, and are validated by
  `smartboard_media.validate_image` (bytes decoded, SVG refused).
- Swapping in another result uses a server-signed, user-bound, expiring token (HMAC, key derived from the board signing key), so the client
  can never make the server fetch an arbitrary URL.
- Search results, thumbnails, full images and request analyses are cached in process (TTL + LRU). Every provider call has its own timeout; one
  failing provider never fails the request. SSE keep-alives cover long generations.

## Configuration

See the "visual assistant" block in `.env.example`. Nothing new is required: without extra keys it searches Wikipedia, Wikimedia Commons and Openverse.

## Tests

- `backend/tests/test_visual_assistant.py` – understanding, decisions, licences, scoring, de-duplication, the judge, tokens, host allow-list, and
  the complete flows (retrieved, fallback to generation, real person, creative, real-images-only, no vision, failures).
- `backend/tests/test_visual_api.py` – HTTP contract (JSON, SSE stages, generate mode, validation, candidate swap, `/generate-image` modes).
- `frontend/src/components/smartboard/VisualResult.test.tsx` – progress steps, captions, the result and no-match cards.

## Known limits

- The Live Voice `generate_image` tool still generates directly (its board element has no caption to carry a licence credit).
- The caches are per process, like the rate limiter. Use a shared cache if you run several workers.
