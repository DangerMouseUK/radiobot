#!/bin/sh
# The Docker image's HEALTHCHECK. Exit 0 = healthy. Applies the same rules as checkHeartbeat()
# (src/observability/heartbeat-check.ts) without starting Node: a Node start costs tens of MB and a
# few hundred ms of CPU on every check, which matters on a one-core host with 1 GB of memory.
# This starts one program, `find`; everything else is built into the shell (dash in the image).
#
# The bot writes health.json every 30 s as one line of JSON.stringify output (no spaces) to a
# temporary file it renames over the old one, so the file's modified time is when it was written.
# GNU find (the image's) is needed for the fractional -mmin. tests/unit/healthcheck-sh.test.ts
# checks this script against checkHeartbeat(); change both together.

db=${DATABASE_PATH:-./data/radio-bot.sqlite}
case $db in
  */*) f=${db%/*}/health.json ;;
  *) f=health.json ;;
esac

unhealthy() {
  echo "unhealthy: $1"
  exit 1
}

[ -f "$f" ] || unhealthy 'no heartbeat file'
# Modified within the last 90 s. (A modified time in the future, after the clock jumps back, passes
# here but not in checkHeartbeat(); the next heartbeat, 30 s later, puts it right.)
[ -n "$(find "$f" -mmin -1.5 2>/dev/null)" ] || unhealthy 'heartbeat is more than 90 s old'
h=
IFS= read -r h 2>/dev/null <"$f" || [ -n "$h" ] || unhealthy 'no heartbeat file'
case $h in
  '{'*'}') ;;
  *) unhealthy 'no heartbeat file' ;;
esac
case $h in
  *'"dbOk":true'*) ;;
  *) unhealthy 'database check failed' ;;
esac
case $h in
  *'"discordReady":true'*) ;;
  *) unhealthy 'not connected to Discord' ;;
esac
# A heartbeat from an older version has no ffmpegOk, which counts as ok.
case $h in
  *'"ffmpegOk":false'*) unhealthy 'ffmpeg unavailable or missing libopus' ;;
esac
echo 'healthy: ok'
