# Scient LaTeX build

Status: Scient-owned server and desktop feature. A build runs entirely on the
local server against the shared PDF foundation; the only network request this
lane ever makes is the optional one-time TinyTeX install. It is not an
upstream T3 subsystem and does not change T3 provider, thread, project,
persistence, cloud, or mobile contracts.

## Ownership

`scient-latex-seams.json` is the machine-readable inventory this section
mirrors. It declares two owned roots — `apps/server/src/scient/latex` and
`apps/web/src/scient/latex` — and two owned files outside those roots:
`packages/contracts/src/scientLatex.ts` (the wire contract: toolchain status,
build snapshot, diagnostic, and managed-install schemas) and
`packages/client-runtime/src/state/scientLatexHttp.ts` (the typed HTTP client
the web store calls through).

Everything else this feature touches is a declared, narrow mount into
inherited T3 code:

| Inherited file                                       | Anchor                 | Purpose                                                                        |
| ---------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `apps/server/src/config.ts`                          | `latexDir`             | Derive the server-owned LaTeX build state from the configured state root.      |
| `apps/server/src/server.ts`                          | `LatexBuildService`    | Provide the build coordinator and toolchain probe to the shared server layer.  |
| `apps/web/src/components/files/filePreviewMode.ts`   | `isLatexPreviewFile`   | Recognize LaTeX sources in the inherited file preview mode selection.          |
| `apps/web/src/components/files/FilePreviewPanel.tsx` | `ScientLatexSurface`   | Mount the additive LaTeX build surface in the inherited file viewer.           |
| `packages/contracts/src/environmentHttp.ts`          | `scientLatex`          | Register the LaTeX endpoint group in the shared environment HTTP API.          |
| `packages/contracts/src/index.ts`                    | `./scientLatex.ts`     | Export the additive Scient LaTeX contract from the inherited contract package. |
| `packages/client-runtime/package.json`               | `./state/scient-latex` | Expose the Scient LaTeX HTTP client module through the package export map.     |

`scripts/verify-scient-latex-seams.mjs` (`pnpm latex:seams:check`) checks the
manifest itself (schema version, owner), that every owned root/file and mount
anchor still exists, that the owned roots are still absent from the official
T3 upstream ref, and — given `--base`/`--head` — that any changed path
matching a `latexDiffSignals` pattern is classified somewhere in the manifest
rather than landing as an unclassified fork change. It runs as part of the
"Verify provenance and General Chat seams" step in
`.github/workflows/scient-upstream-provenance.yml`, alongside the general
upstream-provenance check and the General Chat and analysis seam verifiers.

## Build lifecycle

**Root resolution.** `resolveLatexRoot` (`latexRoot.ts`) reads only the first
4,000 characters of the requested file looking for a `% !TEX root = …` magic
comment; if one names another `.tex`/`.latex`/`.ltx` file, that file — resolved
relative to the declaring file, not the workspace — is the root. Otherwise a
file containing `\documentclass` is its own root, and anything else falls back
to compiling itself, letting the engine's own error name the real problem.
`LatexBuildService` performs this resolution from a bounded 8 KiB read
(`ROOT_RESOLUTION_HEAD_BYTES`) of the requested source, so a status poll on a
large document never reads the whole file. The resolved root is always
rebased back onto a workspace-relative, forward-slash path, and any resolution
that would escape the workspace root (`..` walks, a Windows drive-relative
absolute path) is rejected as `invalid-path`.

**Logical document key.** Every build, status, and cancel call resolves to
`latex:<normalized-workspace-root>:<root-relative-path>`, capped at 1,024
characters (`document-key-too-long` otherwise). This is the same key space
`GeneratedDocumentStore` uses for its bindings, so the build coordinator's
in-memory state and the store's on-disk binding always agree on which document
they mean.

**Coalescing and `pendingRerun`.** `LatexBuildService` keeps one map entry per
logical document key. A build request that arrives while the entry is already
`queued`, `running`, or `publishing` does not start a second build; it sets
`pendingRerun: true` on the existing entry. `runBuildLoop` re-arms the entry
(state back to `queued`, `pendingRerun` cleared) immediately after the current
pass reaches a terminal state and loops again, so a save-happy editor
coalesces into exactly one follow-up compile no matter how many saves land
mid-build. Clients poll until a terminal state _and_ `pendingRerun: false`,
because a terminal snapshot with `pendingRerun` still has another pass coming.

