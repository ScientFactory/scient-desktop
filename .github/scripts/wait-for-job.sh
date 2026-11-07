#!/usr/bin/env bash
# SCIENT-FORK:START — wait for another job of this run attempt before using its artifact.
# Usage: wait-for-job.sh <job name suffix> <artifact name>
# Succeeds once that job has succeeded in this attempt, and fails as soon as it ends otherwise.
# A job a partial rerun reused from an earlier attempt is not listed again; its artifact,
# uploaded only after that job's steps succeeded, stands for it.
set -euo pipefail
export JOB_SUFFIX="$1"
artifact="$2"
jobs="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs?per_page=100"
artifacts="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts?name=$artifact"
while :; do
  state=$(gh api "$jobs" --jq '[.jobs[] | select(.name | endswith(env.JOB_SUFFIX))][0] // {} | "\(.status // "absent") \(.conclusion // "")"')
  case "$state" in
    "completed success") exit 0 ;;
    completed*)
      echo "$JOB_SUFFIX ended without success ($state)." >&2
      exit 1
      ;;
    absent*)
      if [ "$(gh api "$artifacts" --jq '.total_count')" -gt 0 ]; then exit 0; fi
      ;;
  esac
  sleep 10
done
# SCIENT-FORK:END
