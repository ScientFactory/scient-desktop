#!/usr/bin/env bash
# SCIENT-FORK:START — wait for another job of this run attempt before using its artifact.
# Usage: wait-for-job.sh <job name suffix> <artifact name> [--uploaded]
# Succeeds once that job has succeeded in this attempt, and fails as soon as it ends otherwise.
# With --uploaded it succeeds as soon as the artifact exists, before its job finishes; the job
# must still succeed for anything that `needs` it, and failing without the artifact fails here.
# A job a partial rerun reused from an earlier attempt is not listed again; its artifact,
# uploaded only after that job's steps succeeded, stands for it.
set -euo pipefail
export JOB_SUFFIX="$1"
artifact="$2"
uploaded=false
[ "${3:-}" = "--uploaded" ] && uploaded=true
jobs="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs?per_page=100"
artifacts="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts?name=$artifact"
has_artifact() { [ "$(gh api "$artifacts" --jq '.total_count')" -gt 0 ]; }
while :; do
  if $uploaded && has_artifact; then exit 0; fi
  state=$(gh api "$jobs" --jq '[.jobs[] | select(.name | endswith(env.JOB_SUFFIX))][0] // {} | "\(.status // "absent") \(.conclusion // "")"')
  case "$state" in
    "completed success")
      if ! $uploaded || has_artifact; then exit 0; fi
      echo "$JOB_SUFFIX succeeded without uploading $artifact." >&2
      exit 1
      ;;
    completed*)
      echo "$JOB_SUFFIX ended without success ($state)." >&2
      exit 1
      ;;
    absent*)
      if has_artifact; then exit 0; fi
      ;;
  esac
  sleep 10
done
# SCIENT-FORK:END
