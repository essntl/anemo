# Convenience targets. All Python tooling runs inside the dev container.
DEV = docker compose -f docker-compose.yml -f docker-compose.dev.yml
RUN = $(DEV) run --rm --no-deps -e ENV=test app

.PHONY: up down dev build logs test test-backend test-frontend lint fmt migrate revision gen-api

up:            ## Production stack
	docker compose up -d --build
down:
	docker compose down
dev:           ## Hot-reload stack; open http://localhost:5173
	$(DEV) up --build
logs:
	docker compose logs -f --tail=100

test: test-backend test-frontend
test-backend:  ## needs postgres/valkey; starts them if necessary
	$(DEV) run --rm -e ENV=test app pytest -q
test-frontend:
	cd frontend && npm run typecheck && npm run lint && npm test

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
