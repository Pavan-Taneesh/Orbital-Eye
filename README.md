# Orbital-Eye

Real-time satellite tracking and orbital visualization with AI-powered exploration.

## Overview

Orbital-Eye is a 3D satellite tracking application featuring:
- **Interactive 3D globe** with Earth textures, atmosphere, and city lights
- **Real satellite data** from CelesTrak, Space-Track, SatNOGS, and ESA DISCOS
- **AI assistant** (Gemini) for natural language satellite queries
- **Orbital mechanics** using SGP4 propagation with TEME→ECEF conversion
- **React + Three.js frontend** with react-three-fiber

## Architecture

```
Frontend (React + Vite + Three.js)  ←→  Backend (FastAPI + PostgreSQL)  ←→  Data Ingestion
                                          ↑
                                    AI Provider (Gemini/Fake)
```

## Quick Start

### Prerequisites
- PostgreSQL 16+
- Python 3.12+
- Node.js 20+

### Backend
```bash
# 1. Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env with your DB credentials

# 2. Start PostgreSQL and run migrations
# (Schema: backend/db/schema.sql, Views: backend/db/views.sql, Seed: backend/db/seed.sql)

# 3. Run backend
cd backend
python -m uvicorn main:app --reload --port 8000
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Docker Compose
```bash
# Set environment variables (copy .env.example to .env and edit)
docker-compose up -d
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DB_HOST` | Yes | PostgreSQL host |
| `DB_NAME` | Yes | Database name |
| `DB_USER` | Yes | Database user |
| `DB_PASSWORD` | Yes | Database password |
| `FRONTEND_ORIGIN` | Yes | CORS origin (e.g., `http://localhost:3000`) |
| `GOOGLE_API_KEY` | No | Google Gemini API key for AI |
| `SPACETRACK_USER` | No | Space-Track.org username |
| `SPACETRACK_PASS` | No | Space-Track.org password |
| `DISCOS_TOKEN` | No | ESA DISCOS API token |
| `AI_PROVIDER` | No | `fake` (default) or `gemini` |
| `VITE_API_BASE_URL` | No | Frontend API base (default: `http://localhost:8000/api/v1`) |

**Never commit secrets.** Use `.env` (git-ignored) or secrets management.

## API Endpoints

All under `/api/v1/`:

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /objects` | List objects (paginated) |
| `GET /objects/search?q=` | Search objects by name |
| `GET /objects/{id}` | Object details |
| `GET /objects/{id}/state` | Orbital state (position, velocity, altitude) |
| `GET /objects/{id}/diagnostics` | Debug data |
| `GET /objects/{id}/media` | Images/links |
| `POST /ai/explore` | AI natural language exploration |

## AI Commands

The AI assistant converts natural language to structured commands:

| Command | Description |
|---|---|
| `focus_object` | Select and center camera on satellite |
| `follow_object` | Enable/disable follow mode |
| `show_orbit` | Display orbital path |
| `open_information_panel` | Show detailed info panel |
| `find_object` | Search satellites by name |
| `filter_objects` | List satellites by category |

Example: *"Show me the ISS orbit"* → `show_orbit` with `object_id: 25544`

## Running Tests

```bash
# Backend
cd backend
pytest -v                    # All tests
pytest -m "not integration"  # Skip DB-dependent tests

# Frontend
cd frontend
npm run build                # TypeScript + Vite build
npm run lint                 # ESLint
```

## CI/CD

GitHub Actions workflow (`.github/workflows/ci-cd.yml`):
- **Lint**: ruff
- **Type Check**: mypy
- **Tests**: pytest with PostgreSQL service
- **Build**: Verify FastAPI app loads

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for production deployment instructions.

## Current Limitations

- AI provider requires `GOOGLE_API_KEY` for real Gemini usage (defaults to `fake` provider)
- Database ingestion scripts require API credentials for Space-Track/DISCOS
- Frontend bundle size ~1.1MB (could be code-split)
- Some deprecation warnings in TypeScript/Pydantic (non-blocking)

## License

MIT