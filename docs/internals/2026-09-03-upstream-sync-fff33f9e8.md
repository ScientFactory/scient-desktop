# T3 alignment through fff33f9e8

Status: automatically qualified local Antigravity alignment candidate.
Integrated visual review, live account acceptance, hosted target
qualification, PR review, and merge to `main` are separate gates. This receipt
does not authorize publication, telemetry, cloud, or mobile activation.

Role: dated evidence for this frozen alignment, not a second architecture or
operating protocol. The continuing procedure is the
[upstream alignment protocol](./upstream-alignment-protocol.md). Current provider
behavior belongs in [provider architecture](./providers.md),
[provider lifecycle](./provider-lifecycle.md), and
[Antigravity user documentation](../user/providers-antigravity.md).

## Exact boundaries

- Canonical Scient base before this staged alignment:
  `784b88f891223c2e1273de8fc84291db12453f25`.
- The pre-Antigravity phase is recorded in
  [the preceding receipt](./2026-09-03-upstream-sync-652515a34.md), including its
  literal upstream merge `afc5f4f2a6072a3c61af1063be7ea2eebeb4347a`.
- Previous official boundary: `652515a349741d234111b85f27597be3265d1ffc`.
- Local preparation `025c09e07f9deca0c8ff2bfa5652fdb42e4c4a79` isolates the
  existing `agy` implementation under legacy names; it is the owned first
  parent for this merge, not a replacement for upstream ancestry.
- Official target: `fff33f9e851912363c5b1f3ac65598be35eb5f0d` from
  `pingdotgg/t3code`, exact tag `v0.0.39-nightly.20260903.1270`.
- Range: six commits, 193 upstream-touched paths; the initial merge required
  49 textual conflict resolutions, followed by semantic review of auto-merges.
- Branch: `codex/t3-sync-antigravity-20260903`.
- History-preserving upstream merge:
  `81384de745aa1a482c40646ed046633559936b7e`, with the preparation commit as
  first parent and the exact official target as second parent.
