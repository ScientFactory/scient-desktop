# Upstream alignment through 35be904f2f

Scient pull request: [#420](https://github.com/ScientFactory/scient-desktop/pull/420).

Date: 2026-09-30. Status: alignment qualification receipt, not release authorization.

## Frozen history

- Owned base: `136ab8ad104b92f100a6ccd8fac1e6ee0c884102`.
- Previous official integration: `d2c9281b8112dc3b2991642c4bdb985e4b08b9bb`.
- Official target: `35be904f2fc40aa6d7a42778b6895e8274f3097f`.
- Range: 20 first-parent official commits, all retained as literal ancestry.
- Tag relationship: `v0.0.45-nightly.20260930.2493-2-g35be904f2f`.
- Branch: `codex/t3-sync-35be904f2f-20260930`.
- Upstream merge: `efacdaf575f2cd3d65068d8e4e78a2ffb2b16578`; exact official target is its second parent.
- Upstream push URL: `DISABLED`.
- Owned-main catch-up (2026-10-01): `14fb2478174667b49afaf6d7405526ed897d0c16`, with owned main `e0efa3fa4346ea6b7c88c93b25b4638cea715fe4` as its second parent. The original owned base and upstream merge above remain unchanged.

## Advancements and alignment work

| Official commit | Advancement                       | User effect                                                                                                                                                                   | Composition / difficulty                                                                                                                                                                                |
| --------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `27bdf1aa14`    | Managed ChatGPT authentication    | Retains upstream account registration, token refresh, credential leases, callback and runtime machinery. Scient keeps native guided Codex sign-in and its existing installer. | Held behind backend and desktop guards. New managed-mode settings are rejected; already saved unsupported modes remain unavailable and can be changed back to native. UI hiding alone was insufficient. |
| `5e83e99c95`    | Model manifest refresh            | Receives the updated generic model catalog and Codex recommendation of 0.159.0.                                                                                               | Scient compatibility ranges and release version remain owned; CDN freshness must not roll back bundled gates.                                                                                           |
| `2cbc24fcae`    | Upstream release 0.0.43           | Keeps the official release commit in ancestry.                                                                                                                                | Does not bump Scient release identity or authorize publication.                                                                                                                                         |
| `451afcb22d`    | Pro Max / Ultrafast               | Recognizes ChatGPT Pro Max plans and displays the advertised Ultrafast tier with shorter descriptive copy.                                                                    | Availability still comes from the native provider account and model capabilities.                                                                                                                       |
| `1a553d0f5d`    | OpenCode Go usage grouping        | Usage limits from the same credential are grouped rather than counted as separate accounts across connections.                                                                | A domain-separated SHA-256 fingerprint is shared, never the raw credential; this is correlation metadata, not anonymity.                                                                                |
| `422248515a`    | Codex 0.159 protocol              | Regenerated protocol bindings support newer native provider messages.                                                                                                         | Existing Scient forks, context preambles, tool routing and continuation identity must survive adapter composition.                                                                                      |
| `ff1db030b1`    | Upstream release 0.0.44           | Keeps the official release commit in ancestry.                                                                                                                                | Scient package versions and release controls stay unchanged.                                                                                                                                            |
| `8792f95762`    | Codex install advisory regression | Tests follow the bundled compatibility advisory instead of a hard-coded release range.                                                                                        | The Scient minimum support floor remains separate from the recommended CLI version.                                                                                                                     |
| `63b61e647c`    | CodeRabbit descriptions           | Stops automated review tooling from rewriting PR descriptions.                                                                                                                | No product behavior or publication authority changes.                                                                                                                                                   |
| `60cb7d180d`    | Unresolved PR tooltips            | Unresolved pull request links use the compact link tooltip.                                                                                                                   | Preserves Scient pull request glyph policy and link ownership.                                                                                                                                          |
| `88fbc2cac7`    | Model IDs in inline code          | Names such as z-ai/glm-5.3 remain code rather than becoming misleading file chips.                                                                                            | Versioned real filenames and explicit paths still need file-link regression coverage.                                                                                                                   |
| `916ec94f93`    | Agent questions in timeline       | Pending input rows show the actual agent question.                                                                                                                            | Scient queue, reader position, cancellation and token-limit handling remain composed.                                                                                                                   |
| `55ec55b1fb`    | Workspace root links              | Clicking a workspace root opens its file explorer; copying its relative path produces a dot.                                                                                  | A Scient copy-path assumption needed a narrow fix and an additional root regression. Existing preview persistence and refresh ownership remain intact.                                                  |
| `050cfad04f`    | Grok crash recovery               | Crashed sessions stop being reusable and settle active prompts before replacement.                                                                                            | Termination must mark the old session immediately and cleanup must verify session identity under the thread lock; preserve Scient background task tracking.                                             |
| `2a23c30ea6`    | Command menu width                | Descriptions can use the full menu row width.                                                                                                                                 | Inherited shared UI variants remain the styling owner.                                                                                                                                                  |
| `0fcd5f9061`    | Multiple pull request badge       | A multi-PR badge opens the Linked pull requests panel.                                                                                                                        | Uses Scient existing right-panel surfaces and state owner; avoids a second panel implementation.                                                                                                        |
| `c18e5ea6ed`    | Diff filename clipping            | Diff file labels have enough vertical room to show their bottoms.                                                                                                             | Layout-only change; no diff or filesystem semantics change.                                                                                                                                             |
| `c2fa9fc911`    | Mobile registration copy          | The setup text names the step that registers the mobile client.                                                                                                               | Public text uses Scient. Native mobile static tools are partly unavailable on this host; mobile publication stays held.                                                                                 |
| `38969148a2`    | WSL busy-runtime fixture          | Test fixtures stay visible when the shell executable resolves to bash.                                                                                                        | Preserves the Scient server executable marker. This macOS run cannot establish native Windows/WSL acceptance.                                                                                           |
| `35be904f2f`    | Vite+ 1.0                         | Upgrades the build/test toolchain and adapts benchmark APIs and package test invocation.                                                                                      | Scient browser-provider dependencies required Vitest 5 alignment. The 150-iteration filesystem lock stress test needed a realistic explicit timeout without reducing race coverage.                     |

## Backend and protected-boundary review

The merge composed all 26 textual conflicts and reviewed cleanly merged overlaps. Native Codex connection actions, system/custom executable selection, Scient-managed runtime resolution, private home overlays, fork continuity, per-turn epochs, Skills, tool/citation handling, context preambles, and provider request budgets remain owned by their existing Scient adapters.

Subscription sharing is a separate authentication capability from installing a managed CLI. Scient denies activation before settings or secret persistence, denies driver creation before credential or process access, denies standalone installer operations, and rejects export/import/handoff/callback RPCs. Desktop callback starts and deep-link resume are gated before browser/listener work. Upstream setup/coordinator components remain in source without active mounts. The dormant production installer does not probe PATH at startup. Synthetic tests continue to qualify the retained machinery independently of activation.

Existing settings with absent mode preserve native semantics. An existing stored managed mode is decoded honestly and produces an unavailable instance, rather than borrowing native credentials. Unrelated settings edits remain possible, and switching that instance to existing/native mode provides a recovery path.

Grok marks termination before asynchronous cleanup, rejects stale sessions, and uses the owning scope and thread lock to avoid deleting a replacement session. OpenCode Go account grouping exposes only a fingerprint. Codex runtime leases live in the session scope and new bindings retain Scient native turn/fork behavior. Structured runtime error codes are additive and optional; old-client fallback and historical decoding remain supported. Settings continue to target environment and instance identity.

Provider telemetry call sites retain upstream attempted/rejected and sharing metadata, composed with Scient collection epochs. The existing analytics consent, allowlist and first-party delivery boundary are unchanged; new inherited calls do not authorize collection or add allowed properties.

The preview root-link change uses the existing Scient file-surface owner, persistence coordinator and refresh hooks. The multi-PR action uses the existing Linked panel. Native assisted provider setup remains shared through the existing host; no second authentication UI is mounted.

Scient branding, compatibility package names, state roots, migration order, queue/steer behavior, scientific surfaces, passive Preview probing, credential redaction, updater, service, signing, publication, cloud, relay and mobile release controls were audited. No migrations or release workflows change. The original dirty development checkout and other candidates are untouched.

## Verification

Qualified runtime revision: `efacdaf575f2cd3d65068d8e4e78a2ffb2b16578`.
Environment: macOS arm64, Node 24.19.0, pnpm 11.10.0. Final follow-up changes only this maintainer receipt, `UPSTREAM.md`, and the machine cursor; they do not alter runtime code.

| Check                                                                         | Result                                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm exec vp fmt --check`                                                    | Passed                                                                                                     |
| `pnpm exec vp lint --report-unused-disable-directives`                        | Passed with advisory warnings; no suppressed rules added                                                   |
| `pnpm run typecheck`                                                          | Passed across 31 tasks; focused server typecheck also passed after the strengthened driver regression      |
| Complete test graph, `pnpm exec vp run -r --concurrency-limit 2 test`         | Passed all 30 tasks; 27,309 passing assertions across package runs                                         |
| Backend suite                                                                 | 635 files passed, 9,027 tests passed, 35 files / 114 tests skipped by existing platform/feature conditions |
| Web unit suite                                                                | 824 files passed, 9,563 tests passed                                                                       |
| Focused backend provider/gate suites                                          | 454 passed during composition; final activation/settings/installer regressions 96 passed                   |
| Remote callback/handoff rejection regression                                  | Passed through the real server RPC harness                                                                 |
| Desktop authentication fixtures                                               | 10 passed                                                                                                  |
| Provider browser layout checks                                                | 22 passed across three browser suites                                                                      |
| `pnpm run build`                                                              | Passed                                                                                                     |
| `pnpm run test:desktop-smoke`                                                 | Passed: Electron smoke process launched successfully                                                       |
| `pnpm run brand:check`                                                        | Passed across 2,484 product-surface files                                                                  |
| `pnpm run release:smoke`                                                      | Passed                                                                                                     |
| `pnpm run lint:mobile`                                                        | Static check completed; SwiftLint, ktlint and detekt unavailable, generated native project folders skipped |
| Diff-aware alignment seam audit against frozen owned base and official target | Onboarding, Skills, analysis, LaTeX and OMP passed                                                         |
| Provenance and final diff/ancestry checks                                     | Checked after advancing the cursor to the committed merge                                                  |

Initial full runs exposed a five-second stress-test timeout and the root-link copy expectation. The timeout was attributed with an isolated run: all 15 lock tests passed with a realistic budget, retaining the 150-race workload. The root-link contract was composed and covered with a new regression. Final complete qualification passed. The previous receipt's 27 cloud-fixture failures did not recur in this environment.

The isolated dev app launched from the qualified merge, with candidate-owned `.scient-next/scient-next-dev` state, disabled providers and empty synthetic provider homes. The renderer and bundled backend both answered on their assigned ports. Native window review covered onboarding, the disabled Codex setup action, provider cards, Models/Configuration navigation and the Add Provider wizard. Native custom executable and private home fields remain present; no subscription-sharing setup entry appears. No visual issue was observed in these paths. The agent review is not owner acceptance or proof of live-provider OAuth.

The existing onboarding label is `Unavailable` for explicitly disabled fixture providers. Opening the choice reports `Codex is disabled` and offers Enable. This onboarding code was unchanged by the alignment; the real installed profile and original dirty checkout were not modified.

Scient browser navigation/evaluation worked, but its screenshot operation returned an automation error on this candidate. Native computer-use screenshots and accessibility state provided the visual evidence instead.

Not exercised: real-provider sign-in/tokens, actual subscription-sharing activation, native Windows/WSL or Linux runtime behavior, packaged/signing qualification, and native mobile linters absent from this host. These remain separate acceptance lanes; no credential copying or live-profile access was used.

## Publication boundary

This alignment does not publish, sign, release, deploy hosted services, enable cloud/mobile, opt users into telemetry, or copy live provider credentials. Automated fixture checks and the agent visual review are separate from real-provider sign-in and user acceptance. Delivery uses a history-preserving PR merge after repository checks and queue policy permit it.

## Owned-main realignment: 2026-10-01

Catch-up merge `14fb2478174667b49afaf6d7405526ed897d0c16` has parents
`f997ed552f4ad3bfa3c45720e1309769441204f1` and
`e0efa3fa4346ea6b7c88c93b25b4638cea715fe4`. The seven newer owned-main
commits merge without textual conflicts. They improve sidebar drop placement,
header-midpoint handling, and consecutive pointer drags. Semantic review confirms
that membership changes must succeed before reordering, cancelled membership work
cannot authorize a reorder, and insertion placement preserves the pinned boundary.
These owned changes do not overlap the bounded official donor's section files.

The previous hosted Check job reported eight unused files belonging to the
intentionally inactive upstream subscription-sharing UI. Knip now exempts only
those eight named files from the file diagnostic, with removal instructions when
activation is approved. Dependency and export audits remain active. This records
the existing retained-source policy; it mounts no coordinator and enables no
authentication, callback, or installation path. The exact paths are listed in
`knip.jsonc`.

The fresh compiler also reported TS4023 on the exported Markdown grammar plugin
array. Its explicit `RemarkPlugins` annotation keeps private parser implementation
types out of the public declaration; plugin values and order are unchanged.

Current catch-up qualification:

| Check                                                                             | Result                                                                                              |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Formatting                                                                        | Passed across 6,336 files                                                                           |
| Lint                                                                              | Passed with advisory warnings                                                                       |
| Full typecheck                                                                    | Passed all 31 tasks                                                                                 |
| Full Knip audit                                                                   | Passed file/dependency and export stages                                                            |
| Full application/package build                                                    | Passed all 6 tasks; existing bundler warnings remain                                                |
| Scient branding                                                                   | Passed across 2,484 product-surface files                                                           |
| Alignment seam classification against the original owned base and official target | Onboarding, Skills, Analysis, LaTeX, and OMP checks passed; locator checks are not behavioral proof |
| Upstream provenance                                                               | Passed against current owned main; official integration remains literal ancestry                    |

The complete test graph and native visual evidence in the original Verification
section describe the original qualification revision, not this catch-up. No local
tests were rerun during realignment. Fresh hosted CI must qualify the new head,
including the compute frame-decoder stress test whose prior hosted run timed out
at five seconds. The follow-up below addresses its configuration mismatch;
fresh hosted CI must establish the result.

### Compute workspace configuration repair

Hosted run `36785317144` on `58ad65d2990fa10e6fa27ce7fb275804dd2c2c8b`
passed Check, all web/server shards, native Compute jobs, release smoke, and
provenance. Test Workspaces again timed out on the thousand-frame decoder case:
the runner reported a five-second limit and 11.7 seconds elapsed. The three
workspace tasks interrupted afterward exited 137; their cancellation is not
evidence of independent assertion failures.

Compute's package command omitted the repository test configuration. It now
loads `../../vite.config.ts` with `--dir .`, matching the existing contracts,
SSH, and relay commands. The directory remains the Compute package; the root
configuration excludes dependency/generated directories and supplies the
existing 60-second test/hook budget and temporary-directory setup. No test
count, seed, frame workload, assertion, decoder behavior, or timeout in the
shared policy is changed. This is correctness/stress coverage, not a
five-second performance contract.

Source/configuration review and formatting checks qualify this command change.
Local tests were not rerun. Fresh hosted CI must validate collection and the
complete workspace result; the repair does not yet establish a passing run.

Quick fixes remain in separate draft PR [#421](https://github.com/ScientFactory/scient-desktop/pull/421).
Its provider/onboarding/auth-browser changes are not included in this catch-up.
The running review app, its checkout, and its signed-in profile remain untouched.
