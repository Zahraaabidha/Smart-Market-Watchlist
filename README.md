# Groww Focus

An independent hackathon project that helps you see what changed in your watchlist while you were away.

## The problem

A normal watchlist gives every stock the same visual weight. When you come back, you have to scan the whole list and remember where you left off.

Groww Focus uses your last review as a checkpoint and builds a short brief around what changed after that point.

It also looks at moves within the window, not just the price at the start and end. That means a stock that jumped and then settled back is still surfaced.

## How it works

1. Create an account. A starter watchlist is added automatically.
2. Add or reorder symbols and set priorities.
3. Set your sensitivity preferences in **Manage**.
4. Open **Brief** to see what changed since your last review.
5. Open an event to inspect the full price path.
6. Click **I've reviewed this** when you're done.
7. Use **History** to see what earlier briefs surfaced.

## What the Brief scores

- Move vs your threshold
- Unusual move vs the symbol's recent volatility
- Volume anomaly
- Price threshold crossings
- In-window high/low swing

Each signal contributes to an attention score and a plain-language explanation.

## Data modes

**Replay**  
Deterministic market data for demos and tests. The same seed produces the same series.

**Live**  
Uses Twelve Data for live NSE quotes.

**Degraded**  
If the live provider fails, the app falls back to replay data and clearly shows that the source changed.

Replay is a status, not a button. **Demo** is a separate action that prepares a populated replay scenario.

## Engineering

- FastAPI + SQLAlchemy + PostgreSQL
- React + TypeScript + Tailwind + Vite
- Hand-rolled SVG price-path chart
- JWT authentication with bcrypt
- Background market-data ingestion
- Deterministic replay provider with live-provider abstraction

Some important correctness rules:

- Market snapshots are append-only.
- Current quotes only move forward by source timestamp.
- Checkpoints are idempotent.
- Watchlist ownership is enforced during lookup.
- Concurrent watchlist inserts use database locking to keep positions unique.

## Run locally

### Requirements

Docker, Python 3.11+, Node 20+

### Database

```bash
docker compose up -d db