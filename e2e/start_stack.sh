#!/bin/bash
# Starts Postgres, the real backend (fake model provider + test identity), and the Vite dev server. Idempotent. Usage: source e2e/start_stack.sh
service postgresql start >/dev/null 2>&1
for i in $(seq 1 15); do su postgres -c "pg_isready -q" && break; sleep 2; done
. /home/claude/venv/bin/activate
export TEST_ADMIN_URL="postgresql://postgres:testpw@127.0.0.1:5432/postgres"
if ! curl -s -o /dev/null http://127.0.0.1:8000/api/v1/smartboard/config; then
  rm -f /tmp/stack.log; (cd /home/claude/work && nohup setsid python e2e/serve_stack.py > /tmp/stack.log 2>&1 &)
  for i in $(seq 1 40); do grep -q "STACK READY" /tmp/stack.log 2>/dev/null && break; sleep 2; done
fi
if [ -z "$SKIP_WEB" ] && ! curl -s -o /dev/null http://localhost:5173/; then
  (cd /home/claude/work/frontend && VITE_API_URL=http://localhost:8000 VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=anon-e2e nohup setsid npx vite --port 5173 --host localhost --strictPort > /tmp/vite.log 2>&1 &)
  for i in $(seq 1 40); do curl -s -o /dev/null http://localhost:5173/ && break; sleep 1; done
fi
curl -s -o /dev/null -w "api:%{http_code} " http://127.0.0.1:8000/api/v1/smartboard/config; curl -s -o /dev/null -w "web:%{http_code}\n" http://localhost:5173/
