#!/usr/bin/env bash
# End-to-end test of install.sh and scripts/radio-bot.sh against a throwaway Git "origin" and a
# fake docker CLI. Linux only (uses util-linux `script` to give the prompts a terminal).
# Run from the repo root: bash tests/lifecycle/run.sh
set -uo pipefail

SRC=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
failures=0
pass() { printf '  ok   %s\n' "$1"; }
fail() {
  printf '  FAIL %s\n' "$1"
  failures=$((failures + 1))
}
check() { # check "description" command...
  local what=$1
  shift
  if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi
}
has() { grep -qF -- "$2" <<<"$1"; }
strip() { sed 's/\x1b\[[0-9;]*m//g'; }

mkdir -p "$T/bin" "$T/state" "$T/home/.local/bin" "$T/origin"
cp "$SRC/tests/lifecycle/fake-docker" "$T/bin/docker" && chmod +x "$T/bin/docker"
# A release-tagged copy of the working tree stands in for GitHub.
(cd "$SRC" && { git ls-files; git ls-files --others --exclude-standard; } | sort -u |
  while read -r f; do [ -e "$f" ] && printf '%s\n' "$f"; done | tar -cf - -T -) | tar -xf - -C "$T/origin"
git -C "$T/origin" init -q -b main
git -C "$T/origin" add -A
git -C "$T/origin" -c user.email=t@example.org -c user.name=test commit -qm v1.0.0
git -C "$T/origin" tag v1.0.0

export HOME="$T/home" FAKE_STATE="$T/state" RADIO_BOT_REPO="$T/origin" RADIO_BOT_DIR="$T/home/radio-bot"
export PATH="$T/home/.local/bin:$T/bin:/usr/bin:/bin"
APP=123456789012345678
TOKEN=$(head -c 54 /dev/zero | tr '\0' 'x').abcdef.ghijklmnopqrstuvwx
tty_run() { script -qec "$1" /dev/null | strip; } # stdin is typed into the terminal

echo "install"
out=$(printf 'not-an-id\n%s\nshort\n%s\n' "$APP" "$TOKEN" | tty_run "bash $T/origin/install.sh")
check "reaches online" has "$out" "Radio Bot is online."
check "rejects a bad application id" has "$out" "doesn't look like an Application ID"
check "rejects a bad token" has "$out" "doesn't look like a bot token"
check "falls back to building" has "$out" "building it on this machine"
check "prints the invite link" has "$out" "client_id=$APP&scope=bot%20applications.commands&permissions=281474979908608"
check "checks out the release" test "$(git -C "$RADIO_BOT_DIR" describe --tags --exact-match)" = v1.0.0
check "writes the application id" grep -qx "DISCORD_APPLICATION_ID=$APP" "$RADIO_BOT_DIR/.env"
check "writes the token" grep -qxF "DISCORD_TOKEN=$TOKEN" "$RADIO_BOT_DIR/.env"
check ".env is private" test "$(stat -c %a "$RADIO_BOT_DIR/.env")" = 600
check "adds the shortcut" test -x "$HOME/.local/bin/radio-bot"

echo "status, invite, version"
out=$(radio-bot status 2>&1 | strip)
# shellcheck disable=SC2016 # $1 expands inside the child shell
check "status shows version and health" bash -c 'grep -q "Version:  v1.0.0" <<<"$1" && grep -q "healthy: ok" <<<"$1"' _ "$out"
check "invite prints the link" test "$(radio-bot invite)" = \
  "https://discord.com/oauth2/authorize?client_id=$APP&scope=bot%20applications.commands&permissions=281474979908608"

echo "update"
out=$(radio-bot update 2>&1 | strip)
check "nothing to do on the newest release" has "$out" "Already on the newest version (v1.0.0)."
echo "# next" >>"$T/origin/CHANGELOG.md"
git -C "$T/origin" -c user.email=t@example.org -c user.name=test commit -qam v1.0.1
git -C "$T/origin" tag v1.0.1
git -C "$T/origin" tag v1.1.0-rc.1
out=$(FAKE_PULL_OK=1 radio-bot update 2>&1 | strip)
check "backs up before updating" has "$out" "Backing up the database first"
check "downloads the published image" has "$out" "Image downloaded."
check "skips pre-releases" test "$(radio-bot version)" = v1.0.1
check "reports the update" has "$out" "Updated v1.0.0 → v1.0.1"
echo "local edit" >>"$RADIO_BOT_DIR/README.md"
out=$(radio-bot update 2>&1 | strip)
check "refuses to update over edited files" has "$out" "were edited"
git -C "$RADIO_BOT_DIR" checkout -q -- .

echo "backup and crash detection"
out=$(radio-bot backup 2>&1 | strip)
check "copies backups out" test -f "$RADIO_BOT_DIR/backups/radio-bot-manual-x.sqlite"
out=$(FAKE_CRASH=1 radio-bot restart 2>&1 | strip)
check "explains a crash on start" has "$out" "stopped while starting"
check "shows the bot's error" has "$out" "invalid token"
check "restart recreates the container, so .env changes apply"   grep -q "docker compose up -d --force-recreate radio-bot$" "$T/state/calls.log"
rm -f "$T/state/restarts"
out=$(FAKE_COMPOSE_VERSION=2.20.3 radio-bot status 2>&1 | strip)
check "refuses Compose older than 2.24" has "$out" "Docker Compose 2.20 is too old"

echo "restore"
touch "$HOME/old.sqlite"
out=$(cd "$HOME" && printf 'y
' | tty_run "radio-bot restore old.sqlite")
check "restores a file named relative to the current folder" has "$out" "Restored."
check "mounts the chosen file" grep -qF "$HOME/old.sqlite:/restore.sqlite:ro" "$T/state/calls.log"

echo "reinstall"
out=$(tty_run "bash $T/origin/install.sh" </dev/null)
check "keeps existing settings" has "$out" "Using your existing settings"

echo "uninstall"
out=$(printf 'y\ny\nn\n' | tty_run "radio-bot uninstall")
check "uninstalls" has "$out" "Radio Bot is uninstalled."
check "keeps the data volume when asked" has "$out" "Keeping the data volume"
# shellcheck disable=SC2016
check "saves a data copy" bash -c 'ls "$1"/radio-bot-backup-*/radio-bot-manual-x.sqlite' _ "$HOME"
# shellcheck disable=SC2016
check "keeps earlier backups from the deleted folder"   bash -c 'ls "$1"/radio-bot-backup-*/earlier-backups/radio-bot-manual-x.sqlite' _ "$HOME"
check "removes the folder" test ! -e "$RADIO_BOT_DIR"
check "removes the shortcut" test ! -e "$HOME/.local/bin/radio-bot"
check "removes container and image" grep -q "docker compose down --rmi all --remove-orphans$" "$T/state/calls.log"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all lifecycle checks passed"
