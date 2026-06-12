TS_LIBS_DIR  := src/typescript/lib

.PHONY: publish publish-lexicons publish-npm bump lex check-auth check-auth-goat check-auth-npm

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