**Three-permit admission.** A single `Semaphore` bounds compilation itself to
`MAX_CONCURRENT_COMPILES = 3` — a compile is CPU- and disk-bound, and three at
once keeps a laptop usable. The permit is taken around the compile, not the
whole build-loop pass, so a build waiting its turn stays honestly in `queued`
instead of claiming to run.

**Supersession via store generations.** `GeneratedDocumentStore` assigns each
production attempt a monotonic `BindingGeneration` on `beginProduction`.
`completeDocumentProduction`/`failDocumentProduction` only accept an attempt
whose generation, operation id, and producer id still match the binding's
`latestAttempt` and whose state is still `running`
(`isActiveDocumentProduction`); anything else returns a `Superseded`
transition. A build that loses this race reports itself `cancelled` to its own
caller and leaves the store untouched, because the newer build's own outcome
is what should stand.

**240-second timeout.** `runProcess` races the engine's exit against
`BUILD_TIMEOUT = "240 seconds"`. On timeout the process handle's `cancel` (a
process-tree kill, not just the parent) is invoked so a wedged engine cannot
outlive the request, and the build finishes with `TIMEOUT_SUMMARY`.

**Cancel semantics, including the known stale-binding effect.** `cancel` sets
`cancelRequested`, tree-kills the running process if any, and — if this build
owns a production handle — calls `store.failProduction` with
`CANCELLED_SUMMARY`. `failDocumentProduction` does not distinguish "this
attempt was cut short" from "this attempt proved the content bad": if the
binding already had a `lastSuccessfulRevision`, the transition sets
`status: "stale"` with `staleReason: "Build cancelled."` even though the prior
PDF is still perfectly valid — a user who cancels a rebuild sees their still-
good PDF marked stale for no content reason. This is a known effect of reusing
`failProduction` for cancellation rather than a dedicated abandon path; see
Deferred decisions.

**Publish-despite-errors, Overleaf parity, pre-deleted stale PDFs.** Before
each compile, `compileAndPublish` force-removes any PDF left at the expected
output path from a previous run. Afterwards, "a PDF exists at `pdfPath`"
therefore means "this run produced it," which is what lets a run that exits
non-zero still publish honestly: if the engine leaves a nonzero-size PDF
behind, it is published with that run's diagnostics attached, matching
Overleaf's behavior of typesetting whatever it can and showing errors beside
it. Only a run that produces no bytes at all (`producedBytes <= 0`) is treated
as a failure — `MISSING_PDF_SUMMARY` if the engine claimed success anyway, or
the first parsed error otherwise (`summarizeLatexFailure`).

**Producer-registration validation.** `GeneratedDocumentStore.publishPdf`
validates every compiled PDF through the `producer-registration` profile of
the shared `@scientfactory/pdf-validation` runtime: structural checks only, no
browser-oriented blank-page rejection, because a deliberately blank compiled
page is legitimate output. A rejected PDF is recorded as the build's failure
(`validation-rejected`) rather than published.

