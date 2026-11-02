#!/usr/bin/env bash
# Radio Bot one-line installer for Linux and macOS:
#   curl -fsSL https://raw.githubusercontent.com/DangerMouseUK/radiobot/main/install.sh | bash
# It downloads Radio Bot into ~/radio-bot (set RADIO_BOT_DIR to change that) and hands over to
# scripts/radio-bot.sh, which asks for your Discord details and starts the bot with Docker.
# RADIO_BOT_VERSION=vX.Y.Z installs a particular release instead of the newest one.
set -euo pipefail

main() {
  local repo=${RADIO_BOT_REPO:-https://github.com/DangerMouseUK/radiobot.git}
  local dir=${RADIO_BOT_DIR:-$HOME/radio-bot}

  if ! command -v git >/dev/null 2>&1; then
    echo "Radio Bot needs git. Install it first, for example:" >&2
    echo "  Debian/Ubuntu: sudo apt install git     macOS: xcode-select --install" >&2
    exit 1
  fi
  if [ -f "$dir/scripts/radio-bot.sh" ]; then
    echo "Radio Bot is already in $dir, so this checks that install instead of downloading it again."
  elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    echo "$dir already exists and isn't a Radio Bot install, so nothing was changed." >&2
    echo "Rename that folder and run this again, or set RADIO_BOT_DIR to install somewhere else." >&2
    exit 1
  else
    echo "Downloading Radio Bot into $dir"
    git clone --quiet "$repo" "$dir"
  fi
  # Questions are read from the terminal, since this script's own input is the download.
  if { : </dev/tty; } 2>/dev/null; then
    exec bash "$dir/scripts/radio-bot.sh" install </dev/tty
  fi
  exec bash "$dir/scripts/radio-bot.sh" install
}

# Everything is inside main, so a partly downloaded script never runs.
main "$@"
