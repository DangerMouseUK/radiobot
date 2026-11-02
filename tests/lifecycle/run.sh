#!/usr/bin/env bash
# End-to-end test of install.sh and scripts/radio-bot.sh against a throwaway Git "origin" and a
# fake docker CLI. Runs on Linux and macOS (where CI runs it with the system's bash 3.2: every
# `bash` below is the first one on PATH, so /bin/bash there). `script` gives the prompts a terminal.
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
strip() { sed $'s/\033\\[[0-9;]*m//g; s/\r$//'; } # colours and the terminal's carriage returns
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; } # GNU, then BSD
days_ago() { # touch -t time stamp for $1 days ago: GNU date, then BSD date
  date -d "$1 days ago" +%Y%m%d%H%M 2>/dev/null || date -v-"$1"d +%Y%m%d%H%M
}

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
tty_run() { # stdin is typed into the terminal
  if script --version >/dev/null 2>&1; then
    script -qec "$1" /dev/null # util-linux
  else
    script -q /dev/null bash -c "$1" # BSD (macOS)
  fi | strip
}

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
check ".env is private" test "$(mode "$RADIO_BOT_DIR/.env")" = 600
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
out=$(printf 'n\n' | tty_run "FAKE_PLAYING=2 radio-bot update")
check "warns that playback stops" has "$out" "Radio Bot is playing in 2 servers."
check "warns that the download may cause cuts" has "$out" "listeners may hear small cuts"
check "can be cancelled at the warning" has "$out" "Cancelled; nothing was changed."
check "cancelling leaves the version alone" test "$(radio-bot version)" = v1.0.0
out=$(printf 'y\n' | tty_run "FAKE_PULL_OK=1 FAKE_PLAYING=2 radio-bot update")
check "backs up before updating" has "$out" "Backing up the database first"
check "backs up at the lowest CPU and disk priority" \
  grep -qF "ionice -c 3 -t nice -n 19 \"\$@\"; fi; exec nice -n 19 \"\$@\" exec_low node dist/scripts/backup.js" \
  "$T/state/calls.log"
check "downloads the published image" has "$out" "Image downloaded."
check "skips pre-releases" test "$(radio-bot version)" = v1.0.1
check "reports the update" has "$out" "Updated v1.0.0 → v1.0.1"
check "warns only once" test "$(grep -c "is playing in 2 servers" <<<"$out")" = 1
# shellcheck disable=SC2016
check "saves the old version's logs" bash -c 'ls "$1"/logs/radio-bot-v1.0.0-*.log' _ "$RADIO_BOT_DIR"
check "removes the previous image" grep -q "docker image rm ghcr.io/dangermouseuk/radio-bot:v1.0.0$" "$T/state/calls.log"
check "keeps the running image" grep -q "^ghcr.io/dangermouseuk/radio-bot:v1.0.1 " "$T/state/images"
check "copies the update's backup out of the container" test -f "$RADIO_BOT_DIR/backups/radio-bot-manual-x.sqlite"
check "forgets the update once the new version is healthy" test ! -e "$RADIO_BOT_DIR/.update-pending"
echo "ghcr.io/dangermouseuk/radio-bot:v0.9.0 sha256:v0.9.0" >>"$T/state/images"
finish() { bash "$RADIO_BOT_DIR/scripts/radio-bot.sh" __finish-update v1.0.0 </dev/null 2>&1 | strip; }
out=$(FAKE_CRASH=1 finish)
check "keeps older images when the new version fails" grep -q "radio-bot:v0.9.0 " "$T/state/images"
out=$(FAKE_PLAYING=1 finish)
check "warns when an older copy of the script started the update" has "$out" "Radio Bot is playing in 1 server."
check "removes older images once healthy" test "$(wc -l <"$T/state/images")" -eq 1
echo "ghcr.io/dangermouseuk/radio-bot:<none> sha256:dangling" >>"$T/state/images"
for i in 1 2 3 4 5 6; do touch -t "$(days_ago "$i")" "$RADIO_BOT_DIR/logs/radio-bot-v0.$i.0-old.log"; done
out=$(finish)
check "removes a dangling image of the bot" test "$(wc -l <"$T/state/images")" -eq 1
check "keeps only the newest 5 saved logs" test "$(find "$RADIO_BOT_DIR/logs" -name 'radio-bot-*.log' | wc -l)" -eq 5
# shellcheck disable=SC2016
check "keeps the log it just saved" bash -c 'ls -t "$1"/logs/radio-bot-*.log | head -n 1 | grep -qv -- -old.log' _ "$RADIO_BOT_DIR"
chmod 000 "$RADIO_BOT_DIR/logs"
out=$(finish)
chmod 700 "$RADIO_BOT_DIR/logs"
check "finishes the update even when the log can't be saved" has "$out" "Updated v1.0.0"
out=$(FAKE_UP_FAIL=1 finish)
check "an update an older script started is remembered if it stops halfway" test -s "$RADIO_BOT_DIR/.update-pending"
out=$(finish)
check "and forgotten once it finishes" test ! -e "$RADIO_BOT_DIR/.update-pending"
echo "local edit" >>"$RADIO_BOT_DIR/README.md"
out=$(radio-bot update 2>&1 | strip)
check "refuses to update over edited files" has "$out" "were edited"
git -C "$RADIO_BOT_DIR" checkout -q -- .
out=$(radio-bot update v9.9.9 2>&1 | strip)
check "says when a version doesn't exist" has "$out" "Version v9.9.9 was not found."
check "a failed switch leaves the version alone" test "$(radio-bot version)" = v1.0.1
check "a failed switch isn't taken for an unfinished update" test ! -e "$RADIO_BOT_DIR/.update-pending"

