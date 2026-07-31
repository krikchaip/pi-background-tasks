#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
extension="$repo_root/extensions/background-tasks.ts"
scripted_provider="$repo_root/tests/scripted-provider/scripted-provider-extension.ts"
kitty_bin=$(command -v kitty)
work_root=$(mktemp -d /tmp/pi-bg-kitty-e2e.XXXXXX)

cleanup() {
  if [[ -f "$work_root/kitty.sockets" ]]; then
    while read -r socket_path; do
      if [[ -S "$socket_path" ]]; then kitty @ --to "unix:$socket_path" quit >/dev/null 2>&1 || true; fi
    done < "$work_root/kitty.sockets"
  fi
  if [[ -f "$work_root/kitty.pids" ]]; then
    while read -r pid; do kill -KILL "$pid" 2>/dev/null || true; done < "$work_root/kitty.pids"
    while read -r pid; do wait "$pid" 2>/dev/null || true; done < "$work_root/kitty.pids"
  fi
  if [[ -f "$work_root/tmux.sessions" ]]; then
    while read -r session; do tmux kill-session -t "$session" 2>/dev/null || true; done < "$work_root/tmux.sessions"
  fi
  rm -rf "$work_root"
}
trap cleanup EXIT

run_case() {
  local columns=$1
  local case_dir="$work_root/$columns"
  local session="pi-bg-kitty-e2e-${columns}-$$"
  local socket_path="$case_dir/kitty.socket"
  local socket="unix:$socket_path"
  local kitty_pid=
  mkdir -p "$case_dir/cwd" "$case_dir/agent"
  printf '%s\n' "$socket_path" >> "$work_root/kitty.sockets"
  printf '{}\n' > "$case_dir/agent/settings.json"

  finish_case() {
    if [[ -S "$socket_path" ]]; then kitty @ --to "$socket" quit >/dev/null 2>&1 || true; fi
    if [[ -n "${kitty_pid:-}" ]]; then kill "$kitty_pid" 2>/dev/null || true; fi
    if [[ -n "${session:-}" ]]; then tmux kill-session -t "$session" 2>/dev/null || true; fi
  }

  tmux new-session -d -x "$columns" -y 40 -s "$session" zsh
  printf '%s\n' "$session" >> "$work_root/tmux.sessions"
  tmux set-option -t "$session" remain-on-exit on
  tmux set-option -t "$session" window-size manual
  tmux resize-window -t "$session" -x "$columns" -y 40

  "$kitty_bin" --config NONE --start-as=hidden --listen-on="$socket" \
    --override allow_remote_control=socket-only \
    --override background=#24283b \
    --override background_opacity=0.90 \
    /usr/bin/env -u TMUX -u TMUX_PANE tmux attach-session -t "$session" \
    >"$case_dir/kitty.log" 2>&1 &
  kitty_pid=$!
  printf '%s\n' "$kitty_pid" >> "$work_root/kitty.pids"
  for _ in $(seq 1 80); do [[ -S "$socket_path" ]] && break; sleep 0.1; done
  [[ -S "$socket_path" ]] || { cat "$case_dir/kitty.log" >&2; return 1; }

  local pi_command="cd '$case_dir/cwd' && env TERM=tmux-256color COLORTERM=truecolor PI_OFFLINE=1 PI_CODING_AGENT_DIR='$case_dir/agent' PI_BG_SCRIPTED_SCENARIO=multiline-command PI_BG_SCRIPTED_API_KEY=test-key pi --offline --provider pi-bg-scripted --model scripted-model --no-session --no-context-files --no-prompt-templates --no-themes --no-extensions --no-skills --no-builtin-tools -e '$scripted_provider' -e '$extension'"
  tmux send-keys -t "$session" "$pi_command" Enter

  wait_for() {
    local needle=$1 attempts=${2:-80}
    for ((i=0; i<attempts; i++)); do
      if tmux capture-pane -p -t "$session" | grep -Fq "$needle"; then return 0; fi
      sleep 0.2
    done
    echo "timeout waiting for $needle at ${columns} columns" >&2
    tmux capture-pane -p -t "$session" >&2 || true
    return 1
  }

  # The scripted provider's context limit changes across Pi releases. The usage prefix
  # confirms the interactive footer has rendered without tying this UI test to that limit.
  wait_for "0.0%/"
  for i in $(seq -w 1 18); do
    tmux send-keys -t "$session" "/bg --name 'UNDERLAY ROW $i' printf 'UNDERLAY-ROW-$i'" Enter
    sleep 0.18
  done
  tmux send-keys -t "$session" "Start the multiline bleed probe." Enter
  wait_for "started Multiline Bleed"
  sleep 0.5
  tmux capture-pane -p -N -t "$session" > "$case_dir/backdrop.txt"
  tmux send-keys -t "$session" "/bg-tasks" Enter
  wait_for "bg tasks focused"
  tmux send-keys -t "$session" Enter
  wait_for "Output tail:"
  sleep 1

  tmux capture-pane -p -N -t "$session" > "$case_dir/screen.txt"
  tmux capture-pane -p -N -e -t "$session" > "$case_dir/screen.ansi"
  kitty @ --to "$socket" get-colors > "$case_dir/colors.txt"
  kitty @ --to "$socket" ls > "$case_dir/kitty-state.json"

  SCREEN_COLUMNS="$columns" CASE_DIR="$case_dir" python3 <<'PY'
from pathlib import Path
import json, os, re
columns = int(os.environ['SCREEN_COLUMNS'])
case_dir = Path(os.environ['CASE_DIR'])
box = min(columns, 118)
left = (columns - box) // 2
right = columns - box - left
lines = (case_dir / 'screen.txt').read_text().splitlines()
backdrop = (case_dir / 'backdrop.txt').read_text().splitlines()
ansi = (case_dir / 'screen.ansi').read_text(errors='replace').splitlines()
colors = (case_dir / 'colors.txt').read_text()
state = json.loads((case_dir / 'kitty-state.json').read_text())
opacities = [window['background_opacity'] for window in state]
if not opacities or not all(0 < value < 1 for value in opacities):
    raise SystemExit(f'FAIL Kitty transparency is not active: {opacities}')
m = re.search(r'^background\s+#([0-9a-fA-F]{6})$', colors, re.M)
if not m: raise SystemExit('FAIL missing Kitty default background')
default_rgb = tuple(bytes.fromhex(m.group(1)))
top = next(i for i, line in enumerate(lines) if '╭' in line and '─' in line)
bottom = next(i for i in range(top + 1, len(lines)) if '╰' in lines[i] and '─' in lines[i])
if lines[top].find('╭') != left:
    raise SystemExit(f'FAIL styled dock is not centered: expected column {left + 1}, row={lines[top]!r}')
preserved_gutters = 0
if columns > box:
    for i in range(top, bottom + 1):
        before = backdrop[i].ljust(columns)
        after = lines[i].ljust(columns)
        before_gutters = (before[:left], before[columns - right:] if right else '')
        after_gutters = (after[:left], after[columns - right:] if right else '')
        for before_gutter, after_gutter in zip(before_gutters, after_gutters):
            if before_gutter.strip():
                preserved_gutters += 1
                if after_gutter != before_gutter:
                    raise SystemExit(f'FAIL backdrop changed beside dock at row {i + 1}: before={before_gutter!r}, after={after_gutter!r}')
    if preserved_gutters == 0:
        raise SystemExit('FAIL E2E fixture has no visible backdrop beside dock')
ansi_top = ansi[top]
rgb_values = [tuple(map(int, groups)) for groups in re.findall(r'\x1b\[48;2;(\d+);(\d+);(\d+)m', ansi_top)]
dock_rgb = next((rgb for rgb in rgb_values if rgb != default_rgb and sum(abs(a-b) for a,b in zip(rgb, default_rgb)) <= 1), None)
if dock_rgb is None: raise SystemExit(f'FAIL opaque blended dock truecolor background missing: {rgb_values}')
joined = '\n'.join(lines[top:bottom + 1])
for token in ('BLEED-PROBE-', 'cursor-safe', 'OSC-safe', 'DCS-safe'):
    if token not in joined: raise SystemExit(f'FAIL safe task output missing: {token}')
for token in ('SECRET-OSC', 'SECRET-DCS'):
    if token in joined: raise SystemExit(f'FAIL terminal control payload leaked: {token}')
if columns >= 118 and "python3 -u -c 'import sys, time for i in range(120):" not in joined:
    raise SystemExit('FAIL multiline command was not normalized into its dock row')
print(f'PASS Kitty opacity + tmux + Pi at {columns} columns: default={default_rgb}, opaque dock={dock_rgb}, frame={box}')
PY

  finish_case
}

run_case 140
run_case 44
