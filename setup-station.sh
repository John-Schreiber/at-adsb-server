#!/usr/bin/env bash
# A Bash 3.2+ wizard for creating .env and registering the receiver station.

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$SCRIPT_DIR
ENV_FILE="$ROOT_DIR/.env"
TEMP_ENV_FILE=

cleanup() {
  if [ -n "${TEMP_ENV_FILE:-}" ] && [ -e "$TEMP_ENV_FILE" ]; then
    rm -f -- "$TEMP_ENV_FILE"
  fi
}

trap cleanup EXIT INT TERM
umask 077

# Keep prompt input separate from helper commands that may read standard input.
exec 3<&0

abort() {
  printf '%s\n' "$1" >&2
  exit 1
}

has_text() {
  case "$1" in
    *[![:space:]]*) return 0 ;;
    *) return 1 ;;
  esac
}

reject_line_breaks() {
  case "$1" in
    *$'\r'*|*$'\n'*)
      abort "invalid $2: newlines are not allowed"
      ;;
  esac
}

read_value() {
  local prompt=$1
  REPLY=
  if ! IFS= read -r -u 3 -p "$prompt" REPLY; then
    [ -n "$REPLY" ] || abort "input cancelled"
  fi
}

read_secret() {
  local prompt=$1
  REPLY=
  printf '%s' "$prompt"
  if ! IFS= read -r -u 3 -s REPLY; then
    [ -n "$REPLY" ] || abort "input cancelled"
  fi
  printf '\n'
}

require_value() {
  local value=$1
  local label=$2
  reject_line_breaks "$value" "$label"
  if ! has_text "$value"; then
    abort "$label must not be empty or whitespace-only"
  fi
}

validate_coordinate() {
  local value=$1
  local label=$2
  reject_line_breaks "$value" "$label"
  if ! printf '%s\n' "$value" | LC_ALL=C awk -v label="$label" '
    {
      decimal = "[-+]?[0-9]+([.][0-9]*)?([eE][-+]?[0-9]+)?"
      leading_dot = "[-+]?[.][0-9]+([eE][-+]?[0-9]+)?"
      pattern = "^(" decimal "|" leading_dot ")$"
      if ($0 !~ pattern) exit 1
      number = $0 + 0
      if (number != number) exit 1
      if (label == "latitude" && (number < -90 || number > 90)) exit 1
      if (label == "longitude" && (number < -180 || number > 180)) exit 1
      exit 0
    }
  '; then
    abort "invalid $label: enter a finite decimal number within its allowed range"
  fi
}

# Compose's dotenv parser accepts double-quoted values. Escape only the characters
# that affect that syntax, while doubling dollar signs to prevent interpolation.
escape_dotenv() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\$\$}
  printf '%s' "$value"
}

write_env_line() {
  local key=$1
  local value=$2
  printf '%s="%s"\n' "$key" "$(escape_dotenv "$value")" >>"$TEMP_ENV_FILE"
}

if [ -e "$ENV_FILE" ]; then
  printf '%s\n' "An existing .env contains credentials and will be replaced." >&2
  read_value "Overwrite .env? [y/N] "
  case "$REPLY" in
    y|Y) ;;
    *) abort "leaving existing .env unchanged" ;;
  esac
fi

read_value "PDS service URL [https://bsky.social]: "
ATP_SERVICE=${REPLY:-https://bsky.social}
require_value "$ATP_SERVICE" "PDS service URL"

read_value "AT Protocol handle: "
ATP_HANDLE=$REPLY
require_value "$ATP_HANDLE" "AT Protocol handle"

read_secret "AT Protocol app password: "
ATP_PASSWORD=$REPLY
require_value "$ATP_PASSWORD" "AT Protocol app password"

read_value "Station display name: "
STATION_NAME=$REPLY
require_value "$STATION_NAME" "station display name"

read_value "readsb URL [http://host.docker.internal:8080]: "
READSB_URL=${REPLY:-http://host.docker.internal:8080}
require_value "$READSB_URL" "readsb URL"

printf '%s\n' ""
printf '%s\n' "================================================================"
printf '%s\n' "PUBLIC LOCATION WARNING"
printf '%s\n' "The station latitude and longitude will be written to a public"
printf '%s\n' "AT Protocol record. Anyone who can read that record can see them."
printf '%s\n' "Use coordinates rounded to roughly two decimal places (~1 km)"
printf '%s\n' "unless you knowingly accept publishing a precise location."
printf '%s\n' "================================================================"
read_value "Continue and enter station coordinates? [y/N] "
case "$REPLY" in
  y|Y) ;;
  *) abort "coordinate consent not given; no .env was written" ;;
esac

read_value "Station latitude (decimal degrees): "
RECEIVER_LAT=$REPLY
validate_coordinate "$RECEIVER_LAT" "latitude"

read_value "Station longitude (decimal degrees): "
RECEIVER_LON=$REPLY
validate_coordinate "$RECEIVER_LON" "longitude"

TEMP_ENV_FILE=$(mktemp "$ROOT_DIR/.env.tmp.XXXXXX") || abort "failed to create temporary .env"
chmod 600 "$TEMP_ENV_FILE"

write_env_line "ATP_SERVICE" "$ATP_SERVICE"
write_env_line "ATP_HANDLE" "$ATP_HANDLE"
write_env_line "ATP_PASSWORD" "$ATP_PASSWORD"
write_env_line "RECEIVER_LAT" "$RECEIVER_LAT"
write_env_line "RECEIVER_LON" "$RECEIVER_LON"
write_env_line "READSB_URL" "$READSB_URL"
write_env_line "WS_PORT" "4100"
write_env_line "BATCH_WINDOW_S" "60"
write_env_line "STATS_INTERVAL_M" "60"
write_env_line "QUEUE_DB_PATH" "/data/at-adsb-queue.db"
write_env_line "POLL_INTERVAL_S" "5"

mv -f -- "$TEMP_ENV_FILE" "$ENV_FILE"
TEMP_ENV_FILE=
chmod 600 "$ENV_FILE"

register_args=(
  compose run --rm --build daemon register
  --name "$STATION_NAME"
  --lat "$RECEIVER_LAT"
  --lon "$RECEIVER_LON"
)

cd "$ROOT_DIR"
if docker "${register_args[@]}"; then
  printf '%s\n' ""
  printf '%s\n' ".env was created at $ENV_FILE."
  printf '%s\n' "Start the stack with: docker compose up -d"
else
  status=$?
  printf '%s\n' 'Registration failed; .env remains available for retry.' >&2
  exit "$status"
fi
