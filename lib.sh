# Runs Atlantis and checks what it replies. The VCS specific parts are in <vcs>/vcs.sh.
# shellcheck shell=bash

ATLANTIS=${ATLANTIS:-atlantis}
PORT=${PORT:-4141}
SKIPPED=77
mkdir -p .work
WORK=$(mktemp -d "$PWD/.work/XXXXXX")
export HARNESS_WORK=$WORK # used by the Terraform code
SECRET=$(openssl rand -hex 16)
TF_VERSION=$(terraform version -json | jq -r .terraform_version)
PID=
SINCE=0

fail() { echo "$*"; exit 1; }
skip() { echo "$*"; exit "$SKIPPED"; }

# start <data dir name> [flags...]
# Each test starts with a new data dir, so there are no locks or state left from others.
start() {
  local data=$WORK/data-$BASHPID-$1
  shift
  curl -fs "localhost:$PORT/healthz" > /dev/null && fail "there is something running on port $PORT already"
  mkdir -p "$data"
  vcs_env
  "$ATLANTIS" server --port "$PORT" --atlantis-url "http://localhost:$PORT" --data-dir "$data" \
    --default-tf-version "$TF_VERSION" --tf-download=false --repo-config repos.yaml \
    "$@" > "$WORK/atlantis.log" 2>&1 &
  PID=$!
  for _ in {1..40}; do
    curl -fs "localhost:$PORT/healthz" > /dev/null && return
    kill -0 "$PID" 2> /dev/null || break
    sleep 0.5
  done
  fail "atlantis did not start: $(tail -1 "$WORK/atlantis.log")"
}

stop() {
  [ -z "$PID" ] || { kill "$PID" 2> /dev/null && wait "$PID" 2> /dev/null; } || true
  PID=
}

# Waits for Atlantis to finish what it's doing.
wait_idle() {
  sleep 3
  for _ in {1..60}; do
    [ "$(curl -fs "localhost:$PORT/status" | jq .in_progress_operations)" = 0 ] && break
    sleep 1
  done
  sleep 2
}

# run_event <pr> <event> [comment]
run_event() {
  SINCE=$(last_comment_id "$1")
  send_event "$@"
  wait_idle
}

plan() { run_event "$1" "$PLAN_EVENT"; }
# comment <pr> <atlantis command>
comment() { run_event "$1" "$COMMENT_EVENT" "$2"; }
apply() { comment "$1" "atlantis apply${2:+ -p $2}"; }

# expect <pr> <text>, in the comments since the last event
expect() {
  local replies
  replies=$(comments_since "$1" "$SINCE")
  [[ $replies == *"$2"* ]] || fail "expected '$2', got: $replies"
  echo "ok: $2"
}
expect_blocked() { expect "$1" "Blocked by $2)"; }
expect_applied() { expect "$1" "Apply complete!"; }
