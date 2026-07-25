# 0815software — one-command platform operations.
#
# The whole platform (ten independent services) behaves like a single product
# here, while each service stays independently buildable and runnable. Run
# `make` or `make help` for the list.

COMPOSE_DEV := docker compose -f deploy/docker-compose.dev.yml
COMPOSE_PROD := docker compose -f deploy/docker-compose.yml
SERVICES := ps-01-identity ps-02-workflow-engine ps-03-notification-hub \
	ps-04-ai-platform ps-05-integration-hub ps-06-file-storage \
	ps-07-audit-log ps-08-payments ps-09-search ps-10-number

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ── Local development (Docker) ───────────────────────────────────────────────

.PHONY: dev
dev: ## Build + start the entire platform locally (PS-01 :4001 … PS-10 :4010)
	$(COMPOSE_DEV) up --build -d
	@echo "Platform up. Services on http://localhost:4001 … :4010 — try: make smoke"

.PHONY: dev-fg
dev-fg: ## Same as `dev` but stays in the foreground streaming logs
	$(COMPOSE_DEV) up --build

.PHONY: dev-down
dev-down: ## Stop the local platform (keeps data volumes)
	$(COMPOSE_DEV) down

.PHONY: dev-reset
dev-reset: ## Stop and wipe all local data volumes (fresh seeded state next start)
	$(COMPOSE_DEV) down -v

.PHONY: dev-logs
dev-logs: ## Tail logs from every service
	$(COMPOSE_DEV) logs -f

.PHONY: dev-ps
dev-ps: ## Show status + health of every service
	$(COMPOSE_DEV) ps

# ── Verification ─────────────────────────────────────────────────────────────

.PHONY: smoke
smoke: ## Boot every service (no Docker) and run the cross-service smoke test
	node deploy/smoke.mjs

.PHONY: test
test: ## Run every service's test suite + the shared client tests
	@set -e; for s in $(SERVICES); do \
		echo "── platform/$$s"; \
		( cd platform/$$s && npm test --silent ); \
	done; \
	echo "── platform/clients"; \
	( cd platform/clients && npm test --silent )

.PHONY: install
install: ## Install dependencies for every service and the client package
	@set -e; for s in $(SERVICES); do \
		echo "── platform/$$s"; ( cd platform/$$s && npm ci --no-audit --no-fund ); \
	done; \
	echo "── platform/clients"; ( cd platform/clients && npm ci --no-audit --no-fund )

# ── Production reference deployment (Docker + Caddy/TLS) ──────────────────────

.PHONY: prod-up
prod-up: ## Start the production reference stack (needs deploy/.env — see deploy/README.md)
	cd deploy && $(COMPOSE_PROD) up -d --build

.PHONY: prod-down
prod-down: ## Stop the production reference stack
	cd deploy && $(COMPOSE_PROD) down
