.DEFAULT_GOAL := help
.PHONY: help install dev migrate test lint typecheck check build docker-build

help: ## Список команд
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.env:
	@echo "Немає файлу .env. Створіть його: cp .env.example .env"; exit 1

install: ## Встановити залежності точно за package-lock.json
	npm ci

dev: .env ## Запустити сервіс на :3003 з перезапуском при змінах (потрібен make up у platform)
	npm run dev

migrate: .env ## Застосувати міграції бази timetable (роль timetable_owner)
	npm run migrate:dev

test: ## Усі тести з покриттям; PostgreSQL і Kafka піднімаються самі (потрібен запущений Docker)
	npm test

lint: ## ESLint
	npm run lint

typecheck: ## Перевірка типів TypeScript
	npm run typecheck

check: lint typecheck test ## Усе, що перевіряє CI

build: ## Зібрати dist/
	npm run build

docker-build: ## Зібрати образ timetable-service:dev
	docker build -t timetable-service:dev .
