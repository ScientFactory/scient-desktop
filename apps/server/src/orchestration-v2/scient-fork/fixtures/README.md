# Scient orchestration replay fixtures

`thread_fork_native/codex_transcript.ndjson` supports Scient's retained-history,
native-boundary, refusal, retry and queued-message-budget tests. It is a
deterministic protocol replay, not qualification against a live Codex service.
Upstream retired its copy in `32d8f8f0d0` (#22599); keep that upstream path
deleted. Scient owns this copy because its additional integration cases still
consume the source and fork turns.

The file is byte-identical to
`pingdotgg/t3code` commit `81dea7821dca30b417182db6fa0cb99a0195bfd8`,
path `apps/server/src/orchestration-v2/testkit/fixtures/thread_fork_native/codex_transcript.ndjson`.
It contains 6,632 bytes, with SHA-256
`4280ecd663d2a81fb6d8cdb2bcb346726e79d5450c061cf44483e9affe4979dd`.
The repository's root `LICENSE` retains T3 Tools Inc.'s MIT notice.
This test input is not a runtime dependency or a downloaded provider fixture.

To reproduce the import from a checkout containing that immutable commit:

```sh
git show 81dea7821dca30b417182db6fa0cb99a0195bfd8:apps/server/src/orchestration-v2/testkit/fixtures/thread_fork_native/codex_transcript.ndjson \
  > apps/server/src/orchestration-v2/scient-fork/fixtures/thread_fork_native/codex_transcript.ndjson
shasum -a 256 apps/server/src/orchestration-v2/scient-fork/fixtures/thread_fork_native/codex_transcript.ndjson
```

## Single-fork merge-back

`thread_merge_back_continue/` retains the Codex and Claude protocol transcripts
used by `testkit/ThreadMergeBack.integration.test.ts`. Scient's four cases
verify native identity, frozen history, bounded delta delivery, marker recall
and isolation between sibling forks. Only the single-fork scenario reads this
directory; sibling scenarios retain their existing upstream fixture paths.

Both files are byte-identical to `pingdotgg/t3code` commit
`81dea7821dca30b417182db6fa0cb99a0195bfd8`, under
`apps/server/src/orchestration-v2/testkit/fixtures/thread_merge_back_continue/`.
Upstream retired those copies in `32d8f8f0d0` (#22599); keep the former paths
deleted. The repository's root `LICENSE` retains T3 Tools Inc.'s MIT notice.

- `codex_transcript.ndjson`: 40,543 bytes, SHA-256
  `6a6dc32ae47dade7016e69ba496df7a90a0f6bedc4bd66e881bff32ad5924062`.
- `claude_transcript.ndjson`: 16,970 bytes, SHA-256
  `7c20317c319da0b573dace2a5fe8912ffcabec42a8d49956fb0d7dcecc37c14f`.

These are UTF-8 NDJSON replay data, not executable peers, runtime downloads or
live-provider qualification. Recorded permission settings and provider identity
strings are protocol expectations, not instructions to execute tools or contact
services. The replay layers replace provider transports. Server packaging stages
only its explicit runtime assets, not these test fixtures.

To reproduce the one-off import from that immutable commit:

```sh
mkdir -p apps/server/src/orchestration-v2/scient-fork/fixtures/thread_merge_back_continue
for driver in codex claude; do
  git show "81dea7821dca30b417182db6fa0cb99a0195bfd8:apps/server/src/orchestration-v2/testkit/fixtures/thread_merge_back_continue/${driver}_transcript.ndjson" \
    > "apps/server/src/orchestration-v2/scient-fork/fixtures/thread_merge_back_continue/${driver}_transcript.ndjson"
done
shasum -a 256 apps/server/src/orchestration-v2/scient-fork/fixtures/thread_merge_back_continue/*.ndjson
```
