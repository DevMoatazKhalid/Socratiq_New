"""LOCAL E2E TEST HARNESS. Not production code.

Runs the REAL FastAPI backend (real routes, real PostgreSQL scratch DB, real RLS-era schema, real validators) with two test doubles:
  * identity: tokens of the form `tok:<auth-uuid>` are accepted (the backend's own tests use the same seam; production uses Supabase Auth)
  * the model provider: a local HTTP server stands in for Google (so it is a FAKE provider; nothing here verifies real Gemini/Imagen)
"""
import base64, io, json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path("/home/claude/work")
for p in (ROOT / "backend", ROOT / "database" / "tests", ROOT):
    sys.path.insert(0, str(p))

GEM_PORT, API_PORT = 9911, 8000
os.environ.update(GEMINI_API_KEY="e2e-fake-key", GEMINI_API_BASE=f"http://127.0.0.1:{GEM_PORT}/v1beta",
                  GEMINI_LIVE_WS_BASE=f"ws://127.0.0.1:{GEM_PORT + 1}/live", CORS_ORIGINS="http://localhost:5173,http://127.0.0.1:5173")

from PIL import Image, ImageDraw

def png() -> str:
    im = Image.new("RGB", (320, 240), (255, 244, 214)); d = ImageDraw.Draw(im)
    d.ellipse((60, 40, 260, 200), fill=(220, 60, 60)); d.rectangle((140, 100, 180, 200), fill=(30, 90, 160))
    b = io.BytesIO(); im.save(b, "PNG"); return base64.b64encode(b.getvalue()).decode()

SIM = """<div style="font-family:sans-serif"><h2>Spring</h2><canvas id="c" width="360" height="160" style="border:1px solid #94a3b8"></canvas>
<div><label>Stiffness <input id="k" type="range" min="1" max="30" value="10"></label> <button id="p">Pause</button> <button id="r">Reset</button></div>
<div>t=<span id="t">0.00</span> x=<span id="x">0</span></div></div>
<script>const c=document.getElementById('c'),g=c.getContext('2d');let x=60,v=0,t=0,run=true,last=performance.now();
function f(n){const dt=Math.min(.03,(n-last)/1000);last=n;if(run){v+=-(+k.value)*x*dt;x+=v*dt;t+=dt}
g.clearRect(0,0,360,160);g.fillStyle='#0d9488';g.fillRect(180+x-15,60,30,40);document.getElementById('t').textContent=t.toFixed(2);document.getElementById('x').textContent=x.toFixed(1);requestAnimationFrame(f)}
requestAnimationFrame(f);p.onclick=e=>{run=!run;e.target.textContent=run?'Pause':'Play'};r.onclick=()=>{x=60;v=0;t=0}</script>"""
FLOW = {"version": 1, "type": "flowchart", "topic": "login", "nodes": [{"id": "a", "label": "Start", "kind": "terminal"}, {"id": "d", "label": "Valid?", "kind": "decision"}, {"id": "b", "label": "Home"}, {"id": "c", "label": "Retry"}],
        "edges": [{"from": "a", "to": "d"}, {"from": "d", "to": "b", "label": "yes"}, {"from": "d", "to": "c", "label": "no"}]}
VEC = {"elements": [{"type": "rect", "x": 0, "y": 40, "width": 120, "height": 80, "color": "#2563eb", "filled": True}, {"type": "triangle", "x": 0, "y": 0, "width": 120, "height": 40, "color": "#ef4444", "filled": True}]}
MODE = {"image": "ok", "calls": []}

