# dotfiles

Snapshot of agent, terminal, and shell settings. The live files stay in `$HOME`. The repo gets a copy only when you run `sync`.

```
$HOME ──sync──▶ home/<path> ──agent audits git diff──▶ commit, push
```

## Usage

```sh
./sync              # rebuild home/ from $HOME; no git actions
git diff            # audit, then commit and push
test/sync.test.sh   # tests run against a temporary $HOME
```

`sync` checks all paths before it copies. If a check fails, it names the path and leaves `home/` unchanged. If all checks pass, it builds a new `home/` and replaces the old one, so paths removed from the manifest disappear.

## Rules

- `manifest` is the allowlist. One path per line, relative to `$HOME`. A directory entry includes all files in it, also future files. If a directory can contain files that must not be published, list its files one by one.
- `distill/<path>` is an optional executable filter for a manifest file. `sync` sends the live file through it on stdin and writes stdout to `home/<path>`.
- Pi `packages` and `extensions`:
  - An `npm:` or `git:` entry is third party. The settings entry is enough.
  - A local path is our own code. `sync` resolves it from `~/.pi/agent` and stops with an error if no manifest entry covers it.

## Distill filters

| File | Kept |
|---|---|
| `.codex/config.toml` | `[tui]` and its sub-tables, without `screen_reader_detection_done` and `[tui.model_availability_nux]` |
| `.pi/agent/settings.json` | `theme`, `quietStartup`, `hideThinkingBlock`, `packages`, `extensions` |
| `.zshrc` | All lines except `PATH=` lines and the comment directly above them. Installers add the PATH lines. |

Machine-specific shell settings, such as the proxy, go in `~/.zshrc.local`. `.zshrc` sources it, and the repo does not track it.

## Restore

Copy `home/` to `$HOME`, then:

```sh
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
systemctl --user daemon-reload
systemctl --user enable --now tmux-work.service tmux-work-save.timer
tmux -L work run-shell '~/.tmux/plugins/tpm/bin/install_plugins'
```

For the mdreview server, see `home/.agent/skills/mdreview/README.md`.
