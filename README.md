# tmux-pi-resurrect

Brings [Pi](https://pi.dev) sessions back after tmux restarts, with
[tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect).

tmux-resurrect restores windows, panes, and their directories, but a pane
that ran Pi comes back as a plain shell: Pi was started without arguments, so
nothing tells which conversation it held. This package remembers the session
of every Pi in a pane and starts `pi --session <file>` there when
tmux-resurrect restores, by hand or through
[tmux-continuum](https://github.com/tmux-plugins/tmux-continuum) after a
reboot. Only panes whose Pi was running at the last save get it back.

## Requirements

- tmux 3.0 or newer (pane options)
- tmux-resurrect; tmux-continuum for automatic saves and restores
- Pi, started inside tmux
- bash

## Install

```bash
pi install git:github.com/dandjo/tmux-pi-resurrect
```

The package is a Pi extension and a tmux plugin in one. At its next start
inside tmux, the extension sets up the tmux side by itself:

- It adds a block that loads `pi-resurrect.tmux` to the tmux configuration
  the running server read, before the line that loads tmux-continuum (or
  TPM), and loads it into the running tmux.
- What it cannot do it says once per tmux server, as a warning, and changes
  nothing else: no configuration file, one without write permission,
  tmux-resurrect not loaded, tmux-continuum not active, the hooks already in
  use, or this plugin loaded after tmux-continuum.

Pi sessions that are already running pick the extension up with `/reload`;
from then on they are part of every tmux-resurrect save.

### By hand

Clone the repository where your tmux plugins live and install the same
folder as a Pi package (Pi loads a local package from where it lies):

```bash
git clone https://github.com/dandjo/tmux-pi-resurrect ~/.config/tmux/plugins/tmux-pi-resurrect
pi install ~/.config/tmux/plugins/tmux-pi-resurrect
```

Load it in your tmux configuration **before tmux-continuum**: continuum
restores while tmux still reads its configuration, and a hook set after that
restore is missed.

```tmux
run-shell 'bash ~/.config/tmux/plugins/tmux-pi-resurrect/pi-resurrect.tmux'
```

With [TPM](https://github.com/tmux-plugins/tpm), declare
`set -g @plugin 'dandjo/tmux-pi-resurrect'` before tmux-continuum and install
`~/.tmux/plugins/tmux-pi-resurrect` as the Pi package.

The extension finds that line and adds no second one.

## How it works

1. **Mark** (`extensions/tmux-pane-session.ts`): in Pi's interactive mode
   the extension sets two options on its tmux pane, `@pi-session-file` with
   the session file and `@pi-pid` with its process. They follow `/new`,
   `/resume`, `/fork`, and `/reload`, and are removed when Pi quits.
   Subagents and `pi -p` inherit the pane from the Pi that started them and
   leave its marks alone.
2. **Save** (`scripts/save.sh`, hook `@resurrect-hook-post-save-layout`):
   tmux-resurrect has written its state file; the hook appends one
   `pi_session` line for every marked pane whose Pi still runs.
   tmux-resurrect ignores line types it does not know, and compares the
   whole file with the last save, so a changed session counts as a change.
3. **Restore** (`scripts/restore.sh`, hook
   `@resurrect-hook-pre-restore-pane-processes`): the panes exist again,
   each with a fresh shell. In the background, one pane after another, the
   hook types `pi --session '<file>'` and Enter into each pane of the last
   save that runs the default shell, if the session file still exists.

Pi starts inside the pane's shell, as when you start it by hand: quitting
Pi leaves you in the shell.

## Options

```tmux
set -g @pi-resurrect-command 'pi'   # command that starts Pi
set -g @pi-resurrect-delay '1'      # seconds before each start
```

The delay spreads the starts, so a dozen sessions do not load at once.

## What comes back

The conversation of each session, in the pane it ran in. Work that was in
progress when tmux went down does not continue, and anything Pi or its
extensions kept only in memory is gone; ask the session to go on.

## Notes

- A pane where Pi was ended before the save stays a shell. The last save
  counts: with tmux-continuum it is at most 15 minutes old; prefix + Ctrl-s
  saves at once.
- A manual restore (prefix + Ctrl-r) also starts Pi in a kept pane that runs
  the default shell and ran Pi at the last save.
- Do not add Pi to `@resurrect-processes`: tmux-resurrect would start a
  second, empty Pi in the same pane.
- If `@resurrect-hook-post-save-layout` or
  `@resurrect-hook-pre-restore-pane-processes` already runs something else,
  the plugin leaves it alone; call `bash scripts/save.sh "$1"` (with the
  state file) or `bash scripts/restore.sh` from your own hook.

## Uninstall

```bash
pi remove git:github.com/dandjo/tmux-pi-resurrect
tmux set -gu @resurrect-hook-post-save-layout
tmux set -gu @resurrect-hook-pre-restore-pane-processes
```

The block in the tmux configuration does nothing once the package is gone
(it checks that the file exists); delete it when you like.

## License

MIT
