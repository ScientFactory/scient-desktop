#!/usr/bin/env bash
# SCIENT-FORK:START — wait for another job of this run attempt before using its artifact.
# Usage: wait-for-job.sh <job name suffix> <artifact name> [--uploaded]
# Succeeds once that job has succeeded and uploaded the artifact in this attempt, and fails as
# soon as it ends otherwise. With --uploaded it succeeds as soon as that job has uploaded the
# artifact in this attempt, before the job finishes; anything that `needs` the job still requires
# it to succeed. A job a partial rerun reused from an earlier attempt is not listed again; its
# artifact, uploaded only after that job's steps succeeded, stands for it.
# The step output `artifact-id` names that upload; download it by ID, not by name, and pass the
# download `github-token` so it reads the same REST API this wait checked.
set -euo pipefail
export JOB_SUFFIX="$1"
artifact="$2"
uploaded=false
[ "${3:-}" = "--uploaded" ] && uploaded=true
jobs="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs?per_page=100"
artifacts="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts?name=$artifact"
# A failed API request is retried a few times; one that keeps failing fails the wait, rather
# than reading as a job that uploaded nothing. Only a successful attempt's output is passed on:
# `gh api` can print a failed request's error body to stdout.
api() {
  local attempt out
  for attempt in 1 2 3 4 5; do
    if out=$(gh api "$@"); then
      printf '%s\n' "$out"
      return 0
    fi
    echo "GitHub API request failed (attempt $attempt of 5)." >&2
    [ "$attempt" -lt 5 ] && sleep $((attempt * 5))
  done
  return 1
}
# GitHub's artifact reads agree only a moment after an upload is first listed. In a probe, one in
# nine downloads begun within a second of the listing failed, whether download-artifact looked the
# ID up itself (`None of the provided artifact IDs were found`) or through the REST API (`Not
# Found`). So an upload is named only once the REST download endpoint has served it twice, five
# seconds apart; one it still refuses after 30 polls fails the wait.
serves() {
  [ "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $GH_TOKEN" \
    "${GITHUB_API_URL:-https://api.github.com}/repos/$GITHUB_REPOSITORY/actions/artifacts/$1/zip" || true)" = 302 ]
}
refused=0
# Takes the newest artifact uploaded at or after $1, exiting once it can be downloaded; fails when
# there is none yet. A rerun's job must not take an earlier attempt's copy.
take_since() {
  local id
  if ! id=$(SINCE="$1" api "$artifacts" --jq '[.artifacts[] | select(.expired == false and .created_at >= env.SINCE)] | max_by(.created_at) | .id // empty'); then
    echo "Could not list $artifact uploads." >&2
    exit 1
  fi
  [ -n "$id" ] || return 1
  if serves "$id" && sleep 5 && serves "$id"; then
    echo "artifact-id=$id" >>"${GITHUB_OUTPUT:-/dev/null}"
    exit 0
  fi
  refused=$((refused + 1))
  echo "$artifact $id is listed, but GitHub does not serve its download yet ($refused of 30)." >&2
  if [ "$refused" -ge 30 ]; then
    echo "$artifact $id is listed, but GitHub still refuses to download it." >&2
    exit 1
  fi
}
while :; do
  if ! job=$(api "$jobs" --jq '[.jobs[] | select(.name | endswith(env.JOB_SUFFIX))][0] // {} | "\(.status // "absent") \(.conclusion // "-") \(.started_at // "-")"'); then
    echo "Could not read $JOB_SUFFIX's status." >&2
    exit 1
  fi
  read -r status conclusion started <<<"$job"
  case "$status" in
    absent)
      take_since "" || :
      ;;
    completed)
      if [ "$conclusion" != success ]; then
        echo "$JOB_SUFFIX ended without success ($conclusion)." >&2
        exit 1
      fi
      if ! take_since "$started"; then
        echo "$JOB_SUFFIX succeeded without uploading $artifact." >&2
        exit 1
      fi
      ;;
    *)
      if $uploaded && [ "$started" != - ]; then take_since "$started" || :; fi
      ;;
  esac
  sleep 10
done
# SCIENT-FORK:END
