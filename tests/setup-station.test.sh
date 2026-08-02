#!/usr/bin/env bash
# Shell integration tests for setup-station.sh.

set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WIZARD="$ROOT_DIR/setup-station.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/at-adsb-setup-test.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_file_contains() {
  grep -F -- "$2" "$1" >/dev/null || fail "$1 does not contain expected text: $2"
}

assert_file_not_contains() {
  if grep -F -- "$2" "$1" >/dev/null; then
    fail "$1 unexpectedly contains: $2"
  fi
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

stat_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

make_case() {
  local name=$1
  CASE_DIR="$TEST_ROOT/$name"
  mkdir -p "$CASE_DIR/bin" "$CASE_DIR/elsewhere"
  cp "$WIZARD" "$CASE_DIR/setup-station.sh"
  chmod 0755 "$CASE_DIR/setup-station.sh"
  cat >"$CASE_DIR/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\0' "$@" >"$FAKE_DOCKER_ARGS"
printf 'cwd=%s\n' "$PWD" >"$FAKE_DOCKER_CWD"
if [ "${FAKE_DOCKER_STATUS:-0}" -ne 0 ]; then
  exit "$FAKE_DOCKER_STATUS"
fi
printf 'Station registered: at://example/station/self\n'
DOCKER
  chmod 0755 "$CASE_DIR/bin/docker"
  export FAKE_DOCKER_ARGS="$CASE_DIR/docker-args"
  export FAKE_DOCKER_CWD="$CASE_DIR/docker-cwd"
  export PATH="$CASE_DIR/bin:$PATH"
}

run_wizard() {
  local input=$1
  local cwd=$2
  set +e
  (cd "$cwd" && printf '%s' "$input" | bash "$CASE_DIR/setup-station.sh" >"$CASE_DIR/output" 2>&1)
  RUN_STATUS=$?
  set -e
}

args_text() {
  tr '\0' '\n' <"$FAKE_DOCKER_ARGS"
}

assert_no_temp_env() {
  if compgen -G "$CASE_DIR/.env.tmp.*" >/dev/null; then
    fail "temporary dotenv file remains"
  fi
}

# Read the double-quoted Compose dotenv subset without sourcing it.
parse_dotenv_value() {
  local key=$1
  local line
  line=$(grep "^${key}=\"" "$CASE_DIR/.env") || return 1
  line=${line#*=\"}
  line=${line%\"}
  line=${line//\$\$/\$}
  line=${line//\\\"/\"}
  line=${line//\\\\/\\}
  printf '%s' "$line"
}

test_script_is_executable() {
  [ -x "$WIZARD" ] || fail "setup-station.sh is not executable"
  assert_equal "$(stat_mode "$WIZARD")" "755"
}

test_successful_setup() {
  make_case successful
  run_wizard $'https://pds.example.test\noperator.example\nsecret!$\nHome receiver\nhttp://readsb.example.test:8080\ny\n38.8977\n-77.0365' "$CASE_DIR/elsewhere"
  assert_equal "$RUN_STATUS" "0"
  [ -f "$CASE_DIR/.env" ] || fail ".env was not created"
  assert_equal "$(stat_mode "$CASE_DIR/.env")" "600"
  assert_file_contains "$CASE_DIR/.env" 'ATP_SERVICE="https://pds.example.test"'
  assert_file_contains "$CASE_DIR/.env" 'ATP_HANDLE="operator.example"'
  assert_file_contains "$CASE_DIR/.env" 'RECEIVER_LAT="38.8977"'
  assert_file_contains "$CASE_DIR/.env" 'RECEIVER_LON="-77.0365"'
  assert_file_contains "$CASE_DIR/.env" 'READSB_URL="http://readsb.example.test:8080"'
  assert_file_contains "$CASE_DIR/.env" 'WS_PORT="4100"'
  assert_file_contains "$CASE_DIR/.env" 'BATCH_WINDOW_S="60"'
  assert_file_contains "$CASE_DIR/.env" 'STATS_INTERVAL_M="60"'
  assert_file_contains "$CASE_DIR/.env" 'QUEUE_DB_PATH="/data/at-adsb-queue.db"'
  assert_file_contains "$CASE_DIR/.env" 'POLL_INTERVAL_S="5"'
  args=$(args_text)
  assert_file_contains "$CASE_DIR/docker-cwd" "cwd=$CASE_DIR"
  printf '%s\n' "$args" | grep -Fx -- '--rm' >/dev/null || fail 'missing --rm'
  printf '%s\n' "$args" | grep -Fx -- '--build' >/dev/null || fail 'missing --build'
  printf '%s\n' "$args" | grep -Fx -- '--name' >/dev/null || fail 'missing --name'
  printf '%s\n' "$args" | grep -Fx -- 'Home receiver' >/dev/null || fail 'station name was not preserved'
  printf '%s\n' "$args" | grep -Fx -- '38.8977' >/dev/null || fail 'latitude was not preserved'
  printf '%s\n' "$args" | grep -Fx -- '-77.0365' >/dev/null || fail 'longitude was not preserved'
  assert_file_not_contains "$CASE_DIR/output" 'secret!$'
  assert_no_temp_env
}

test_defaults_applied() {
  make_case defaults
  run_wizard $'\ndefault.example\npassword\nDefault station\n\ny\n1\n2' "$CASE_DIR"
  assert_equal "$RUN_STATUS" "0"
  assert_file_contains "$CASE_DIR/.env" 'ATP_SERVICE="https://bsky.social"'
  assert_file_contains "$CASE_DIR/.env" 'READSB_URL="http://host.docker.internal:8080"'
  assert_file_contains "$CASE_DIR/.env" 'BATCH_WINDOW_S="60"'
  assert_file_contains "$CASE_DIR/.env" 'STATS_INTERVAL_M="60"'
  assert_file_contains "$CASE_DIR/.env" 'QUEUE_DB_PATH="/data/at-adsb-queue.db"'
  assert_file_contains "$CASE_DIR/.env" 'POLL_INTERVAL_S="5"'
}

test_required_inputs_rejected() {
  make_case empty-service
  run_wizard $'\nhandle\npassword\nName\nhttp://readsb\ny\n1\n2' "$CASE_DIR"
  assert_equal "$RUN_STATUS" "0"
  [ -f "$CASE_DIR/.env" ] || fail '.env was not created with the PDS default'

  make_case whitespace-handle
  run_wizard $'https://pds.example\n   \npassword\nName\nhttp://readsb\ny\n1\n2' "$CASE_DIR"
  [ "$RUN_STATUS" -ne 0 ] || fail 'whitespace handle accepted'
  [ ! -e "$CASE_DIR/.env" ] || fail '.env created after whitespace handle'
  assert_no_temp_env

  make_case empty-handle
  run_wizard $'https://pds.example\n\npassword\nName\ny\n1\n2' "$CASE_DIR"
  [ "$RUN_STATUS" -ne 0 ] || fail 'empty handle accepted'
  [ ! -e "$CASE_DIR/.env" ] || fail '.env created after empty handle'

  make_case whitespace-handle
  run_wizard $'https://pds.example\n   \npassword\nName\ny\n1\n2' "$CASE_DIR"
  [ "$RUN_STATUS" -ne 0 ] || fail 'whitespace handle accepted'
  [ ! -e "$CASE_DIR/.env" ] || fail '.env created after whitespace handle'

  make_case empty-password
  run_wizard $'https://pds.example\nhandle\n\nName\ny\n1\n2' "$CASE_DIR"
  [ "$RUN_STATUS" -ne 0 ] || fail 'empty password accepted'
  [ ! -e "$CASE_DIR/.env" ] || fail '.env created after empty password'

  make_case whitespace-password
  run_wizard $'https://pds.example\nhandle\n   \nName\ny\n1\n2' "$CASE_DIR"
  [ "$RUN_STATUS" -ne 0 ] || fail 'whitespace password accepted'
  [ ! -e "$CASE_DIR/.env" ] || fail '.env created after whitespace password'

  make_case empty-name
  run_wizard $'https://pds.example\nhandle\npassword\n\ny\n1\n2' "$CASE_DIR"
  [ "$RUN_STATUS" -ne 0 ] || fail 'empty station name accepted'
  [ ! -e "$CASE_DIR/.env" ] || fail '.env created after empty station name'

  make_case whitespace-readsb
  run_wizard $'https://pds.example\nhandle\npassword\nName\n   \ny\n1\n2' "$CASE_DIR"
  [ "$RUN_STATUS" -ne 0 ] || fail 'whitespace-only readsb URL accepted'
  [ ! -e "$CASE_DIR/.env" ] || fail '.env created after whitespace-only readsb URL'
}

test_coordinate_warning_requires_consent() {
  make_case declined
  run_wizard $'https://pds.example\nhandle\npassword\nName\nhttp://readsb\nn' "$CASE_DIR"
  [ "$RUN_STATUS" -ne 0 ] || fail 'declining coordinate consent succeeded'
  assert_file_contains "$CASE_DIR/output" 'public'
  assert_file_contains "$CASE_DIR/output" 'rounded'
  [ ! -e "$CASE_DIR/.env" ] || fail '.env created after declining consent'
  [ ! -e "$CASE_DIR/docker-args" ] || fail 'Compose called after declining consent'
  assert_no_temp_env
}

test_invalid_coordinates() {
  for value in 1abc NaN Inf 91 -91; do
    make_case "bad-lat-${RANDOM}"
    run_wizard "https://pds.example
handle
password
Name
http://readsb
y
$value
2" "$CASE_DIR"
    [ "$RUN_STATUS" -ne 0 ] || fail "invalid latitude accepted: $value"
    [ ! -e "$CASE_DIR/.env" ] || fail "dotenv created for invalid latitude: $value"
    [ ! -e "$CASE_DIR/docker-args" ] || fail "registration called for invalid latitude: $value"
    assert_no_temp_env
  done

  make_case bad-lon
  run_wizard $'https://pds.example\nhandle\npassword\nName\nhttp://readsb\ny\n1\n181' "$CASE_DIR"
  [ "$RUN_STATUS" -ne 0 ] || fail 'invalid longitude accepted'
  [ ! -e "$CASE_DIR/.env" ] || fail 'dotenv created for invalid longitude'
}

test_existing_env_requires_confirmation() {
  make_case existing
  printf '%s\n' 'ORIGINAL=keep' >"$CASE_DIR/.env"
  chmod 600 "$CASE_DIR/.env"
  run_wizard $'n' "$CASE_DIR"
  [ "$RUN_STATUS" -ne 0 ] || fail 'existing dotenv overwrite refusal succeeded'
  assert_file_contains "$CASE_DIR/.env" 'ORIGINAL=keep'
  assert_no_temp_env
}

test_registration_coordinates_are_authoritative() {
  make_case coordinates
  printf '%s\n' 'RECEIVER_LAT="99"' 'RECEIVER_LON="99"' >"$CASE_DIR/.env"
  chmod 600 "$CASE_DIR/.env"
  run_wizard $'y\nhttps://pds.example\nhandle\npassword\nName\nhttp://readsb\ny\n12.34\n56.78' "$CASE_DIR"
  assert_equal "$RUN_STATUS" "0"
  args=$(args_text)
  printf '%s\n' "$args" | grep -Fx -- '12.34' >/dev/null || fail 'prompted latitude not passed'
  printf '%s\n' "$args" | grep -Fx -- '56.78' >/dev/null || fail 'prompted longitude not passed'
  if printf '%s\n' "$args" | grep -Fx -- '99' >/dev/null; then
    fail 'pre-existing coordinates overrode prompt'
  fi
}

test_punctuation_round_trip() {
  make_case punctuation
  name='  Station #1 "North" \\ $  '
  service='https://pds.example/#frag?x="$value"'
  handle=' operator #1 '
  password='p@ss"\\$'
  readsb=' http://readsb.example/#tag?x="$value" '
  input=$(printf '%s\n' "$service" "$handle" "$password" "$name" "$readsb" y 12.3 -45.6)
  run_wizard "$input" "$CASE_DIR"
  assert_equal "$RUN_STATUS" "0"
  assert_equal "$(parse_dotenv_value ATP_SERVICE)" "$service"
  assert_equal "$(parse_dotenv_value ATP_HANDLE)" "$handle"
  assert_equal "$(parse_dotenv_value ATP_PASSWORD)" "$password"
  assert_equal "$(parse_dotenv_value READSB_URL)" "$readsb"
  args=$(args_text)
  printf '%s\n' "$args" | grep -Fx -- "$name" >/dev/null || fail 'punctuated station name changed'
  assert_file_not_contains "$CASE_DIR/output" "$password"
}

test_password_not_exposed() {
  make_case secret
  export FAKE_DOCKER_STATUS=37
  secret='failure-secret!$'
  run_wizard "https://pds.example
handle
$secret
Failure station
http://readsb
y
1
2" "$CASE_DIR"
  unset FAKE_DOCKER_STATUS
  assert_equal "$RUN_STATUS" "37"
  assert_file_contains "$CASE_DIR/output" 'Registration failed; .env remains available for retry.'
  assert_file_not_contains "$CASE_DIR/output" "$secret"
  if args=$(args_text) && printf '%s\n' "$args" | grep -F -- "$secret" >/dev/null; then
    fail 'password appeared in captured command arguments'
  fi
  [ -f "$CASE_DIR/.env" ] || fail '.env not preserved after registration failure'
  assert_equal "$(stat_mode "$CASE_DIR/.env")" "600"
  assert_no_temp_env
}

test_documentation_mentions_setup() {
  assert_file_contains "$ROOT_DIR/README.md" './setup-station.sh'
  assert_file_contains "$ROOT_DIR/docs/HOSTING.md" './setup-station.sh'
  assert_file_contains "$ROOT_DIR/README.md" 'does not start the stack automatically'
  assert_file_contains "$ROOT_DIR/docs/HOSTING.md" 'does not start the stack automatically'
  assert_file_contains "$ROOT_DIR/README.md" 'public AT Protocol data'
  assert_file_contains "$ROOT_DIR/docs/HOSTING.md" 'public AT Protocol data'
  assert_file_contains "$ROOT_DIR/docs/HOSTING.md" '--build daemon register'
  assert_file_contains "$ROOT_DIR/.env.example" 'READSB_URL=http://host.docker.internal:8080'
  assert_file_contains "$ROOT_DIR/docs/HOSTING.md" 'STATS_INTERVAL_M'
  assert_file_contains "$ROOT_DIR/docs/HOSTING.md" 'QUEUE_DB_PATH'

  # Inspect only fenced shell blocks that contain setup or registration commands.
  # This avoids rejecting harmless prose or a protected dotenv declaration block.
  check_registration_blocks() {
    local file=$1
    local expected=$2
    local selected
    if ! selected=$(awk '
      function inspect(block) {
        if (block ~ /setup-station[.]sh|docker compose[^\n]*register|kubectl[^\n]*register|node[^\n]*cli[.]js register|cp[[:space:]]+[.]env[.]example[[:space:]]+[.]env/) {
          if (block ~ /--password|(^|[[:space:]])ATP_PASSWORD=|--from-literal=password=/) {
            exit 2
          }
          count++
        }
      }
      !in_block && /^[[:space:]]*```[[:space:]]*(bash|sh|shell)?[[:space:]]*$/ {
        in_block = 1
        block = ""
        next
      }
      in_block && /^[[:space:]]*```[[:space:]]*$/ {
        inspect(block)
        in_block = 0
        next
      }
      in_block {
        block = block $0 "\\n"
      }
      END {
        if (in_block) exit 3
        print count + 0
      }
    ' "$file"); then
      fail "unsafe registration code block found in $file"
    fi
    assert_equal "$selected" "$expected"
  }

  check_registration_blocks "$ROOT_DIR/README.md" 2
  check_registration_blocks "$ROOT_DIR/docs/HOSTING.md" 5
}

test_newline_inputs_rejected() {
  # A pipe cannot carry an embedded newline as one read value, so exercise the
  # shell's CR/LF guard through each collected value using a carriage return.
  local field
  for field in service handle password name readsb consent latitude longitude; do
    make_case "newline-$field"
    case "$field" in
      service) input=$'https://pds.example\r\nhandle\npassword\nName\nhttp://readsb\ny\n1\n2' ;;
      handle) input=$'https://pds.example\nhandle\r\npassword\nName\nhttp://readsb\ny\n1\n2' ;;
      password) input=$'https://pds.example\nhandle\npassword\r\nName\nhttp://readsb\ny\n1\n2' ;;
      name) input=$'https://pds.example\nhandle\npassword\nName\r\nhttp://readsb\ny\n1\n2' ;;
      readsb) input=$'https://pds.example\nhandle\npassword\nName\nhttp://readsb\r\ny\n1\n2' ;;
      consent) input=$'https://pds.example\nhandle\npassword\nName\nhttp://readsb\ny\r\n1\n2' ;;
      latitude) input=$'https://pds.example\nhandle\npassword\nName\nhttp://readsb\ny\n1\r\n2' ;;
      longitude) input=$'https://pds.example\nhandle\npassword\nName\nhttp://readsb\ny\n1\n2\r\n' ;;
    esac
    run_wizard "$input" "$CASE_DIR"
    [ "$RUN_STATUS" -ne 0 ] || fail "newline input accepted for $field"
    [ ! -e "$CASE_DIR/.env" ] || fail "dotenv created after newline input for $field"
    [ ! -e "$CASE_DIR/docker-args" ] || fail "registration called after newline input for $field"
    assert_no_temp_env
  done
}

test_script_is_executable
test_successful_setup
test_defaults_applied
test_required_inputs_rejected
test_coordinate_warning_requires_consent
test_invalid_coordinates
test_existing_env_requires_confirmation
test_registration_coordinates_are_authoritative
test_punctuation_round_trip
test_password_not_exposed
test_documentation_mentions_setup
test_newline_inputs_rejected
printf '%s\n' 'setup-station tests passed'
