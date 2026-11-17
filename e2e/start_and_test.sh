#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# Ensure venv is activated
source .venv/bin/activate

echo "Starting backend uvicorn on port 8000..."
python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --log-level warning &
BACKEND_PID=$!

echo "Starting frontend vite preview on port 5173..."
cd frontend
npx vite preview --port 5173 &
FRONTEND_PID=$!
cd "$DIR"

cleanup() {
    echo "Stopping background servers (PID $BACKEND_PID, $FRONTEND_PID)..."
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    wait $BACKEND_PID 2>/dev/null || true
    wait $FRONTEND_PID 2>/dev/null || true
}
trap cleanup EXIT

# Wait for backend
echo "Waiting for backend on http://127.0.0.1:8000/health..."
for i in {1..30}; do
    if curl -s http://127.0.0.1:8000/health >/dev/null; then
        echo "Backend is ready!"
        break
    fi
    sleep 0.5
done

# Wait for frontend
echo "Waiting for frontend on http://127.0.0.1:5173..."
for i in {1..30}; do
    if curl -s http://127.0.0.1:5173 >/dev/null; then
        echo "Frontend is ready!"
        break
    fi
    sleep 0.5
done

echo "Running Playwright real browser tests..."
cd frontend
node run_browser_mission_a.mjs
