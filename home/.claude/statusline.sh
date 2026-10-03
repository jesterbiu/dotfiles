#!/usr/bin/env bash

input=$(cat)

fmt() {
  awk -v n="$1" 'BEGIN{ if (n>=1000000) printf "%gM", n/1000000; else printf "%dk", (n+500)/1000 }'
}

model=$(jq -r '.model.display_name // "?"' <<<"$input")
effort=$(jq -r '.effort.level // empty' <<<"$input")
cwd=$(jq -r '.workspace.current_dir // .cwd // empty' <<<"$input")
size=$(jq -r '.context_window.context_window_size // 200000' <<<"$input")
used=$(jq -r '.context_window.current_usage // empty
  | (.input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens)' <<<"$input")
window=$(jq -r '.autoCompactWindow // empty' ~/.claude/settings.json 2>/dev/null)

threshold=$(( ${window:-$size} < size ? ${window:-$size} : size ))

reset=$'\e[0m' bold=$'\e[1m' dim=$'\e[2m'
magenta=$'\e[35m' blue=$'\e[34m' green=$'\e[32m' yellow=$'\e[33m' red=$'\e[31m'
sep=" ${dim}│${reset} "

left="${bold}${magenta}${model}${reset}"
[ -n "$effort" ] && left="$left ${magenta}(${effort})${reset}"
[ -n "$cwd" ] && left="$left$sep${blue}${cwd/#"$HOME"/"~"}${reset}"

if [ -n "$used" ]; then
  pct=$(( used * 100 / threshold ))
  color=$green
  (( pct >= 50 )) && color=$yellow
  (( pct >= 80 )) && color=$red
  right="${color}$(fmt "$used") / $(fmt "$threshold") (${pct}%)${reset}"
else
  right="${dim}– / $(fmt "$threshold")${reset}"
fi

printf '%s%s%s\n' "$left" "$sep" "$right"
