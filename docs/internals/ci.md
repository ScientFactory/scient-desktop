# CI quality gates

> For maintainers. Using T3 Code? See [docs/user](../user/).

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs four jobs on pull requests and
pushes to `main`:

- **Check**: `vp check` (format and lint; this repo sets `typeCheck: false` in its lint options),
  then `vpr typecheck` for the workspace type check. The same job
  builds the desktop pipeline (`vp run build:desktop`) and verifies the preload bundle exists and
  still exports its expected symbols.
- **Test**: `vp run test` across the workspace.
- **Mobile Native Static Analysis**: `vp run lint:mobile` on macOS, wrapping
  `scripts/mobile-native-static-check.ts`.
- **Release Smoke**: exercises release-only workflow steps through `scripts/release-smoke.ts`, so
  release breakage surfaces on PRs rather than at tag time.

[`promote-release.yml`](../../.github/workflows/promote-release.yml) manually fast-forwards
`release/stable` to an exact green `main` commit. The manual-only
[`release.yml`](../../.github/workflows/release.yml) then builds macOS (`arm64` and `x64`), Linux
(`x64`), Windows (`x64`), and the matching remote-server artifact from that exact commit. A
publishing candidate waits at the protected `production` environment after assembly so its exact
artifact can be accepted before publication. macOS publication requires signing and notarization;
Windows uses Azure Trusted Signing unless an unsigned installer is explicitly approved for that
candidate. Non-publishing rehearsals may be unsigned, but they never create or overwrite a tag or
release.

See [Release Checklist](../operations/release.md) for the full release/signing setup checklist.
