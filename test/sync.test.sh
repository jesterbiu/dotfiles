#!/usr/bin/env bash
set -uo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
failures=0

fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }
assert_file() { [ -f "$1" ] || fail "missing $1"; }
assert_absent() { [ ! -e "$1" ] || fail "unexpected $1"; }
assert_content() { [ "$(cat "$1" 2>/dev/null)" = "$2" ] || fail "$1: got '$(cat "$1" 2>/dev/null)', want '$2'"; }

setup() {
  work=$(mktemp -d)
  export HOME=$work/home
  fake=$work/repo
  mkdir -p "$HOME" "$fake"
  cp "$repo/sync" "$fake/sync"
}

run_sync() { "$fake/sync" >"$work/out" 2>&1; }

pi_settings() { mkdir -p "$HOME/.pi/agent" && printf '%s' "$1" > "$HOME/.pi/agent/settings.json"; }

test_snapshot_follows_manifest() {
  setup
  mkdir -p "$HOME/.app/skill/lib" "$HOME/src/ext" "$HOME/src/mod" "$HOME/.pi/agent"
  echo conf > "$HOME/.app/conf"
  echo secret > "$HOME/.app/auth.json"
  echo code > "$HOME/.app/skill/lib/a.js"
  printf '#!/bin/sh\n' > "$HOME/.app/run.sh" && chmod +x "$HOME/.app/run.sh"
  echo ext > "$HOME/src/ext/index.ts"
  echo mod > "$HOME/src/mod/index.ts"
  echo ui > "$HOME/src/mod/ui.mjs"
  echo one > "$HOME/src/one.ts"
  echo other > "$HOME/src/other.ts"
  printf 'keep\ndrop\n' > "$HOME/.rc"
  pi_settings '{"packages":["npm:pi-vim@1",{"source":"../../src/ext"}],"extensions":["../../src/ext/index.ts","../../src/mod/index.ts","../../src/one.ts"]}'
  printf '.app/conf\n.app/skill\n.app/run.sh\n\n.rc\n' > "$fake/manifest"
  mkdir -p "$fake/distill" && printf '#!/bin/sh\ngrep -v drop\n' > "$fake/distill/.rc" && chmod +x "$fake/distill/.rc"

  run_sync || fail "first sync: $(cat "$work/out")"
  assert_content "$fake/home/.app/conf" conf
  assert_content "$fake/home/.app/skill/lib/a.js" code
  assert_content "$fake/home/src/ext/index.ts" ext
  assert_content "$fake/home/src/mod/ui.mjs" ui
  assert_content "$fake/home/src/one.ts" one
  assert_absent "$fake/home/src/other.ts"
  assert_content "$fake/home/.rc" keep
  assert_absent "$fake/home/.app/auth.json"
  assert_absent "$fake/home/.pi"
  [ -x "$fake/home/.app/run.sh" ] || fail "run.sh lost exec bit"

  rm "$HOME/.app/skill/lib/a.js"
  echo new > "$HOME/.app/skill/b.js"
  printf '.app/conf\n.app/skill\n' > "$fake/manifest"

  run_sync || fail "second sync: $(cat "$work/out")"
  assert_absent "$fake/home/.app/skill/lib/a.js"
  assert_content "$fake/home/.app/skill/b.js" new
  assert_absent "$fake/home/.app/run.sh"
  assert_absent "$fake/home/.rc"
}

test_failed_check_names_path_and_keeps_snapshot() {
  setup
  echo conf > "$HOME/.conf"
  printf '.conf\n' > "$fake/manifest"
  run_sync || fail "baseline sync: $(cat "$work/out")"

  echo changed > "$HOME/.conf"
  printf '.conf\n.missing\n' > "$fake/manifest"
  run_sync && fail "sync passed with missing path"
  grep -q '\.missing' "$work/out" || fail "missing path not named: $(cat "$work/out")"
  assert_content "$fake/home/.conf" conf

  printf '.conf\n' > "$fake/manifest"
  pi_settings '{"packages":["npm:ok@1"],"extensions":["../../src/gone/index.ts"]}'
  run_sync && fail "sync passed with missing Pi path"
  grep -q 'src/gone' "$work/out" || fail "missing Pi path not named: $(cat "$work/out")"
  assert_content "$fake/home/.conf" conf
}

test_repo_filters() {
  setup
  cat > "$work/codex" <<'EOF'
model = "m"

[tui]
vim_mode_default = true
screen_reader_detection_done = true

[tui.keymap.editor]
insert_newline = ["enter"]

[tui.model_availability_nux]
"m" = 4

[projects."/home/u"]
trust_level = "trusted"
EOF
  assert_content <("$repo/distill/.codex/config.toml" < "$work/codex") '[tui]
vim_mode_default = true

[tui.keymap.editor]
insert_newline = ["enter"]'

  echo '{"theme":"dark","defaultModel":"m","lastChangelogVersion":"1","packages":["npm:x"]}' > "$work/pi"
  assert_content <("$repo/distill/.pi/agent/settings.json" < "$work/pi" | jq -c .) '{"theme":"dark","packages":["npm:x"]}'

  printf 'a=1\n\n# installer\nexport PATH="$HOME/bin:$PATH"\n\n# keep\nb=2\n\n' > "$work/zshrc"
  assert_content <("$repo/distill/.zshrc" < "$work/zshrc") 'a=1

# keep
b=2'
}

for t in $(declare -F | awk '$3 ~ /^test_/ {print $3}'); do
  before=$failures
  "$t"
  [ "$failures" -eq "$before" ] && echo "ok   $t" || echo "FAIL $t"
  rm -rf "$work"
done
[ "$failures" -eq 0 ]
