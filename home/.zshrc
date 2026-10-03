export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="robbyrussell"
plugins=(git)
source $ZSH/oh-my-zsh.sh

alias edsrc="nvim ~/.zshrc"
alias resrc="source ~/.zshrc"

# Use the logout-safe, systemd-managed tmux server interactively.
alias tmux="$HOME/.local/bin/tmux-work"
_tmux-work() {
  local -x TMUX=${TMUX_TMPDIR:-/tmp}/tmux-$UID/work,0,0
  words[1]=tmux
  _tmux
}
compdef _tmux-work tmux-work

[[ -f ~/.zshrc.local ]] && source ~/.zshrc.local
