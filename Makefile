# Every check the release workflow runs on a develop -> main pull request, run
# the same way here first. CI's runner has Node 22 already; locally mise gives it.
RUN := $(if $(CI),,mise exec node@22 --)
MANIFEST := plugins/auto-effort-control/.claude-plugin/plugin.json
# The manifest path before the rename to auto-effort-control: the base when main still has only it.
OLD_MANIFEST := plugins/auto-effort/.claude-plugin/plugin.json

.PHONY: release-check check release

release-check: check release

# Locally validate:plugin reads a scratch config, never the live one (CLAUDE.md § Commands).
check:
	$(RUN) npm ci
	$(RUN) npm test
	$(RUN) npm run typecheck
	$(RUN) npm run release:check
	$(if $(CI),,CLAUDE_CONFIG_DIR=$$(mktemp -d)) CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 $(RUN) npm run validate:plugin

# Run `git fetch origin main` first: the version must move past main's.
release:
	@git rev-parse --verify -q origin/main >/dev/null || { echo "origin/main is missing from the checkout"; exit 1; }
	@v=$$($(RUN) node -p 'require("./$(MANIFEST)").version'); \
	case "$$v" in *-*) echo "FAIL $$v is a pre-release: every merge into main publishes, so the release version carries no -suffix"; exit 1 ;; esac
	base=$$(for m in "$(MANIFEST)" "$(OLD_MANIFEST)"; do if git cat-file -e "origin/main:$$m" 2>/dev/null; then git show "origin/main:$$m" | $(RUN) node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version'; exit; fi; done; echo "main has neither $(MANIFEST) nor $(OLD_MANIFEST): treating this as the first release" >&2; echo 0.0.0) && \
	$(RUN) scripts/release-check.sh "$$base"
	v=$$($(RUN) node -p 'require("./$(MANIFEST)").version'); \
	v_re=$$(printf '%s' "$$v" | sed 's/[.]/[.]/g'); \
	awk -v v="$$v_re" '$$0 ~ "^## \\[" v "\\]" {f=1; next} /^## \[/ || /^\[/ {f=0} f' CHANGELOG.md | grep -q '' || { echo "FAIL CHANGELOG.md section for $$v yields no release notes"; exit 1; }