**Diagnostics parsing.** `parseLatexLog` reads one combined stdout/stderr
transcript. Builds run with `-file-line-error`, so most errors arrive as
`./path.tex:12: message`; tectonic prefixes every line it forwards with
`error:`/`warning:` labels, which the parser strips before matching so the
label is read as severity, not swallowed into the file capture. Diagnostics
are bounded to 200 entries and 500-character messages, and generated
extensions (`.aux`, `.bbl`, `.synctex`, …) are excluded from "missing file"
warnings so a cold build's first-pass `No file main.aux.` line never becomes
user-facing noise. `LatexBuildService.rebaseDiagnostics` then rewrites every
reported path: TeX resolves `\input` against its own working directory (the
root document's folder, not the workspace root), so the engine's paths are
rebased onto workspace-relative paths, and a diagnostic whose path would land
outside the workspace keeps its message but loses its file reference, since no
client could open it anyway. Every invocation also sets `max_print_line=1000`,
`error_line=254`, and `half_error_line=238` in the child environment — the
documented `texmf.cnf` knobs — because TeX wraps its own messages at 79
columns by default, which otherwise cuts file paths and error text in half
before the parser ever sees them.

## Toolchain discovery

`LatexToolchain.probe` tries `latexmk -v` first, then `tectonic --version`:
`latexmk` drives `bibtex`/`biber` and reruns to a fixpoint, which tectonic only
approximates, so an already-installed TeX Live or MiKTeX keeps building
exactly as it did before this feature existed. Only when nothing on `PATH`
answers does the probe fall back to a Scient-managed install, still probed
rather than trusted (a tree that no longer runs counts as no engine), and the
result carries `source: "scient-managed"` so callers can tell the two apart.
Windows resolves missing executables through a shell, so a missing engine
surfaces as a shell diagnostic rather than a spawn failure; the probe detects
that case explicitly rather than misreading it as "found."

The probe result is cached for `PROBE_CACHE_TTL_MS = 5 minutes` per server
process. Every build and every status poll asks for the toolchain, so the
cache is filled behind a single-permit `Semaphore`: one fiber runs the actual
subprocess probe, and every fiber that arrives while it is in flight reads the
answer that fiber leaves behind instead of shelling out again.

**Managed TinyTeX install.** `tinytexManifest.ts` pins exactly one TinyTeX
release, `v2026.08`, by hand-verified SHA-256 and exact byte size — nothing
resolves a "latest" pointer at install time. The Windows asset
(`TinyTeX-1-windows-v2026.08.exe`, ~70 MB) is pinned; `darwin` and `linux` are
both `null` until their per-architecture digests are pinned, so
`LatexManagedToolchain.canInstall` is `false` on those platforms today and the
setup card falls back to plain install-it-yourself instructions. Upstream
ships the Windows bundle as a 7-Zip self-extracting `.exe`; Scient never runs
that stub. `LatexArchiveUnpacker` shells out to `tar` (bsdtar/libarchive on
Windows 10+ and macOS, GNU tar on Linux), which reads the SFX file as an
ordinary archive and extracts its payload directly. The install downloads to a
staging directory under `<latexDir>/managed/.staging` (streamed with a
declared-size check, a hard byte ceiling, and a post-download SHA-256
comparison against the pinned digest), unpacks there, and only then is
promoted: any existing install directory for that version is removed, the
staging payload is renamed into place at
`<latexDir>/managed/tinytex-<version>`, and a small atomic JSON record
(`managed-state.json`) is written recording the version, install time, and
root. Nothing is visible or usable under the final path until that rename
succeeds. `latexEngineEnvironment` prepends the managed install's `bin`
directory to `PATH` only for the spawned compiler subprocess, and only when
`toolchain.source === "scient-managed"` — the user's real environment and any
system TeX installation's own resolution order are never touched. Downloads
are restricted to HTTPS (except a loopback exception used by tests) and to an
explicit host allowlist (`github.com`,
`release-assets.githubusercontent.com`, `objects.githubusercontent.com`)
across at most 5 redirect hops.

## Aux/work directory

`config.latexDir` is `<state root>/latex`, a sibling of `analysisDir` and the
other environment-derived state directories — never inside the user's
workspace. Every compile writes into
`<latexDir>/builds/<sha256(logicalDocumentKey)[:16]>/` via each engine's own
`-outdir`/`--outdir` flag, so `.aux`, `.log`, `.fdb_latexmk`, `.synctex.gz`,
and the PDF itself all land there. The workspace directory the user edits
never receives compiler output, and neither does the agent's own checkpoint
history. The managed TinyTeX distribution lives under a separate
`<latexDir>/managed` root, entirely apart from build work directories.

## SyncTeX

Every invocation asks the engine for a SyncTeX index (`-synctex=1` for
`latexmk`, `--synctex` for tectonic), and it is written next to the PDF in the
build work directory like any other aux file. Nothing in this lane reads it
back yet: there is no PDF-to-source or source-to-PDF navigation. Emitting it
now is free and avoids a second build-invocation change later; wiring it up is
listed under Deferred decisions.

## Verification

Server-side coverage is co-located unit tests per module —
`latexRoot.test.ts` (root resolution), `latexCommand.test.ts` (invocation and
managed-PATH construction), `latexLog.test.ts` (diagnostics parsing),
`LatexToolchain.test.ts` (discovery, caching, version parsing),
`LatexManagedToolchain.test.ts` and `LatexArchiveUnpacker.test.ts` (the
install pipeline, including `artifactUrlRejection` and unpack argument
construction), and `tinytexManifest.test.ts` (manifest shape and pinned-asset
resolution) — plus `LatexBuildService.test.ts` for the coordinator's
lifecycle, coalescing, admission, and cancel/supersession behavior.
`LatexRealEngine.test.ts` is the one test that runs a real TeX engine; it
self-skips at collection time unless `latexmk` or `tectonic` actually resolves
on `PATH` (the normal state of a machine and of CI), and where an engine does
exist it proves the two things only a real compile can: that the built argv
actually produces a PDF, and that a root document living in a subdirectory
still finds what it `\input`s and `\include`s.

Web-side coverage is `latexBuildStore.test.ts` (the watch-loop and coalescing
contract), `latexToolchainSetupModel.test.ts` (setup-card state derivation),
`scientLatexSurfaceModel.test.ts` (status-strip and diagnostics-row
derivation), and `scientLatexSurfaceSeam.test.ts`, a static source audit of
the `FilePreviewPanel` mount — lazy import, path-kind gating, exact prop
parity between what the panel passes and what the surface declares, and that
the surface never imports the chat Markdown pipeline — following the same
pattern as `pdfFilePreviewSeam.test.ts` and `chatMarkdownMathSeam.test.ts`.

`scient-latex-seams.json` plus `scripts/verify-scient-latex-seams.mjs`
(`pnpm latex:seams:check`) is the lane seam verifier described under
Ownership, wired into `.github/workflows/scient-upstream-provenance.yml`.

## Deferred decisions

- **`DocumentBuild` vocabulary generalization for Typst/Quarto.** The current
  build-state vocabulary (`queued`/`running`/`publishing`/`succeeded`/
  `failed`/`cancelled`, `ScientLatexBuildSnapshot`) is specific to this
  contract. Generalizing it into a shared `DocumentBuild` vocabulary other
  future producer lanes (Typst, Quarto) could reuse is raised to the platform
  owner of `docs/internals/scient-pdf-export-rendering-plan.md` rather than
  decided unilaterally here.
- **`abandonProduction` binding transition.** Cancel currently reuses
  `failProduction`, which is why cancelling a build stales an otherwise still-
  good last success (see Build lifecycle). A dedicated `abandonProduction`
  transition — "this attempt stopped" without implying "the content is now
  known bad" — is a shared-foundation contract request against
  `@scientfactory/document-artifacts`, not a private workaround in this lane.
- **Build-dir and superseded-managed-version GC.** Neither
  `<latexDir>/builds/<digest>` work directories nor a superseded
  `<latexDir>/managed/tinytex-<old-version>` tree (after a future manifest
  version bump) are ever cleaned up automatically today.
- **Restart reconciliation of in-flight bindings.** Build state lives only in
  an in-memory `Ref`. If the server exits mid-build, the on-disk binding can
  be left in `producing` (no `lastSuccessfulRevision` yet) or `stale`
  indefinitely, with nothing on the next start to reconcile it.
- **Binding-change push subscription.** The web client polls the status
  endpoint on a self-scheduling timeout (1.5 s active, 5 s after a transport
  error) rather than subscribing to a push notification. Polling is the
  documented interim until the shared foundation offers a binding-change
  subscription.
- **Diagnostics-click source jump and SyncTeX navigation** are the next
  increment on top of the diagnostics list and the SyncTeX index this lane
  already emits.
- **Warning file-attribution.** `parseLatexLog`'s `WARNING_PATTERN` branch
  captures a line number from the "on input line N." suffix but never a file,
  so every LaTeX/Package/Class warning is reported without a file even when it
  clearly originated in an included file.
