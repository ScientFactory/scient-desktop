#!/usr/bin/env bash
# Exits 0 when `cc` builds and runs a pthread program, as the process-tree fixtures need.
set -euo pipefail
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
cat > "$dir/probe.c" <<'C'
#include <pthread.h>
static int marker;
static void *run(void *arg) { return arg; }
int main(void) {
  pthread_t thread;
  void *result = 0;
  if (pthread_create(&thread, 0, run, &marker) || pthread_join(thread, &result)) return 1;
  return result == &marker ? 0 : 1;
}
C
cc -pthread "$dir/probe.c" -o "$dir/probe"
"$dir/probe"
