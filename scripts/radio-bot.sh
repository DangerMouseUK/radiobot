#!/usr/bin/env bash
# Radio Bot manager: installs, updates, backs up and removes a Docker Compose install.
# It lives inside the checkout it manages, and `install` adds a `radio-bot` shortcut to it.
# Run `radio-bot help` for the commands. Works on Linux and macOS (bash 3.2+).
set -euo pipefail

PERMISSIONS=281474979908608
SERVICE=radio-bot

# ---------------------------------------------------------------- output

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RESET=$'\033[0m'
else
  BOLD='' DIM='' RED='' GREEN='' YELLOW='' RESET=''
fi

say() { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
ok() { printf '%s✔ %s%s\n' "$GREEN" "$*" "$RESET"; }
warn() { printf '%s! %s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
die() {
  printf '%s✖ %s%s\n' "$RED" "$*" "$RESET" >&2
  exit 1
}

# Prompts read from the terminal, so they also work when the installer is piped into bash.
has_tty() { { : </dev/tty; } 2>/dev/null; }

# The reply variable has an unusual name so it can't shadow the caller's VAR.
ask() { # ask VAR "Question" [default]
  local __reply=''
  has_tty || die "No terminal to ask \"$2\" on. Run this command in an interactive terminal."
  printf '%s%s%s ' "$BOLD" "$2" "$RESET" >/dev/tty
  IFS= read -r __reply </dev/tty || true
  printf -v "$1" '%s' "${__reply:-${3:-}}"
}

ask_secret() { # ask_secret VAR "Question"
  local __reply=''
  has_tty || die "No terminal to ask \"$2\" on. Run this command in an interactive terminal."
  printf '%s%s%s ' "$BOLD" "$2" "$RESET" >/dev/tty
  IFS= read -rs __reply </dev/tty || true
  printf '\n' >/dev/tty
  printf -v "$1" '%s' "$__reply"
}

confirm() { # confirm "Question" y|n  (the second argument is the default)
  local answer='' hint='[y/N]'
  [ "${2:-n}" = y ] && hint='[Y/n]'
  ask answer "$1 $hint" "${2:-n}"
  case "$answer" in [Yy] | [Yy][Ee][Ss]) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------- locations

resolve() { # follows symlinks without relying on GNU readlink -f
  local path=$1 dir
  while [ -L "$path" ]; do
    dir=$(cd -P "$(dirname "$path")" && pwd)
    path=$(readlink "$path")
    case "$path" in /*) ;; *) path="$dir/$path" ;; esac
  done
  printf '%s/%s\n' "$(cd -P "$(dirname "$path")" && pwd)" "$(basename "$path")"
}

SELF=$(resolve "${BASH_SOURCE[0]}")
DIR=$(dirname "$(dirname "$SELF")")
if [ ! -f "$DIR/compose.yaml" ] || [ ! -f "$DIR/.env.example" ]; then
  die "This script must stay in the scripts/ folder of a Radio Bot checkout ($DIR looks wrong)."
fi
START_DIR=$PWD # where the user ran the command, for file names they type
cd "$DIR"

# ---------------------------------------------------------------- docker

DOCKER=(docker)

is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

docker_install_hint() {
  if is_wsl; then
    say "On Windows, install Docker Desktop, then turn on Settings → Resources → WSL integration → Ubuntu."
    say "Guide: docs/install.md (On Windows). Then open a new Ubuntu window and run this again."
    return
  fi
  case "$(uname -s)" in
    Darwin) say "Install Docker Desktop from https://docs.docker.com/desktop/setup/install/mac-install/, start it, then run this again." ;;
    Linux) say "Install Docker Engine from https://docs.docker.com/engine/install/, then run this again." ;;
    *) say "Install Docker from https://docs.docker.com/get-started/get-docker/, then run this again." ;;
  esac
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker is not installed."
    if [ "$(uname -s)" = Linux ] && ! is_wsl && command -v curl >/dev/null 2>&1 &&
      confirm "Install Docker now with Docker's official script (get.docker.com)? It needs your sudo password." n; then
      local tmp
      tmp=$(mktemp)
      curl -fsSL https://get.docker.com -o "$tmp" || die "Could not download Docker's installer."
      sudo sh "$tmp" || die "Docker's installer failed; see its output above."
      rm -f "$tmp"
      sudo systemctl enable --now docker >/dev/null 2>&1 || true
    else
      docker_install_hint
      exit 1
    fi
  fi
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    # Fresh Linux installs only let root talk to Docker until the user joins the docker group.
    DOCKER=(sudo docker)
  else
    case "$(uname -s)" in
      Darwin) die "Docker is installed but not running. Open Docker Desktop, wait for it to start, then try again." ;;
      *) die "Docker is installed but not running. Start it (for example: sudo systemctl start docker) and try again." ;;
    esac
  fi
  local version major minor
  version=$("${DOCKER[@]}" compose version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -n 1) ||
    die "Docker Compose v2 is missing. Install the Docker Compose plugin: https://docs.docker.com/compose/install/"
  # compose.yaml's optional env_file (path: / required: false) needs Compose 2.24 or newer.
  major=${version%%.*} minor=${version#*.}
  if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 24 ]; }; then
    die "Docker Compose $version is too old; Radio Bot needs 2.24 or newer. Update Docker, then try again."
  fi
}

compose() { "${DOCKER[@]}" compose "$@"; }

container_state() { # running | restarting | exited | missing
  "${DOCKER[@]}" inspect -f '{{.State.Status}}' "$SERVICE" 2>/dev/null || echo missing
}

require_running() {
  [ "$(container_state)" = running ] || die "Radio Bot is not running. Start it with: radio-bot start"
}

# ---------------------------------------------------------------- versions

current_version() {
  git describe --tags --exact-match 2>/dev/null || git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown
}

latest_release() { # newest vX.Y.Z tag, ignoring pre-releases
  git tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true
}

on_release() { git describe --tags --exact-match >/dev/null 2>&1; }

# Pulls the published image for a release, or builds it here when there is none (or on a branch).
get_image() {
  if on_release; then
    step "Downloading the Radio Bot image for $(current_version)"
    if compose pull --quiet "$SERVICE" 2>/dev/null; then
      ok "Image downloaded."
      return
    fi
    say "No published image for this version; building it on this machine instead."
  fi
  step "Building the Radio Bot image (this takes a few minutes the first time)"
  compose build "$SERVICE"
  ok "Image built."
}

# ---------------------------------------------------------------- settings

env_value() { # env_value KEY → the value set in .env, if any
  [ -f .env ] || return 0
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); value = $0 } END { print value }' .env
}

set_env_value() { # set_env_value KEY VALUE, replacing the line in .env
  local tmp
  tmp=$(mktemp "$DIR/.env.XXXXXX")
  KEY=$1 VALUE=$2 awk -F= '
    $1 == ENVIRON["KEY"] { print ENVIRON["KEY"] "=" ENVIRON["VALUE"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["KEY"] "=" ENVIRON["VALUE"] }
  ' .env >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" .env
}

valid_app_id() { [[ $1 =~ ^[0-9]{17,20}$ ]]; }
valid_token() { [ "${#1}" -ge 50 ] && [[ ! $1 =~ [[:space:]] ]]; }

configure() {
  if [ -f .env ] && valid_app_id "$(env_value DISCORD_APPLICATION_ID)" &&
    valid_token "$(env_value DISCORD_TOKEN)"; then
    ok "Using your existing settings in $DIR/.env"
    return
  fi
  step "Connecting the bot to your Discord application"
  say "You need two values from the Discord Developer Portal (https://discord.com/developers/applications)."
  say "The install guide shows where to find them: docs/install.md, step 1."
  say ''
  [ -f .env ] || { cp .env.example .env && chmod 600 .env; }
  local app_id='' token=''
  while ! valid_app_id "$app_id"; do
    ask app_id "Application ID (General Information page, 17-20 digits):"
    app_id=${app_id//[[:space:]]/}
    valid_app_id "$app_id" || warn "That doesn't look like an Application ID; it should be 17 to 20 digits."
  done
  while ! valid_token "$token"; do
    ask_secret token "Bot token (Bot page → Reset Token; typing is hidden, paste and press Enter):"
    valid_token "$token" || warn "That doesn't look like a bot token; it is about 70 characters with no spaces."
  done
  set_env_value DISCORD_APPLICATION_ID "$app_id"
  set_env_value DISCORD_TOKEN "$token"
  ok "Saved to $DIR/.env (readable only by you). Change other settings later with: radio-bot config"
}

invite_url() {
  local app_id
  app_id=$(env_value DISCORD_APPLICATION_ID)
  valid_app_id "$app_id" || app_id=APPLICATION_ID
  printf 'https://discord.com/oauth2/authorize?client_id=%s&scope=bot%%20applications.commands&permissions=%s\n' \
    "$app_id" "$PERMISSIONS"
}

# ---------------------------------------------------------------- health

# Healthy, and the heartbeat was written by the container's current run, not an earlier one.
healthy_since() {
  compose exec -T "$SERVICE" node -e '
    const h = JSON.parse(require("node:fs").readFileSync("/app/data/health.json", "utf8"));
    const fresh = Date.parse(h.at) > Date.parse(process.argv[1]) && Date.now() - Date.parse(h.at) < 90000;
    process.exit(fresh && h.discordReady && h.dbOk ? 0 : 1);
  ' "$1" >/dev/null 2>&1
}

# Waits for the first healthy heartbeat, or explains why the bot stopped.
wait_until_healthy() {
  step "Waiting for Radio Bot to connect to Discord"
  local _ started restarts
  started=$("${DOCKER[@]}" inspect -f '{{.State.StartedAt}}' "$SERVICE" 2>/dev/null || echo '')
  restarts=$("${DOCKER[@]}" inspect -f '{{.RestartCount}}' "$SERVICE" 2>/dev/null || echo 0)
  for _ in $(seq 1 45); do
    local state
    state=$(container_state)
    # A crash during start-up shows up as a restart, since Compose restarts the container.
    [ "$("${DOCKER[@]}" inspect -f '{{.RestartCount}}' "$SERVICE" 2>/dev/null || echo 0)" = "$restarts" ] ||
      state=exited
    case "$state" in
      running)
        if healthy_since "$started"; then
          ok "Radio Bot is online."
          return 0
        fi
        ;;
      restarting | exited | dead)
        say ''
        compose logs --no-log-prefix --tail=20 "$SERVICE" >&2 || true
        say ''
        warn "Radio Bot stopped while starting. The lines above say why."
        say "Common causes: a wrong bot token or Application ID (fix with: radio-bot config)."
        say "More help: docs/troubleshooting.md"
        return 1
        ;;
    esac
    sleep 2
  done
  warn "Radio Bot hasn't reported in after 90 seconds. Check the logs with: radio-bot logs"
  return 1
}

# ---------------------------------------------------------------- shortcut

# The shortcut is a two-line wrapper, so it works whatever the checkout's file modes are.
SHORTCUT_MARK='# radio-bot shortcut'

write_shortcut() { # write_shortcut PATH [sudo]
  printf '#!/bin/sh
%s
exec bash "%s" "$@"
' "$SHORTCUT_MARK" "$SELF" |
    ${2:+sudo} tee "$1" >/dev/null && ${2:+sudo} chmod 755 "$1"
}

install_shortcut() {
  local target
  for target in /usr/local/bin "$HOME/.local/bin"; do
    case ":$PATH:" in *":$target:"*) ;; *) continue ;; esac
    if [ -d "$target" ] && [ -w "$target" ] && write_shortcut "$target/radio-bot"; then
      ok "Added the radio-bot command."
      return
    fi
  done
  # /usr/local/bin is on the default PATH but may not exist yet (fresh Macs).
  if command -v sudo >/dev/null 2>&1; then
    sudo -n true 2>/dev/null || say "Adding the radio-bot command to /usr/local/bin needs your computer password (sudo)."
  fi
  if command -v sudo >/dev/null 2>&1 && sudo mkdir -p /usr/local/bin 2>/dev/null &&
    write_shortcut /usr/local/bin/radio-bot sudo 2>/dev/null; then
    ok "Added the radio-bot command."
    return
  fi
  warn "Couldn't add the radio-bot command; use: bash $SELF"
}

remove_shortcut() {
  local link
  for link in /usr/local/bin/radio-bot "$HOME/.local/bin/radio-bot"; do
    if [ -f "$link" ] && grep -qF "$SHORTCUT_MARK" "$link" && grep -qF "$SELF" "$link"; then
      rm -f "$link" 2>/dev/null || sudo rm -f "$link" 2>/dev/null || warn "Couldn't remove $link"
    fi
  done
}

# ---------------------------------------------------------------- commands

cmd_install() {
  command -v git >/dev/null 2>&1 || die "git is required (for example: sudo apt install git)."
  # A fresh clone sits on the development branch; switch to the newest release once.
  if [ -z "${RADIO_BOT_VERSION_CHOSEN:-}" ] && ! on_release; then
    git fetch --quiet --tags origin 2>/dev/null || true
    local target=${RADIO_BOT_VERSION:-$(latest_release)}
    if [ -n "$target" ] && [ -z "$(git status --porcelain --untracked-files=no)" ]; then
      git -c advice.detachedHead=false checkout --quiet "$target" || die "Version $target was not found."
      RADIO_BOT_VERSION_CHOSEN=1 exec bash "$SELF" install
    fi
  fi
  say "${BOLD}Radio Bot installer${RESET} — $(current_version), in $DIR"
  ensure_docker
  configure
  get_image
  step "Starting Radio Bot"
  compose up -d --remove-orphans
  install_shortcut
  if wait_until_healthy; then
    step "Last step: invite the bot to your Discord server"
    say "Open this link, pick your server and click Authorise:"
    say ''
    say "  $(invite_url)"
    say ''
    say "Then, in your server: join a voice channel and type ${BOLD}/radio play${RESET}."
    say "Admins can set channels and roles with ${BOLD}/radio config${RESET}."
    say ''
    say "Manage the bot with the ${BOLD}radio-bot${RESET} command: radio-bot help"
  else
    exit 1
  fi
}

cmd_update() {
  ensure_docker
  [ -z "$(git status --porcelain --untracked-files=no)" ] ||
    die "Files in $DIR were edited, so updating could overwrite them. Put local changes in compose.override.yaml, then run: git -C \"$DIR\" checkout -- ."
  step "Checking for a new version"
  git fetch --quiet --tags --force origin || die "Couldn't reach GitHub to check for updates."
  local from to
  from=$(current_version)
  to=${1:-$(latest_release)}
  if [ -z "$to" ]; then
    [ "$from" != HEAD ] || die "No release has been published yet; nothing to update to."
    to=$from # tracking a branch: follow it
  fi
  if [ "$to" = "$from" ] && on_release; then
    ok "Already on the newest version ($from)."
    return
  fi
  if [ "$(container_state)" = running ]; then
    warn_if_playing || die "Cancelled; nothing was changed."
    step "Backing up the database first"
    compose exec -T "$SERVICE" node dist/scripts/backup.js
  fi
  step "Updating $from → $to"
  if git show-ref --verify --quiet "refs/remotes/origin/$to"; then
    git checkout --quiet "$to" && git merge --quiet --ff-only "origin/$to"
  else
    git -c advice.detachedHead=false checkout --quiet "$to" || die "Version $to was not found."
  fi
  # The rest runs from the updated copy of this script. "warned" tells it the warning was shown.
  exec bash "$SELF" __finish-update "$from" warned
}

# Updates started by an older copy of this script arrive here without the warning, so it is shown now.
cmd_finish_update() {
  ensure_docker
  [ "${2:-}" = warned ] || [ "$(container_state)" != running ] || warn_if_playing no-ask || true
  get_image
  save_logs "${1:-}"
  step "Restarting Radio Bot"
  compose up -d --remove-orphans
  wait_until_healthy || exit 1
  remove_old_images
  ok "Updated ${1:-} → $(current_version). Read what changed in CHANGELOG.md."
}

playing_count() { # servers the running bot is playing in, from its heartbeat file
  compose exec -T "$SERVICE" cat /app/data/health.json 2>/dev/null |
    grep -oE '"activeStreams":[0-9]+' | cut -d: -f2 || true
}

warn_if_playing() { # warn_if_playing [no-ask]; fails if the user decides not to update
  local n servers=servers
  n=$(playing_count)
  if [ -z "$n" ] || [ "$n" -eq 0 ]; then return 0; fi
  if [ "$n" -eq 1 ]; then servers=server; fi
  warn "Radio Bot is playing in $n $servers. Updating restarts it, and a server only starts playing again by itself if an admin turned on \"Resume after restart\" in /radio config."
  if [ -n "${1:-}" ] || ! has_tty; then return 0; fi
  confirm "Update now?" y
}

# The container's logs go when it is replaced, so the old version's last lines are kept in logs/.
# Best effort: nothing here may stop an update halfway (the new version is already checked out).
save_logs() { # save_logs VERSION
  [ "$(container_state)" != missing ] || return 0
  local file version=${1:-old}
  if ! { mkdir -p logs && chmod 700 logs; } 2>/dev/null; then
    warn "Couldn't use $DIR/logs, so the old version's log wasn't saved."
    return 0
  fi
  file="logs/radio-bot-${version//\//-}-$(date +%Y%m%d-%H%M%S).log"
  if (umask 077 && compose logs --no-color --no-log-prefix --tail=500 "$SERVICE" >"$file" 2>/dev/null); then
    ok "Saved the last 500 log lines to $DIR/$file"
  else
    rm -f "$file"
    warn "Couldn't save the old version's log."
  fi
  # Keep the newest 5. The names are ours and have no spaces, so ls is safe here.
  # shellcheck disable=SC2012
  ls -1t logs/radio-bot-*.log 2>/dev/null | tail -n +6 | while read -r old; do rm -f "$old"; done || true
}

# Every update downloads a new image of about 1 GB, so older ones are removed once the new version
# is healthy. Images a container still uses (even a stopped one) are kept: docker refuses to remove them.
remove_old_images() {
  local image keep repo ref id removed=0
  image=$("${DOCKER[@]}" inspect -f '{{.Config.Image}}' "$SERVICE" 2>/dev/null) || return 0
  keep=$("${DOCKER[@]}" inspect -f '{{.Image}}' "$SERVICE" 2>/dev/null) || return 0
  repo=${image%@*}
  case "${repo##*/}" in *:*) repo=${repo%:*} ;; esac
  while read -r ref id; do
    if [ -z "$id" ] || [ "$id" = "$keep" ]; then continue; fi
    case "$ref" in *:'<none>') ref=$id ;; esac
    if "${DOCKER[@]}" image rm "$ref" >/dev/null 2>&1; then removed=$((removed + 1)); fi
  done < <("${DOCKER[@]}" image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' "$repo" 2>/dev/null || true)
  [ "$removed" -eq 0 ] || ok "Removed $removed older Radio Bot image(s) to free disk space."
}

cmd_backup() {
  ensure_docker
  require_running
  step "Backing up the database"
  compose exec -T "$SERVICE" node dist/scripts/backup.js
  mkdir -p backups
  compose cp "$SERVICE:/app/data/backups/." backups/ >/dev/null
  chmod 700 backups
  ok "Backups copied to $DIR/backups/ — keep a copy somewhere other than this computer too."
}

cmd_restore() {
  local file=${1:-}
  [ -n "$file" ] || die "Name the backup to restore, for example: radio-bot restore backups/radio-bot-manual-….sqlite"
  # A relative name means the folder the user is in; failing that, the Radio Bot folder.
  case "$file" in /*) ;; *) [ ! -f "$START_DIR/$file" ] || file="$START_DIR/$file" ;; esac
  [ -f "$file" ] || die "No such file: $file"
  file=$(resolve "$file")
  ensure_docker
  warn "This replaces all of the bot's current settings and data with the backup."
  confirm "Restore $(basename "$file")?" n || die "Cancelled."
  if [ "$(container_state)" = running ]; then
    step "Backing up the current database first"
    compose exec -T "$SERVICE" node dist/scripts/backup.js
  fi
  step "Restoring"
  compose stop "$SERVICE" >/dev/null
  compose run --rm --no-deps -T -v "$file:/restore.sqlite:ro" --entrypoint sh "$SERVICE" -c \
    'cp /restore.sqlite /app/data/radio-bot.sqlite && rm -f /app/data/radio-bot.sqlite-wal /app/data/radio-bot.sqlite-shm'
  compose up -d
  wait_until_healthy || exit 1
  ok "Restored."
}

cmd_config() {
  local editor=${VISUAL:-${EDITOR:-}}
  if [ -z "$editor" ]; then
    for editor in nano vim vi ''; do [ -n "$editor" ] && command -v "$editor" >/dev/null 2>&1 && break; done
    [ -n "$editor" ] || die "No text editor found. Edit $DIR/.env by hand, then run: radio-bot restart"
  fi
  [ -f .env ] || { cp .env.example .env && chmod 600 .env; }
  [ "$(basename "$editor")" != nano ] || say "Opening the settings in nano. To save and close: Ctrl+O, Enter, then Ctrl+X."
  "$editor" .env </dev/tty >/dev/tty
  ensure_docker
  if [ "$(container_state)" != missing ] && confirm "Restart Radio Bot to apply the changes?" y; then
    compose up -d --force-recreate "$SERVICE"
    wait_until_healthy || exit 1
  fi
}

cmd_status() {
  ensure_docker
  say "Version:  $(current_version)"
  say "Folder:   $DIR"
  say "State:    $(container_state)"
  if [ "$(container_state)" = running ]; then
    printf 'Health:   '
    compose exec -T "$SERVICE" node dist/scripts/healthcheck.js || true
  fi
  local latest
  latest=$(latest_release)
  if [ -n "$latest" ] && [ "$latest" != "$(current_version)" ]; then
    say "Update:   $latest is available (run: radio-bot update)"
  fi
}

cmd_uninstall() {
  ensure_docker
  say "${BOLD}This removes Radio Bot from this computer.${RESET}"
  confirm "Continue?" n || die "Cancelled."
  local keep=''
  if [ "$(container_state)" = running ] && confirm "Save a copy of the bot's data to your home folder first?" y; then
    compose exec -T "$SERVICE" node dist/scripts/backup.js >/dev/null
    keep="$HOME/radio-bot-backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$keep"
    compose cp "$SERVICE:/app/data/backups/." "$keep/" >/dev/null
    chmod 700 "$keep"
    ok "Saved to $keep"
  elif [ "$(container_state)" != running ]; then
    warn "The bot isn't running, so a fresh copy of its data can't be made now (run radio-bot start first if you want one)."
  fi
  # Backups made with `radio-bot backup` live inside the folder that is about to be deleted.
  if [ -n "$(ls -A backups 2>/dev/null)" ]; then
    keep=${keep:-"$HOME/radio-bot-backup-$(date +%Y%m%d-%H%M%S)"}
    mkdir -p "$keep/earlier-backups"
    cp -R backups/. "$keep/earlier-backups/"
    chmod 700 "$keep"
    ok "Moved your earlier backups to $keep/earlier-backups"
  fi
  local down=(down --rmi all --remove-orphans)
  if confirm "Delete the bot's data (settings, favourites, custom stations)? This cannot be undone." n; then
    down+=(--volumes)
  else
    say "Keeping the data volume radio-bot_radio-bot-data; reinstalling will pick it up again."
  fi
  step "Stopping and removing the container and image"
  compose "${down[@]}"
  remove_shortcut
  step "Deleting $DIR"
  case "$DIR" in / | "$HOME" | "") die "Refusing to delete $DIR." ;; esac
  cd /
  rm -rf "$DIR"
  ok "Radio Bot is uninstalled."
  [ -z "$keep" ] || say "Your data backup is in $keep"
  say "To remove the bot from Discord too, kick it from your servers or delete the application in the Developer Portal."
}

cmd_help() {
  cat <<EOF
${BOLD}radio-bot${RESET} — manage your Radio Bot install ($DIR)

  ${BOLD}status${RESET}            Version, whether it is running and healthy, and available updates
  ${BOLD}logs${RESET}              Follow the bot's log (Ctrl+C to stop following)
  ${BOLD}start${RESET} | ${BOLD}stop${RESET} | ${BOLD}restart${RESET}
  ${BOLD}config${RESET}            Edit settings (.env) and restart to apply them
  ${BOLD}invite${RESET}            Print the link that adds the bot to a Discord server
  ${BOLD}backup${RESET}            Back up the database and copy it to $DIR/backups/
  ${BOLD}restore${RESET} FILE      Replace the database with a backup
  ${BOLD}update${RESET} [vX.Y.Z]   Update to the newest release (or the one named): backs up first, keeps the old log, removes old images
  ${BOLD}uninstall${RESET}         Remove the bot, optionally keeping a copy of its data
  ${BOLD}install${RESET}           Set up or repair this install (safe to run again)
  ${BOLD}version${RESET}           Print the installed version

${DIM}Guide: docs/install.md · Problems: docs/troubleshooting.md${RESET}
EOF
}

main() {
  local command=${1:-help}
  [ $# -eq 0 ] || shift
  case "$command" in
    install) cmd_install ;;
    update | upgrade) cmd_update "$@" ;;
    __finish-update) cmd_finish_update "$@" ;;
    uninstall | remove) cmd_uninstall ;;
    start) ensure_docker && compose up -d && wait_until_healthy ;;
    stop) ensure_docker && compose stop ;;
    # Recreated, not just restarted, so that changes to .env take effect.
    restart) ensure_docker && compose up -d --force-recreate "$SERVICE" && wait_until_healthy ;;
    status) cmd_status ;;
    logs) ensure_docker && compose logs -f --tail=200 "$SERVICE" ;;
    config | configure) cmd_config ;;
    invite) invite_url ;;
    backup) cmd_backup ;;
    restore) cmd_restore "$@" ;;
    version | --version | -v) current_version ;;
    help | --help | -h) cmd_help ;;
    *) cmd_help && die "Unknown command: $command" ;;
  esac
}

# Kept on one line: `update` replaces this file mid-run, and bash must not read past here.
main "$@"; exit $?
