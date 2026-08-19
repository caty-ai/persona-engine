.PHONY: test lint

node_modules: package-lock.json
	npm ci

test: node_modules
	npm run build --workspace @persona-engine/core
	npm test

lint: node_modules
	npm run typecheck