class Gem(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); body = json.loads(self.rfile.read(n) or b"{}")
        MODE["calls"].append({"path": self.path, "has_key_header": bool(self.headers.get("x-goog-api-key")), "key_in_url": "key=" in self.path})
        if ":predict" in self.path:
            if MODE["image"] == "fail": return self._send(500, {"error": "boom"})
            if MODE["image"] == "svg": return self._send(200, {"predictions": [{"bytesBase64Encoded": base64.b64encode(b"<svg onload=alert(1)/>").decode(), "mimeType": "image/png"}]})
            return self._send(200, {"predictions": [{"bytesBase64Encoded": png(), "mimeType": "image/png"}]})
        text = json.dumps(body)
        if MODE["image"] == "fail" and "visual illustration" in text: return self._send(500, {"error": "boom"})
        if "interactive HTML/JS simulation" in text: out = "```html\n" + SIM + "\n```"
        elif "vector drawing" in text: out = json.dumps(VEC)
        elif "application/json" in text: out = json.dumps(FLOW)
        else: out = "Good start. What happens to both sides of the equation if you subtract 4?"
        self._send(200, {"candidates": [{"content": {"parts": [{"text": out}]}}]})
    def do_GET(self):
        if self.path == "/__calls": return self._send(200, MODE["calls"])
        if self.path == "/__live": return self._send(200, {k: v for k, v in LIVE.items() if k != "setup"} | {"setup_has_server_rules": "single pedagogical authority" in json.dumps(LIVE["setup"] or {}), "setup_has_client_evil": "EVIL" in json.dumps(LIVE["setup"] or {})})
        self._send(404, {})
    def do_PUT(self):
        n = int(self.headers.get("content-length", 0)); self.rfile.read(n)
        if self.path.startswith("/live-"):
            LIVE["mode"] = self.path[len("/live-"):]
            if LIVE["mode"] == "reset": LIVE.update(mode="ok", connected=0, closed=0, audio_chunks=0, setup=None, paths=[])
            return self._send(200, {"live": LIVE["mode"]})
        MODE["image"] = self.path.strip("/"); self._send(200, {"mode": MODE["image"]})


# ---- fake Gemini LIVE provider (WebSocket). A stand-in: it verifies nothing about real Gemini.
import asyncio
from websockets.asyncio.server import serve as ws_serve
LIVE = {"mode": "ok", "connected": 0, "closed": 0, "audio_chunks": 0, "setup": None, "paths": []}
PCM = base64.b64encode((b"\x10\x00" * 4800)).decode()
async def live_handler(ws):
    LIVE["connected"] += 1; LIVE["paths"].append(ws.request.path)
    try:
        first = json.loads(await ws.recv()); LIVE["setup"] = first
        if LIVE["mode"] == "silent": await asyncio.sleep(60); return
        await ws.send(json.dumps({"setupComplete": {}}))
        spoke = False
        async for m in ws:
            LIVE["audio_chunks"] += 1
            if LIVE["mode"] == "drop" and LIVE["audio_chunks"] >= 3: await ws.close(); return
            if not spoke and LIVE["audio_chunks"] >= 3:
                spoke = True
                await ws.send(json.dumps({"serverContent": {"modelTurn": {"parts": [{"inlineData": {"mimeType": "audio/pcm;rate=24000", "data": PCM}}]}}}))
                await ws.send(json.dumps({"serverContent": {"turnComplete": True}}))
    except Exception: pass
    finally: LIVE["closed"] += 1
def run_live():
    loop = asyncio.new_event_loop(); asyncio.set_event_loop(loop)
    async def main():
        async with ws_serve(live_handler, "127.0.0.1", GEM_PORT + 1): await asyncio.Future()
    loop.run_until_complete(main())
threading.Thread(target=run_live, daemon=True).start()

threading.Thread(target=lambda: ThreadingHTTPServer(("127.0.0.1", GEM_PORT), Gem).serve_forever(), daemon=True).start()

import dbtools, psycopg, uvicorn
from tests.conftest import FakeAI, FakeVerifier   # the backend's own test doubles
from app.db import Database
from app.files.rag_bridge import build_rag_service
from app.files.storage import LocalObjectStorage
from app.main import create_app
from ai.rag.embeddings import MockEmbeddingProvider
from ai.rag.storage.pgvector import PgVectorStore

name = dbtools.clone(dbtools.build_template(name="socratiq_e2e_template"))
url = dbtools.url_for(name)
with psycopg.connect(url, autocommit=True) as c:
    dbtools.seed(c); c.execute("UPDATE users SET first_name='First'||user_id, last_name='Last'")
Path("/tmp/e2e_db_url").write_text(url)
db = Database(url, 1, 6); db.open()
app = create_app(db=db, storage=LocalObjectStorage(Path("/tmp/e2e_objects"), bucket="e2e", secret="e2e"), token_verifier=FakeVerifier(), ai_adapter=FakeAI(),
                 rag=build_rag_service(vector_store=PgVectorStore(database_url=url), embedding_provider=MockEmbeddingProvider(dimension=2048)), run_worker=False)
print("STACK READY", url, flush=True)
uvicorn.run(app, host="127.0.0.1", port=API_PORT, log_level="warning")
