# shellcheck shell=bash

second_account() { [ -n "${BB2_TOKEN:-}" ] || skip "needs the second account"; }

test_clean() {
  start a
  new_pr clean false p1
  plan "$PR"
  apply "$PR"
  expect_applied "$PR"
}

test_draft() {
  start a
  new_pr draft true p1
  plan "$PR"
  apply "$PR"
  expect_blocked "$PR" DRAFT
}

test_conflict() {
  start a
  new_pr conflict false p1
  change_base p1
  plan "$PR"
  apply "$PR"
  expect_blocked "$PR" conflicts
}

test_changes_requested() {
  start a
  new_pr changes false p1
  plan "$PR"
  request_changes
  apply "$PR"
  expect_blocked "$PR" no_changes_requested
  clear_changes
  apply "$PR"
  expect_applied "$PR"
}

test_unresolved_task() {
  local task
  start a
  new_pr task false p1
  plan "$PR"
  task=$(api main POST "$R/pullrequests/$PR/tasks" '{"content": {"raw": "Do it"}}' | jq .id)
  apply "$PR"
  expect_blocked "$PR" resolved_tasks
  api main PUT "$R/pullrequests/$PR/tasks/$task" '{"state": "RESOLVED"}' > /dev/null
  apply "$PR"
  expect_applied "$PR"
}

test_not_enforced() {
  unrestrict "$ENFORCE"
  trap 'stop; restrict enforce_merge_checks > /dev/null' EXIT
  start a
  new_pr advisory false p1
  plan "$PR"
  request_changes
  build ci FAILED
  apply "$PR"
  expect_applied "$PR"
}

test_partial_apply() {
  start a
  new_pr partial false p1 p2
  plan "$PR"
  apply "$PR" p1
  expect_applied "$PR"
  apply "$PR" p2
  expect_applied "$PR"
}

test_failed_apply() {
  start a
  new_pr failed false p1
  plan "$PR"
  touch "$WORK/fail-apply"
  apply "$PR"
  expect "$PR" "local-exec provisioner error"
  rm "$WORK/fail-apply"
  plan "$PR"
  apply "$PR"
  expect_applied "$PR"
}

test_other_build() {
  start a
  new_pr build false p1
  plan "$PR"
  build ci FAILED
  apply "$PR"
  expect_blocked "$PR" failed_builds
  build ci INPROGRESS
  apply "$PR"
  expect "$PR" "in_progress_builds)"
  build ci SUCCESSFUL
  apply "$PR"
  expect_applied "$PR"
}

test_own_failed_plan() {
  start a
  new_pr plan false p1
  plan "$PR"
  build "atlantis/plan" FAILED
  apply "$PR"
  expect_blocked "$PR" failed_builds
}

test_commits_behind() {
  local id
  id=$(restrict require_commits_behind 0)
  # shellcheck disable=SC2064
  trap "stop; unrestrict $id" EXIT
  start a
  new_pr behind false p1
  change_base p2
  plan "$PR"
  apply "$PR"
  expect_blocked "$PR" maximum_commits_behind
  g merge -q --no-edit "$BASE"
  push "$BRANCH"
  sleep 5
  plan "$PR"
  apply "$PR"
  expect_applied "$PR"
}

test_approvals() {
  local a d uuid
  second_account
  uuid=$(api second GET user | jq -r '.uuid | @uri')
  a=$(restrict require_approvals_to_merge 1)
  d=$(restrict require_default_reviewer_approvals_to_merge 1)
  # shellcheck disable=SC2064
  trap "stop; unrestrict $a; unrestrict $d; api admin DELETE $R/default-reviewers/$uuid" EXIT
  api admin PUT "$R/default-reviewers/$uuid" > /dev/null
  start a
  new_pr approvals false p1
  plan "$PR"
  apply "$PR"
  expect_blocked "$PR" "minimum_approvals, minimum_default_reviewer_approvals"
  api second POST "$R/pullrequests/$PR/approve" > /dev/null
  apply "$PR"
  expect_applied "$PR"
}

test_cannot_merge() {
  second_account
  AS=second start a
  new_pr cannot-merge false p1
  plan "$PR"
  request_changes
  apply "$PR"
  expect_blocked "$PR" no_changes_requested
  clear_changes
  apply "$PR"
  expect_applied "$PR"
}

test_automerge() {
  start a --automerge
  new_pr automerge false p1
  plan "$PR"
  request_changes
  apply "$PR"
  expect_blocked "$PR" no_changes_requested
  clear_changes
  apply "$PR"
  expect_applied "$PR"
  [ "$(api main GET "$R/pullrequests/$PR" | jq -r .state)" = MERGED ] || fail "not merged"
}

test_long_status_name() {
  start a --vcs-status-name="$(printf 'a%.0s' {1..35})"
  new_pr long false p1
  plan "$PR"
  request_changes
  apply "$PR"
  expect_blocked "$PR" no_changes_requested
  clear_changes
  apply "$PR"
  expect_applied "$PR"
}

test_too_long_status_name() {
  local out
  out=$(trap stop EXIT; start a --vcs-status-name="$(printf 'a%.0s' {1..36})") && fail "it started"
  [[ $out == *"cannot be longer than 35 characters"* ]] || fail "$out"
}

test_two_servers() {
  local a=(--vcs-status-name=one --ignore-vcs-status-names=two) b=(--vcs-status-name=two --ignore-vcs-status-names=one)
  new_pr two false p1
  start a "${a[@]}"; plan "$PR"; stop
  start b "${b[@]}"; plan "$PR"; stop
  request_changes
  start a "${a[@]}"; apply "$PR"; expect_blocked "$PR" no_changes_requested; stop
  start b "${b[@]}"; apply "$PR"; expect_blocked "$PR" no_changes_requested; stop
  clear_changes
  start a "${a[@]}"; apply "$PR"; expect_applied "$PR"; stop
  start b "${b[@]}"; apply "$PR"; expect_applied "$PR"
}
