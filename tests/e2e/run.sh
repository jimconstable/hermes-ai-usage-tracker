#!/usr/bin/env bash
# Isolated browser demo: a throwaway Hermes gateway serving the real Webapp from FIXTURE profiles.
#
#   tests/e2e/run.sh <empty-work-dir> <hermes-agent-checkout> <directsdk-plugin-dir> [port]
#
# Runs `hermes gateway run` in the foreground with a clean environment (env -i): HOME and
# HERMES_HOME point inside <work-dir>, so no real profile, credential, kanban board or service is
# touched. Hermes prepares a private runtime venv for that data root; this script drops a .pth
# into it that loads shim/fixture_network.py (answers openrouter.ai / chatgpt.com with FIXTURE
# data, blocks every other outbound host). In another shell, get the one-use sign-in link with:
#
#   tests/e2e/run.sh --link <work-dir> <hermes-agent-checkout>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

isolated() {  # isolated <work-dir> <checkout> <hermes args...>
  local work="$1" agent="$2"; shift 2
  env -i PATH=/usr/bin:/bin HOME="$work/home" HERMES_HOME="$work/home/.hermes" "$agent/venv/bin/hermes" "$@"
}

if [[ "${1:-}" == "--link" ]]; then
  WORK="$(cd "$2" && pwd)"
  isolated "$WORK" "$3" webapp --no-open --skip-build
  exit
fi

WORK="$(cd "$1" && pwd)"; AGENT="$2"; DIRECTSDK="$3"; PORT="${4:-9241}"
python3 "$HERE/setup_home.py" "$WORK" "$DIRECTSDK" "$PORT"
isolated "$WORK" "$AGENT" profile list         # builds the data root's private runtime venv; lists the fixtures
shopt -s nullglob
sites=("$WORK"/home/.hermes/installs/*/environments/*/venv/lib/python*/site-packages)
(( ${#sites[@]} )) || { echo "no isolated runtime venv under $WORK/home/.hermes/installs" >&2; exit 1; }
for site in "${sites[@]}"; do
  printf '%s\nimport fixture_network\n' "$HERE/shim" > "$site/ai_usage_e2e_fixtures.pth"
  echo "fixture network installed: $site/ai_usage_e2e_fixtures.pth"
done
exec env -i PATH=/usr/bin:/bin HOME="$WORK/home" HERMES_HOME="$WORK/home/.hermes" \
  "$AGENT/venv/bin/hermes" gateway run
