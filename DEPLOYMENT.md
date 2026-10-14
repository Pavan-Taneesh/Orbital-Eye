# Space-website Deployment Configuration

## Production Build

### Build the Docker image

```bash
docker build -t space-website:latest .
# Or using GitHub Actions CI pipeline
```

### Run the container

```bash
docker run -d \
  -p 8000:8000 \
  --name space-website \
  --restart unless-stopped \
  -e DB_HOST=postgres-host \
  -e DB_NAME=production_db \
  -e DB_USER=postgres_user \
  -e DB_PASSWORD=secure_password \
  -e FRONTEND_ORIGIN=https://your-domain.com \
  -e GOOGLE_API_KEY=your_gemini_key \
  -e SPACETRACK_USER=space_track_user \
  -e SPACETRACK_PASS=space_track_password \
  -e DISCOS_TOKEN=discos_api_token \
  space-website:latest
```

### Docker Compose (production)

```bash
docker-compose -f docker-compose.yml up -d
```

## Environment Variables

Required environment variables (set via Docker `-e`, `docker-compose.yml`, or system `ENV`):

| Variable | Description | Example |
|---|---|---|
| `DB_HOST` | PostgreSQL host address | `db-instance.example.com` |
| `DB_NAME` | Database name | `production_db` |
| `DB_USER` | Database user | `postgres` |
| `DB_PASSWORD` | Database password | *set at deployment time* |
| `FRONTEND_ORIGIN` | Frontend origin for CORS | `https://your-domain.com` |
| `GOOGLE_API_KEY` | Google Gemini API key | *set at deployment time* |
| `SPACETRACK_USER` | Space-Track.org username | *set at deployment time* |
| `SPACETRACK_PASS` | Space-Track.org password | *set at deployment time* |
| `DISCOS_TOKEN` | ESA DISCOS API token | *set at deployment time* |

**Never commit these values to version control.** Use secrets management (GitHub Actions secrets, AWS Secrets Manager, etc.) or a `.env` file that is git-ignored.

## Development Local Setup

```bash
# 1. Copy env example and fill values
cp backend/.env.example backend/.env

# 2. Start the backend
cd backend
python -m uvicorn main:app --reload --port 8000

# 3. Start the frontend (separate terminal)
cd ../frontend
# Follow frontend-specific setup instructions
```

## Frontend-Backend Communication

- The backend FastAPI app serves on `http://0.0.0.0:8000`
- CORS is configured via the `FRONTEND_ORIGIN` environment variable
- All API endpoints are under `/api/v1/`
- Frontend should target `{API_BASE_URL}/api/v1/...`
- Health check: `GET /api/v1/health` returns `{"status": "ok"}`

## Production Checklist

- [ ] Set all required environment variables (no hardcoded secrets)
- [ ] Configure `FRONTEND_ORIGIN` to match the production frontend domain
- [ ] Verify PostgreSQL is accessible and has required tables/metadata
- [ ] Test health endpoint: `GET /api/v1/health`
- [ ] Test search: `GET /api/v1/objects/search?q=ISS`
- [ ] Verify AI provider credentials are configured (or service degrades gracefully)
- [ ] Run CI pipeline to confirm lint, type check, and tests pass
- [ ] Confirm Docker image builds successfully from CI
- [ ] Set up log aggregation and monitoring
- [ ] Enable HTTPS termination at load balancer/proxy layer

## Logs

```bash
# View container logs
docker logs -f space-website

# Or via Docker Compose
docker-compose logs -f backend
```