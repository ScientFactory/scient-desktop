#!/usr/bin/env bash
# SCIENT-FORK:START — wait for another job of this run attempt before using its artifact.
# Usage: wait-for-job.sh <job name suffix> <artifact name> [--uploaded]
# Succeeds once that job has succeeded in this attempt, and fails as soon as it ends otherwise.
# With --uploaded it succeeds as soon as that job has uploaded the artifact in this attempt,
# before the job finishes; anything that `needs` the job still requires it to succeed.
# A job a partial rerun reused from an earlier attempt is not listed again; its artifact,
# uploaded only after that job's steps succeeded, stands for it.
set -euo pipefail
export JOB_SUFFIX="$1"
artifact="$2"
uploaded=false
[ "${3:-}" = "--uploaded" ] && uploaded=true
jobs="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs?per_page=100"
artifacts="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts?name=$artifact"
# An artifact uploaded at or after $1. A rerun's job must not take an earlier attempt's copy.
artifact_since() {
  [ "$(SINCE="$1" gh api "$artifacts" --jq '[.artifacts[] | select(.expired == false and .created_at >= env.SINCE)] | length > 0')" = true ]
}
while :; do
  job=$(gh api "$jobs" --jq '[.jobs[] | select(.name | endswith(env.JOB_SUFFIX))][0] // {} | "\(.status // "absent") \(.conclusion // "-") \(.started_at // "-")"')
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
      if ! $uploaded || artifact_since "$started"; then exit 0; fi
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