echo "interrupted update"
echo "# next" >>"$T/origin/CHANGELOG.md"
git -C "$T/origin" -c user.email=t@example.org -c user.name=test commit -qam v1.0.2
git -C "$T/origin" tag v1.0.2
out=$(FAKE_UP_FAIL=1 radio-bot update 2>&1 | strip)
check "an interrupted update has switched version" test "$(radio-bot version)" = v1.0.2
check "an interrupted update leaves the old version running" grep -q "radio-bot:v1.0.1 " "$T/state/current"
out=$(radio-bot status 2>&1 | strip)
check "status says the update didn't finish" has "$out" "the last update to v1.0.2 didn't finish"
rm -f "$RADIO_BOT_DIR/.update-pending"
out=$(radio-bot status 2>&1 | strip)
check "status spots an unfinished update from the running image" has "$out" "didn't finish"
out=$(radio-bot update 2>&1 | strip)
check "update says it is finishing the last update" has "$out" "The last update to v1.0.2 didn't finish"
check "update finishes an interrupted update" has "$out" "Updated v1.0.1 → v1.0.2"
check "runs the new version once finished" grep -q "radio-bot:v1.0.2 " "$T/state/current"
out=$(radio-bot update 2>&1 | strip)
check "nothing to do once the update has finished" has "$out" "Already on the newest version (v1.0.2)."

echo "backup and crash detection"
rm -rf "$RADIO_BOT_DIR/backups"
out=$(radio-bot backup 2>&1 | strip)
check "copies backups out" test -f "$RADIO_BOT_DIR/backups/radio-bot-manual-x.sqlite"
radio-bot stop >/dev/null 2>&1
rm -rf "$RADIO_BOT_DIR/backups"
out=$(radio-bot backup 2>&1 | strip)
check "says a stopped bot can't make a new backup" has "$out" "no new backup can be made"
check "copies earlier backups out of a stopped bot" test -f "$RADIO_BOT_DIR/backups/radio-bot-manual-x.sqlite"
radio-bot start >/dev/null 2>&1
out=$(FAKE_CRASH=1 radio-bot restart 2>&1 | strip)
check "explains a crash on start" has "$out" "stopped while starting"
check "shows the bot's error" has "$out" "invalid token"
check "restart recreates the container, so .env changes apply"   grep -q "docker compose up -d --force-recreate radio-bot$" "$T/state/calls.log"
rm -f "$T/state/restarts"
out=$(FAKE_COMPOSE_VERSION=2.20.3 radio-bot status 2>&1 | strip)
check "refuses Compose older than 2.24" has "$out" "Docker Compose 2.20 is too old"

echo "restore"
printf 'SQLite format 3\000and the rest of the database' >"$HOME/old.sqlite"
out=$(cd "$HOME" && printf 'y\n' | tty_run "radio-bot restore old.sqlite")
check "restores a file named relative to the current folder" has "$out" "Restored."
check "mounts the chosen file" grep -qF "$HOME/old.sqlite:/restore.sqlite:ro" "$T/state/calls.log"
printf 'not a database\n' >"$HOME/notes.txt"
stops=$(grep -c "compose stop" "$T/state/calls.log")
out=$(radio-bot restore "$HOME/notes.txt" 2>&1 | strip)
check "refuses a file that isn't a backup" has "$out" "notes.txt isn't a Radio Bot backup"
check "stops nothing for a file that isn't a backup" test "$(grep -c "compose stop" "$T/state/calls.log")" = "$stops"
out=$(printf 'y\n' | tty_run "FAKE_RUN_FAIL=1 radio-bot restore $HOME/old.sqlite")
check "explains a failed restore" has "$out" "The backup wasn't restored. Radio Bot has been started again"
check "starts the bot again after a failed restore" test -f "$T/state/running"
check "a failed restore ends by starting the bot" test "$(grep "compose " "$T/state/calls.log" | tail -n 1)" = "docker compose up -d"

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
