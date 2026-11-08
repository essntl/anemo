# Convenience targets. All Python tooling runs inside the dev container.
DEV = docker compose -f docker-compose.yml -f docker-compose.dev.yml
RUN = $(DEV) run --rm --no-deps -e ENV=test app
# The committed OpenAPI schema, for the API contract test (the container only mounts backend/).
SNAPSHOT = -v "$$PWD/frontend/src/api/openapi.json:/openapi.json:ro" -e OPENAPI_SNAPSHOT=/openapi.json

.PHONY: up down dev build logs test test-backend test-frontend coverage e2e lint fmt migrate revision gen-api backup

up:            ## Production stack (records the checkout's commit for the update notice)
	APP_COMMIT=$$(git rev-parse HEAD 2>/dev/null) docker compose up -d --build
down:
	docker compose down
dev:           ## Hot-reload stack; open http://localhost:5173
	$(DEV) up --build
logs:
	docker compose logs -f --tail=100

test: test-backend test-frontend
test-backend:  ## needs postgres/valkey; starts them if necessary
	$(DEV) run --rm -e ENV=test $(SNAPSHOT) app pytest -q
test-frontend:
	cd frontend && npm run typecheck && npm run lint && npm test
coverage:      ## line coverage of backend and frontend tests (see refactor/BASELINE.md)
	$(DEV) run --rm -e ENV=test $(SNAPSHOT) app pytest -q --cov=app --cov-report=term
	cd frontend && npm run coverage
e2e:           ## every end-to-end test, against a throwaway stack
	sh e2e/run-isolated.sh

lint:
	$(RUN) sh -c "ruff check . && ruff format --check . && mypy app"
fmt:
	$(RUN) sh -c "ruff check --fix . && ruff format ."

migrate:
	$(DEV) run --rm migrate
revision:      ## make revision m="add conversations"
	$(DEV) run --rm migrate alembic revision --autogenerate -m "$(m)"

gen-api:       ## Regenerate frontend API types from the backend's OpenAPI schema
	$(RUN) python -m app.cli export-openapi > frontend/src/api/openapi.json
	cd frontend && npm run gen-api

backup:        ## database, uploads and workspace into ./backups (see docs/backup.md)
	sh scripts/backup.sh