- Subsequent owned-main integration:
  `4fa045245e57a7a4ac17fd88e84292c1ee180f7b` merges
  `6c33a9c183a56dc659f289434fa07b2395b45753` (PR #228) without conflicts. It
  preserves the newly landed catalog-publication authentication fix and its
  regression test. It does not move the frozen T3 target.
- `origin` remains Scient's writable remote; `upstream` push remains `DISABLED`.

This is a frozen checkpoint. Later upstream work is not silently added, and
the candidate does not claim canonical or remote `main` has been advanced.

## Received behavior

| Commit      | User-facing or operational result                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `06336460c` | Google's official Antigravity ACP agent: account setup, native sessions and continuations, model discovery, files, permissions, questions, and text-generation helpers across server/web/desktop/mobile. |
| `2aa907b19` | Mobile file-preview failures show an error instead of an endless spinner.                                                                                                                                |
| `2b745efe5` | Usage pricing refreshes for newly encountered models instead of waiting a day for the existing rate-table cache.                                                                                         |
| `19c97ea56` | Failed preview capture releases the composer so the user can continue.                                                                                                                                   |
| `1e0518730` | Older account-provided Gemini generations remain selectable under the legacy-model grouping.                                                                                                             |
| `fff33f9e8` | Release jobs can reuse dependency-verification results; a missing cache still performs normal verification.                                                                                              |

The ordinary upstream commits remain literal ancestry. No feature was
cherry-picked or reimplemented to avoid its merge conflicts.

## Ownership and conflict composition

### Official ACP is the default engine, not a second Scient rewrite

T3 owns the ACP transport, protocol mapping, authentication controller, callback
validation, per-instance profile, session lifecycle, model selection, approval
handling, and structured-generation sandbox. Scient composes its existing
driver capabilities and shared lifecycle managers around those implementations.
The auth controller, Antigravity protocol/support, callback parser, and auth
environment policy remain the upstream implementations.

Scient's added work is bounded to these seams:

- `AntigravityLifecycleBridge.ts` maps T3 auth/install state to existing Scient
  connection/runtime actions. Settings and composer keep the compact shared
  setup surface; mobile and direct setup RPCs retain the upstream route.
- Native runtime resolution still gives explicit paths priority, then managed
  ACP, then the system ACP executable. Custom/system paths are not taken over
  or removed. Runtime removal also checks explicit paths owned by other
  configured provider instances.
- The official paired-executable installer receives the qualified Scient
  catalog and exact reviewed release identity. It remains the only ACP
  installer: no duplicate generic runtime engine or shell installation path.
- A damaged managed generation is repaired only after a staged replacement
  passes archive, member, executable, and initialization checks. Existing
  leases prevent replacement/removal. Filesystem rollback retains a recovery
  backup if restoration itself fails; cancellation does not discard that copy.
- Voice transcript correction calls the same upstream structured helper used
  for titles/commits. It retains the existing voice prompt, language fidelity,
  response limits, and error mapping; no parallel legacy process is launched
  for an ACP account. The helper output type is checked without a type cast.
- Scient-specific fork/attachment/rich-output and other-provider behavior is
  retained at shared host seams, rather than replacing those upstream hosts.

### Existing conversations and installations

Scient's previous `agy --stream-json` protocol and T3's ACP protocol are not
interchangeable. No credentials or persisted cursor formats are converted.

- Version-1 ACP cursors stay ACP; version-2 legacy cursors route to the existing
  `agy` adapter. The legacy instance is created only when needed.
- Explicit legacy executable names and default hosts without an official ACP
  artifact use the legacy driver. In particular, Intel macOS is not falsely
  advertised as a supported official ACP download target.
- The compatibility adapter subscribes to the legacy event bus before starting
  its first session, so an immediate `session.started` event cannot be lost.
- ACP instance profiles remain isolated. Legacy credentials stay in the old
  provider-owned store. An existing legacy account is not silently copied into
  an ACP profile; a new ACP account may need its own explicit sign-in.
- Obsolete duplicate documentation describing all Antigravity as non-ACP is
  replaced with a clearly labelled legacy-compatibility section. The older
  capability audit remains historical evidence, with a dated scope notice.

### Authentication and minimal UI

The configured upstream auth method remains authoritative: personal Google,
Gemini Enterprise, Gemini API key, or Agent Platform. Credential-only methods
do not pretend to require a Google browser flow. Ambient credentials do not
silently change the selected method.

Passive checks do not authenticate or open a browser. Sign-in begins from an
explicit click, not mounting a component. A normal Google callback stays
automatic. Remote-device callback pasting remains a collapsed fallback, with
`callback_url` distinct from providers that accept a short authorization code.

The direct T3 auth service retains initiating-client ownership. Scient's
existing shared lifecycle manager owns its supervised attempt through a
private controller-owner token; authorized lifecycle clients can interact with
that shared operation. This alignment does not invent a new client-ownership
policy. Responses must match the live flow, and teardown cancels its owned
attempt. Disconnect clears the profile credentials but does not erase saved
API-key settings or external Application Default Credentials.

### Runtime update continuity

The data-only update feed has a separate `antigravityAcp` release family;
legacy `antigravity` remains unchanged. Older feeds lacking the new family stay
valid and the bundled qualified floor remains usable offline.

The app, not the feed, owns allowed hosts, five native targets, archive layout,
member names, launch flags, and support. The catalog supplies immutable digest,
sizes, and release identities. Registry semantic version and native binary
version are distinct. A newer registry revision pointing to the same immutable
archive updates its receipt without another download; concurrent different
artifacts cannot be joined just because their version labels match.

ACP discovery adds one independent release-family lane to the existing
two-hour workflow. Five native runners use the app's ACP installer and
unauthenticated initialization before promotion. Policy/runtime/dependency
changes during qualification invalidate publication. Other providers keep
their existing engines and qualification lanes. No remote catalog was
published or workflow triggered during this local alignment.

### Narrow upstream file-path correction found during testing

The inherited client-file resolver rejected newly created nested files under
macOS's `/var` alias of `/private/var`, and checking only a parent directory
missed a final-file symlink pointing outside the allowed roots. The adapter
now canonicalizes the complete existing target, or the nearest existing
ancestor for a new file, and canonicalizes the allowed roots consistently.
Dangling symlinks fail explicitly. A legitimate name such as `..notes` is not
mistaken for parent traversal.

This is a local correction in the upstream adapter, not a new file-access
system. Regression coverage includes nested creation, final-file symlink
read/write rejection, dangling links, and missing descendants below a linked
directory. It does not claim race-proof OS sandboxing against arbitrary
concurrent filesystem mutation.

### Protected product and operations boundaries

- Scient-visible labels replace inherited public T3 labels; compatibility
  package names, profile/storage roots, environment variables, and protocol
  identifiers remain intact.
- No migration renumbering, user-data migration, telemetry activation, new
  cloud authority, or mobile/release publication is introduced.
- Release-verification cache actions use immutable action SHAs. Existing
  release gates, credentials, review, and final publication approval remain.
- Runtime maintenance remains independent from account readiness; a user can
  manage a supported managed installation before signing in.

## Qualification

Focused tests cover official/legacy routing, first-event delivery, callback
handoff and cancellation, settings/source/target classification, passive
driver behavior, installer failure/rollback/lease cases, catalog reconciliation,
registry revision handling, voice-helper composition, and filesystem bounds.

The real bundled official package passed local native **darwin-arm64**
download, verification, installation, unauthenticated ACP initialization,
activation, and removal using a temporary private root:

```text
node apps/server/scripts/qualify-antigravity-acp-catalog.ts --catalog apps/server/src/scient/providerLifecycle/managed-runtime-catalog.json
```

The tested registry version is `1.0.0`; its native identity is
`agy_acp_server_20260818_01_RC01`. This is not a claim that the latest remote
registry release, a live Google account, or the other native targets passed.

Final repository qualification:

| Check                                                  | Result                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vp fmt --check`                             | Passed.                                                                                                                                                                                                                                  |
| `pnpm exec vp lint --report-unused-disable-directives` | Passed after correcting a newly added test's direct platform read; the final quiet rerun checks the same error gate. Existing/inherited advisory warnings remain, rather than being globally suppressed or refactored in this alignment. |
| `pnpm run typecheck`                                   | Passed across all 27 tasks.                                                                                                                                                                                                              |
| `pnpm run test`                                        | Passed all 26 suites: 14,599 tests, including 4,931 server, 4,870 web, 1,179 mobile, and 761 desktop tests. Existing skips remain explicit.                                                                                              |
| `pnpm run build`                                       | Passed all five build tasks on the candidate containing the main refresh.                                                                                                                                                                |
| `pnpm run test:desktop-smoke`                          | Passed; Electron smoke test completed.                                                                                                                                                                                                   |
| `pnpm brand:check`                                     | Passed across 1,616 product-surface files after correcting three inherited public labels.                                                                                                                                                |
| Analysis, onboarding, Skills, and LaTeX seam checks    | All passed.                                                                                                                                                                                                                              |
| Whitespace/conflict-marker checks                      | Passed; no unresolved Git conflicts.                                                                                                                                                                                                     |

The full application suite above ran on the final application code. PR #228
subsequently added only one workflow environment variable and its new script
test. The three focused publication/catalog/artifact test files passed all 13
tests on the combined head; the complete scripts suite and its typecheck were
also rerun after that merge. No application code was changed by the refresh.

During qualification, the full server suite first exposed the aliased-root
file-creation failure described above; it passed after the targeted fix and
regression coverage. Connection-manager tests likewise exposed a dropped
callback-response kind, which is now carried through the shared operation
snapshot. Early desktop test setup encountered a dependency auto-install race;
subsequent focused and full runs passed without a product workaround. These
failures are recorded rather than represented as an uninterrupted green run.

Provenance is checked against owned base
`6c33a9c183a56dc659f289434fa07b2395b45753`, candidate `HEAD`, and official
target `fff33f9e851912363c5b1f3ac65598be35eb5f0d`. Both upstream merge parents
and the owned-main refresh remain literal ancestry.

The mobile native static command completed, but SwiftLint, ktlint, and detekt
were unavailable and explicitly skipped. Mobile TypeScript/unit coverage does
not substitute for a physical-device or platform build.

## Required acceptance before shipping

Use a candidate app with synthetic Scient state and an explicitly authorized
test account; never copy production credentials or user databases into it.

1. Install, inspect, update/repair, and remove managed ACP; verify Settings and
   composer remain compact and usable before and after sign-in.
2. Test one-click Google sign-in, cancellation, sign-out, and the remote
   callback fallback. Check credential-only setup on the selected auth method.
3. Start an ACP conversation, exercise files/attachments, permissions and
   questions, switch model, cancel a turn, and resume after restarting.
4. Resume a synthetic legacy conversation with the legacy runtime; verify it
   is not silently restarted as ACP or given the wrong credential profile.
5. Check custom/system resolution and one other provider; visually inspect the
   cumulative composer/timeline changes from the preceding phase.
6. Run hosted native ACP qualification for Windows/Linux variants and confirm
   Intel macOS's documented legacy/remote path. Do not infer these from an
   Apple-silicon run.

Keep the worktree and local history for review. Pushing, PR creation, merging
to `main`, production account interaction, and publication are not performed
by this local qualification pass.
