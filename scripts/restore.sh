#!/usr/bin/env bash
# tmux-resurrect hook pre-restore-pane-processes: the panes exist again, each
# with a fresh shell. Types `pi --session <file>` into every pane that ran Pi
# at the last save, one pane after another, in the background so the restore
# goes on. A pane is skipped when it does not run the default shell (it was
# not restored but kept, and runs something) or the session file is gone.

option() {
	local value
	value="$(tmux show-option -gqv "$1")"
	printf '%s' "${value:-$2}"
}

# The state directory as tmux-resurrect resolves it.
dir="$(option @resurrect-dir)"
if [ -n "$dir" ]; then
	dir="$(printf '%s' "$dir" | sed "s,\$HOME,$HOME,g; s,\$HOSTNAME,$(hostname),g; s,\~,$HOME,g")"
elif [ -d "$HOME/.tmux/resurrect" ]; then
	dir="$HOME/.tmux/resurrect"
else
	dir="${XDG_DATA_HOME:-$HOME/.local/share}/tmux/resurrect"
fi

lines="$(grep '^pi_session'$'\t' "$dir/last" 2>/dev/null)"
[ -n "$lines" ] || exit 0

command="$(option @pi-resurrect-command pi)"
delay="$(option @pi-resurrect-delay 1)"
shell="$(option default-shell "${SHELL:-sh}")"
shell="${shell##*/}"

quote() {
	printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

(
	printf '%s\n' "$lines" |
		while IFS=$'\t' read -r _ session window pane file; do
			sleep "$delay"
			target="$session:$window.$pane"
			current="$(tmux display-message -p -t "$target" '#{pane_current_command}' 2>/dev/null)" || continue
			[ "${current#-}" = "$shell" ] || continue
			[ -f "$file" ] || continue
			tmux send-keys -t "$target" -l "$command --session $(quote "$file")"
			tmux send-keys -t "$target" Enter
		done
) </dev/null >/dev/null 2>&1 &
