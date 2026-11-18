#!/usr/bin/env bash
# tmux-pi-resurrect: restores Pi sessions with tmux-resurrect.
# Hooks the two scripts into tmux-resurrect; a hook set to something else is
# left alone, with a message how to combine both. Load it before
# tmux-continuum: continuum restores while tmux still reads its configuration,
# and a hook set after that restore is missed.

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

set_hook() {
	local option="$1" script="$2" current command
	command="bash $(printf '%q' "$CURRENT_DIR/scripts/$script")"
	current="$(tmux show-option -gqv "$option")"
	if [ -n "$current" ] && [[ "$current" != *pi-resurrect* ]]; then
		tmux display-message "tmux-pi-resurrect: $option is already set; call $CURRENT_DIR/scripts/$script from it"
		return
	fi
	tmux set-option -g "$option" "$command"
}

set_hook @resurrect-hook-post-save-layout save.sh
set_hook @resurrect-hook-pre-restore-pane-processes restore.sh
