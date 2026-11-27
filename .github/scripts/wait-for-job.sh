#!/usr/bin/env bash
# SCIENT-FORK:START — wait for another job of this run attempt before using its artifact.
# Usage: wait-for-job.sh <job name suffix> <artifact name> [--uploaded]
# Succeeds once that job has succeeded and uploaded the artifact in this attempt, and fails as
# soon as it ends otherwise. With --uploaded it succeeds as soon as that job has uploaded the
# artifact in this attempt, before the job finishes; anything that `needs` the job still requires
# it to succeed. A job a partial rerun reused from an earlier attempt is not listed again; its
# artifact, uploaded only after that job's steps succeeded, stands for it.
# The step output `artifact-id` names that upload; download it by ID, not by name.
set -euo pipefail
export JOB_SUFFIX="$1"
artifact="$2"
uploaded=false
[ "${3:-}" = "--uploaded" ] && uploaded=true
jobs="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs?per_page=100"
artifacts="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts?name=$artifact"
# A failed API request is retried a few times; one that keeps failing fails the wait, rather
# than reading as a job that uploaded nothing.
api() {
  local attempt
  for attempt in 1 2 3 4 5; do
    gh api "$@" && return 0
    echo "GitHub API request failed (attempt $attempt of 5)." >&2
    [ "$attempt" -lt 5 ] && sleep $((attempt * 5))
  done
  return 1
}
# The newest artifact uploaded at or after $1. A rerun's job must not take an earlier attempt's copy.
artifact_since() {
  local id
  if ! id=$(SINCE="$1" api "$artifacts" --jq '[.artifacts[] | select(.expired == false and .created_at >= env.SINCE)] | max_by(.created_at) | .id // empty'); then
    echo "Could not list $artifact uploads." >&2
    exit 1
  fi
  [ -n "$id" ] || return 1
  echo "artifact-id=$id" >>"${GITHUB_OUTPUT:-/dev/null}"
}
while :; do
  if ! job=$(api "$jobs" --jq '[.jobs[] | select(.name | endswith(env.JOB_SUFFIX))][0] // {} | "\(.status // "absent") \(.conclusion // "-") \(.started_at // "-")"'); then
    echo "Could not read $JOB_SUFFIX's status." >&2
    exit 1
  fi
  read -r status conclusion started <<<"$job"
  case "$status" in
    absent)
      if artifact_since ""; then exit 0; fi
      ;;
    completed)
      if [ "$conclusion" != success ]; then
        echo "$JOB_SUFFIX ended without success ($conclusion)." >&2
        exit 1
      fi
      if artifact_since "$started"; then exit 0; fi
      echo "$JOB_SUFFIX succeeded without uploading $artifact." >&2
      exit 1
      ;;
    *)
      if $uploaded && [ "$started" != - ] && artifact_since "$started"; then exit 0; fi
      ;;
  esac
  sleep 10
done
# SCIENT-FORK:END
