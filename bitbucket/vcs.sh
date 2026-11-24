# Bitbucket Cloud. Everything is done against its own base branch, so it doesn't
# touch the main one nor its restrictions.
# shellcheck shell=bash

PLAN_EVENT=pullrequest:created
COMMENT_EVENT=pullrequest:comment_created
BASE=harness-$(date +%s)
R=repositories/$BB_REPO
AS=${AS:-main}

# api <main|second|admin> <method> <path> [json]
# Credentials go through stdin, so they don't show up in the process list.
api() {
  local user body=()
  case $1 in
    main) user=$BB_EMAIL:$BB_TOKEN ;;
    second) user=$BB2_EMAIL:$BB2_TOKEN ;;
    admin) user=$BB_EMAIL:$BB_ADMIN_TOKEN ;;
  esac
  [ -z "${4:-}" ] || body=(-H 'Content-Type: application/json' -d "$4")
  curl -sS --fail-with-body -X "$2" "${body[@]}" -K - "https://api.bitbucket.org/2.0/$3" <<< "user = \"$user\""
}

vcs_env() {
  local email=$BB_EMAIL token=$BB_TOKEN
  [ "$AS" = main ] || { email=$BB2_EMAIL token=$BB2_TOKEN; }
  export ATLANTIS_BITBUCKET_USER=x-bitbucket-api-token-auth ATLANTIS_BITBUCKET_API_USER=$email \
    ATLANTIS_BITBUCKET_TOKEN=$token ATLANTIS_BITBUCKET_WEBHOOK_SECRET=$SECRET \
    ATLANTIS_REPO_ALLOWLIST=bitbucket.org/$BB_REPO
}

g() { GIT_ASKPASS=$WORK/askpass GIT_TERMINAL_PROMPT=0 git -C "$WORK/repo" -c credential.helper= "$@"; }
push() { g push -q origin "$@" 2> "$WORK/push" || { cat "$WORK/push"; return 1; }; }

# restrict <kind> [value], prints the id
restrict() {
  api admin POST "$R/branch-restrictions" "$(jq -nc --arg k "$1" --arg b "$BASE" --argjson v "${2:-null}" \
    '{kind: $k, branch_match_kind: "glob", pattern: $b, users: [], groups: []} + (if $v then {value: $v} else {} end)')" \
    | tee "$WORK/out" | jq -er .id || { cat "$WORK/out" >&2; return 1; }
}
unrestrict() { api admin DELETE "$R/branch-restrictions/$1"; }

vcs_setup() {
  # shellcheck disable=SC2016
  printf '#!/bin/sh\necho "$BB_TOKEN"\n' > "$WORK/askpass"
  chmod +x "$WORK/askpass"
  mkdir "$WORK/repo"
  g init -q
  g remote add origin "https://x-bitbucket-api-token-auth@bitbucket.org/$BB_REPO.git"
  g checkout -q -b "$BASE"
  cp -r terraform/. "$WORK/repo"
  g add -A
  g commit -q -m "Add test projects"
  push "$BASE"
  for r in require_no_changes_requested require_tasks_to_be_completed "require_passing_builds_to_merge 1"; do
    # shellcheck disable=SC2086
    restrict $r > /dev/null
  done
  ENFORCE=$(restrict enforce_merge_checks)
}

vcs_teardown() {
  set +e
  local id
  for id in $(api main GET "$R/pullrequests?state=OPEN&pagelen=50&q=destination.branch.name%3D%22$BASE%22" | jq -r '.values[].id'); do
    # Some may be closed already.
    api main POST "$R/pullrequests/$id/decline" > /dev/null 2>&1
  done
  for id in $(api admin GET "$R/branch-restrictions?pagelen=100&pattern=$BASE" | jq -r --arg b "$BASE" '.values[] | select(.pattern == $b) | .id'); do
    unrestrict "$id"
  done
  # shellcheck disable=SC2046
  push --delete $(g ls-remote --heads origin "$BASE*" | sed 's#.*refs/heads/##')
}

# change <project>...
change() {
  local p
  for p in "$@"; do sed -i "s/default = \".*\"/default = \"$(date +%s%N)\"/" "$WORK/repo/$p/main.tf"; done
  g commit -q -a -m "Change $*"
}

# new_pr <name> <draft> <project>..., sets PR and BRANCH
new_pr() {
  BRANCH=$BASE-$1
  g checkout -q "$BASE"
  g pull -q origin "$BASE"
  g checkout -q -b "$BRANCH"
  change "${@:3}"
  push "$BRANCH"
  PR=$(api main POST "$R/pullrequests" "$(jq -nc --arg s "$BRANCH" --arg d "$BASE" --argjson draft "$2" \
    '{title: $s, draft: $draft, source: {branch: {name: $s}}, destination: {branch: {name: $d}}}')" | jq -er .id)
  echo "https://bitbucket.org/$BB_REPO/pull-requests/$PR"
}

# Changes the base branch, so that the PR gets behind (and conflicts, if it changes the same file).
change_base() {
  g checkout -q "$BASE"
  g pull -q origin "$BASE"
  change "$@"
  push "$BASE"
  g checkout -q "$BRANCH"
  sleep 5
}

request_changes() { api main POST "$R/pullrequests/$PR/request-changes" > /dev/null; }
clear_changes() { api main DELETE "$R/pullrequests/$PR/request-changes"; }
# build <key> <state>
build() {
  api main POST "$R/commit/$(g rev-parse "$BRANCH")/statuses/build" \
    "{\"key\": \"$1\", \"state\": \"$2\", \"url\": \"https://example.com\"}" > /dev/null
  sleep 2
}

comments() { api main GET "$R/pullrequests/$1/comments?pagelen=100&sort=-id" | jq '[.values[] | select(.deleted | not)]'; }
last_comment_id() { comments "$1" | jq '[.[].id] | max // 0'; }
comments_since() { comments "$1" | jq -r --argjson since "$2" 'sort_by(.id)[] | select(.id > $since) | .content.raw'; }

# Replays the webhook locally, so that there is no need to expose Atlantis.
# The actor has no uuid, otherwise Atlantis would ignore its own comments.
send_event() {
  local body sig
  # The mergeability API has a low rate limit.
  sleep 5
  body=$(api main GET "$R/pullrequests/$1" | jq -c --arg c "${3:-}" \
    '{actor: {account_id: "harness"}, repository: .destination.repository, pullrequest: ., comment: {content: {raw: $c}}}')
  sig=$(printf %s "$body" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
  printf %s "$body" | curl -sS --fail-with-body -o /dev/null -H "X-Event-Key: $2" -H "X-Request-UUID: harness" \
    -H "X-Hub-Signature: sha256=$sig" --data-binary @- "http://localhost:$PORT/events"
}
