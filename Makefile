TS_LIBS_DIR  := src/typescript/lib

.PHONY: publish publish-lexicons publish-npm publish-jsr bump lex check-auth check-auth-goat check-auth-npm

publish: check-auth lex publish-lexicons publish-npm

check-auth: check-auth-goat check-auth-npm

check-auth-goat:
	@echo "Checking goat auth..."
	@goat account check-auth || (echo "ERROR: not logged in to atproto — run: goat account login" && exit 1)

check-auth-npm:
	@echo "Checking npm auth..."
	@deno run -A npm:npm whoami 2>/dev/null || (echo "ERROR: not logged in to npm — run: deno run -A npm:npm login" && exit 1)

# Sync every lexicon JSON that exists inside a lib package from the root lexicons/ dir.
# The package's existing files define what it owns; root is the source of truth for content.
lex:
	@cd src/typescript/lib/lexicons/ && deno x -A -y npm:npm run build

bump:
	@deno run --allow-read --allow-write scripts/makefile/bump/main.ts $(TS_LIBS_DIR)

publish-lex:
	@echo "Publishing lexicons..."
	@goat lex publish --update

publish-npm: lex
	@echo "Publishing npm packages..."
	@find $(TS_LIBS_DIR) -maxdepth 2 -name 'package.json' | \
		sort | while read pkg; do \
			priv=$$(deno eval "console.log(JSON.parse(Deno.readTextFileSync(Deno.args[0])).private ? 1 : 0)" "$$pkg"); \
			[ "$$priv" = "0" ] || continue; \
			dir=$$(dirname "$$pkg"); \
			echo "  deno run -A npm:npm publish $$dir"; \
			deno run -A npm:npm publish "$$dir" --access public $(if $(NPM_OTP),--otp=$(NPM_OTP),); \
		done

# ── JSR publishing (dependency order) ─────────────────────────────────────

JSR_FLAGS := --allow-slow-types --allow-dirty --no-check $(if $(JSR_TOKEN),--token $(JSR_TOKEN),)

# Tier 0 — leaf packages (no @publicdomainrelay jsr deps)
publish-jsr-tier0:
	@echo "=== JSR Tier 0 (leaf) ==="
	cd src/typescript/lib/lexicons                     && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/atproto-attestation-port     && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/did-plc                      && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/event-bus                    && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/xrpc-relay                   && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/hono-factory-xrpc-subscriber && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/utils-log                    && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/utils-attestation-key        && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/atproto-helpers              && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/deno-hono-helpers            && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/hono-factory-market          && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/hono-factory-market-bids     && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/hono-factory-compute         && deno publish $(JSR_FLAGS)

# Tier 1 — depends on tier 0
publish-jsr-tier1:
	@echo "=== JSR Tier 1 ==="
	cd src/typescript/lib/compute-provider-digitalocean && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/market                        && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/hono-factory-atproto-repo     && deno publish $(JSR_FLAGS)

# Tier 2 — depends on tier 0-1
publish-jsr-tier2:
	@echo "=== JSR Tier 2 ==="
	cd src/typescript/lib/market-free                     && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/market-x402                     && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/market-settlement               && deno publish $(JSR_FLAGS)
	cd src/typescript/qemu                                && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/hono-factory-compute-provider-local && deno publish $(JSR_FLAGS)

# Tier 3 — depends on tier 0-2
publish-jsr-tier3:
	@echo "=== JSR Tier 3 ==="
	cd src/typescript/lib/hono-factory-ephemeral-compute-bidder && deno publish $(JSR_FLAGS)

# Tier 4 — library app packages (depends on all above)
publish-jsr-tier4:
	@echo "=== JSR Tier 4 (lib apps) ==="
	cd src/typescript/xrpc-relay-pds   && deno publish $(JSR_FLAGS)
	cd src/typescript/market-registry  && deno publish $(JSR_FLAGS)
	cd src/typescript/lib/ssh          && deno publish $(JSR_FLAGS)

# Tier 5 — service entrypoints (runnable via `deno run -A jsr:...`)
publish-jsr-tier5:
	@echo "=== JSR Tier 5 (services) ==="
	cd src/typescript/spindle && deno publish $(JSR_FLAGS)
	cd src/typescript/bidder  && deno publish $(JSR_FLAGS)

# Publish ALL packages to JSR in correct dependency order.
# Requires: deno authenticated with JSR (run `deno publish` interactively once,
# or set DENO_AUTH_TOKENS / pass --token).
publish-jsr: publish-jsr-tier0 publish-jsr-tier1 publish-jsr-tier2 publish-jsr-tier3 publish-jsr-tier4 publish-jsr-tier5
	@echo "=== All packages published to JSR ==="
