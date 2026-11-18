#!/usr/bin/env bash
# tmux-resurrect hook post-save-layout; $1 is the state file just written.
# Appends a line for every pane whose Pi is running:
#   pi_session <TAB> session <TAB> window <TAB> pane <TAB> session file
# tmux-resurrect skips line types it does not know, and compares the whole
# file with the last save, so a changed Pi session counts as a change.

state="$1"
[ -n "$state" ] && [ -f "$state" ] || exit 0

d=$'\t'
format="#{?#{@pi-session-file},#{session_name}${d}#{window_index}${d}#{pane_index}${d}#{@pi-pid}${d}#{@pi-session-file},}"

tmux list-panes -a -F "$format" |
	while IFS="$d" read -r session window pane pid file; do
		[ -n "$file" ] && [ -n "$pid" ] || continue
		kill -0 "$pid" 2>/dev/null || continue
		printf 'pi_session\t%s\t%s\t%s\t%s\n' "$session" "$window" "$pane" "$file"
	done >>"$state"
