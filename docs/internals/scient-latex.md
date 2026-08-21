# Scient LaTeX build

Status: Scient-owned server and desktop feature. A build runs entirely on the
local server against the shared PDF foundation; the only network requests this
lane ever makes belong to the distribution Scient installs — the optional
one-time TinyTeX download, the collections that install fetches, and the
packages a later build finds missing. A system TeX installation is never
touched. It is not an
upstream T3 subsystem and does not change T3 provider, thread, project,
persistence, cloud, or mobile contracts.

## Ownership

`scient-latex-seams.json` is the machine-readable inventory this section
mirrors. Its owned roots keep the build lane, shared generated-document/PDF
foundation, and reader implementation outside inherited T3 paths. Two owned
files sit outside those roots:
`packages/contracts/src/scientLatex.ts` (the wire contract: toolchain status,
build snapshot, diagnostic, and managed-install schemas) and
`packages/client-runtime/src/state/scientLatexHttp.ts` (the typed HTTP client
the web store calls through). The native SyncTeX source/build logic is also
Scient-owned: `scripts/stage-synctex-runtime.ts` pins, verifies, builds, strips,
and receipts the official helper; `scripts/lib/scient-synctex-build.ts`
re-verifies and stages it for desktop packaging.

Everything else this feature touches is a declared, narrow mount into
inherited T3 code:

| Inherited file                                            | Anchor                                     | Purpose                                                                                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.gitignore`                                              | `native/synctex-runtime/`                  | Keep reproducible native helper build output outside version control.                                                                                                                                        |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts` | `syncTexNavigatorPath`                     | Pass the exact packaged helper to the local desktop server.                                                                                                                                                  |
| `apps/server/src/auth/RpcAuthorization.ts`                | `subscribeDocumentBindingChanges`          | Authorize the producer-neutral document-binding subscription as a read operation.                                                                                                                            |
| `apps/server/src/config.ts`                               | `latexDir`                                 | Derive server-owned LaTeX state and carry the optional desktop-resolved helper path.                                                                                                                         |
| `apps/server/src/cli/config.ts`                           | `syncTexNavigatorPath`                     | Decode the desktop bootstrap helper path into server configuration.                                                                                                                                          |
| `apps/server/src/server.ts`                               | `LatexBuildService`                        | Provide the build coordinator and toolchain probe to the shared server layer.                                                                                                                                |
| `apps/server/src/ws.ts`                                   | `subscribeDocumentBindingChanges`          | Carry the shared document store's binding-change hints over the existing RPC transport.                                                                                                                      |
| `apps/web/src/components/ChatView.tsx`                    | `openFile(..., line)`                      | Open diagnostics and inverse-SyncTeX results at their reported source line through the inherited right-panel store.                                                                                          |
| `apps/web/src/components/files/filePreviewMode.ts`        | `isLatexPreviewFile`                       | Recognize LaTeX sources in the inherited file preview mode selection.                                                                                                                                        |
| `apps/web/src/components/files/FilePreviewPanel.tsx`      | `export function EditableFileSurface`      | Mount the additive LaTeX build surface in the inherited file viewer, and export the panel's editable file surface so the LaTeX split view reuses it instead of forking the editor and its save coordination. |
| `packages/client-runtime/src/rpc/client.ts`               | `subscribeDocumentBindingChanges`          | Classify the binding-change method as a subscription in the inherited transport client.                                                                                                                      |
| `packages/contracts/src/desktopBootstrap.ts`              | `syncTexNavigatorPath`                     | Carry the helper path over the existing desktop bootstrap boundary.                                                                                                                                          |
| `packages/contracts/src/environmentHttp.ts`               | `scientLatex`                              | Register the LaTeX endpoint group in the shared environment HTTP API.                                                                                                                                        |
| `packages/contracts/src/index.ts`                         | `./scientLatex.ts`                         | Export the additive Scient LaTeX contract from the inherited contract package.                                                                                                                               |
| `packages/contracts/src/rpc.ts`                           | `subscribeDocumentBindingChanges`          | Register the producer-neutral binding subscription in the shared RPC contract.                                                                                                                               |
| `packages/client-runtime/package.json`                    | `./state/scient-latex`                     | Expose the Scient LaTeX HTTP client module through the package export map.                                                                                                                                   |
| `scripts/build-desktop-artifact.ts`                       | `stageScientSyncTexRuntimeForDesktopBuild` | Mount verified helper staging into desktop, WSL-sidecar, and release packaging.                                                                                                                              |

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

**Binding-change wake-ups.** `GeneratedDocumentStore.changes` is exposed over
the existing RPC subscription transport as a producer-neutral document-binding
stream keyed by authority and logical document key. The LaTeX surface uses an
event only as a wake-up hint: it immediately re-reads authoritative build
status rather than trying to reconstruct state from the event. The successful
document's 15-second currentness check deliberately remains. A build binding
can announce Scient's own publishes and failures, but an agent, another editor,
or a changed included file has no binding event to emit; the slower evidence
poll is the correctness backstop for those external changes.

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

**Cancel semantics.** `cancel` sets `cancelRequested`, tree-kills the running
process if any, and — if this build owns a production handle — calls
`store.abandonProduction` with `CANCELLED_SUMMARY`. The distinction that
matters is between "this attempt stopped" and "this attempt proved the content
bad": abandoning releases the production without discrediting anything, so a
reader who cancels a rebuild keeps a still-valid PDF marked `current` instead
of watching it go stale for no content reason. `abandonProduction` is
idempotent — a handle that no longer owns the binding settles as a no-op — so
every path that might need it can run it unconditionally.

Two of those paths are races a first reading of the code misses. A cancel can
land between `beginProduction` claiming the binding and the handle reaching the
entry, where it reads `entry.production === null` and finds nothing to release;
`compileAndPublish` therefore re-checks supersession immediately after that
entry write and abandons there, which is the same guard `runProcess` already
keeps around the spawn. And the unexpected-failure handler in `runOnce`
abandons rather than fails: everything reachable there is infrastructure — a
full disk, a state directory that vanished, a defect in this service — and
never a claim about the sources, so the entry reports `failed` with
`UNEXPECTED_FAILURE_SUMMARY` while the binding stays as the last real build
left it. That handler also lets pure interruption through untouched
(`Cause.hasInterruptsOnly`), because closing `buildScope` on shutdown
interrupts every in-flight build fiber straight into it, and a stopped server
is not a failed build. What that leaves behind — a binding still marked
`producing` for an attempt no process is running any more — is the store's to
settle: `GeneratedDocumentStore` reconciles interrupted productions at startup,
before it is published to any caller, so no reader ever observes one.

**The engine gate.** `latexEngineGate.ts` reads the root document's head
before any process starts and refuses, with one plain sentence, a document that
asks for an engine this lane does not drive. `latexmk -pdf` drives pdfLaTeX,
and handing it a XeLaTeX document produces pages of macro errors no reader can
map back to "wrong engine"; saying so up front is the honest alternative. Only
the `latexmk` path is gated — Tectonic's engine is XeTeX-based, so those
documents build fine there and `compileAndPublish` skips the check entirely
when that is the resolved toolchain.

Two findings, deliberately unequal in strength. A `% !TEX program = xelatex`
magic comment (or TeXShop's `TS-program` spelling) is an author's declaration
of intent, and it refuses unconditionally. A load of `fontspec` or
`unicode-math` is only an inference, and it is suppressed whenever the document
shows an engine-conditional idiom: a load of `iftex`, `ifxetex` or `ifluatex`,
or a use of `\ifPDFTeX`/`\ifxetex`/`\ifluatex`/`\iftutex` in any of the casings
those get written in. That suppression exists because Pandoc's default template
is exactly such a document —

```latex
\usepackage{iftex}
\ifPDFTeX ... \else \usepackage{unicode-math} \usepackage{fontspec} \fi
```

— which compiles perfectly under pdfLaTeX, since pdfLaTeX never reaches the
branch. The gate reads text, not TeX: it cannot evaluate the conditional, so
where one is present it stands down and lets the compile decide. `\ifpdf` is
deliberately not in that set, because it tests PDF output mode rather than the
engine. Detection is comment-stripped, so a commented-out conditional cannot
switch the refusal off. The scan covers the root head and the bounded one-level
include heads already used by the upfront package scan, so an engine request in
an extracted `preamble.tex` receives the same verdict as one written inline.

**Only a clean run publishes; the last clean PDF stays visible as stale.** The
engine still runs to the end of the document — `-interaction=nonstopmode`, no
`-halt-on-error` — because that is what makes one compile report every error it
can reach instead of only the first. What that run is _worth_ is a separate
question, and the answer is the exit code: `compileAndPublish` publishes only a
run that exited `0`, whatever the failing run left at `pdfPath`.

This is deliberately not Overleaf parity, and the reason is that a PDF from an
error-carrying run is not the document. It is missing whatever the error
swallowed — the section after it, a bibliography that never ran, every
cross-reference resolved to `??` — and publishing it puts "Built" over output
nobody produced while the errors listed beside it read as advisory. So a
non-zero exit fails the attempt: `store.failProduction` records the reason,
which leaves the last PDF that _did_ compile in place with `bindingStatus:
"stale"` and `staleReason` set to this run's summary. The reader keeps something
true on screen and is told plainly that it is behind the source. A run that
exits `0` still publishes with its warnings — and with parsed `error`-severity
lines the engine itself recovered from — because the engine's own verdict on
its own run is the thing being trusted here.

Before each compile, `compileAndPublish` force-removes any PDF left at the
expected output path from a previous run, so "a PDF exists at `pdfPath`" means
"this run produced it" and a failing run can never be credited with its
predecessor's output. A clean run that produced no bytes at all
(`producedBytes <= 0`) fails with `MISSING_PDF_SUMMARY`; a non-zero run fails
with the first parsed error, or with the run's own last words when it left no
parseable diagnostic (`transcriptFailureDiagnostic`, `summarizeLatexFailure`).
Every exit path removes that candidate PDF again after it has either been
published into the immutable artifact store or rejected, so the build work
directory does not retain a second unbounded copy of each document.

**Build-input evidence: a PDF is only current while its sources are.** A build
request carries a workspace root and a relative path and nothing else — no root
revision, no content hash, no dependency list — so nothing in the request says
_which_ revision of the sources a published PDF was made from. Left there, a
binding published once stays `current` for as long as it survives: across a
restart, across an agent rewriting the root document, across any editor outside
Scient changing an `\input`ed chapter. Opening a document only builds an _idle_
one, so nothing else would notice.

`latexBuildEvidence.ts` closes that. After a compile exits clean and before the
publish that makes its PDF the document, the service records the identity of
every file that compile read: a workspace-relative path, the SHA-256 of the
bytes, and the byte length, under a versioned `schemaVersion: 1` record written
atomically to `<latexDir>/evidence/<sha256(logicalDocumentKey)[:16]>.json`. A
dependency that was already gone keeps its place under a `missing` marker,
because "the chapter was deleted" is a change. Large files are streamed through
SHA-256 rather than identified by length: a figure or data file can be rewritten
in place without changing size. An `oversize` marker is decoded only to migrate
evidence written by the earlier size-only implementation; its first unverifiable
probe earns one rebuild and is replaced by a real digest.

The dependency list comes from the engine's own recorder wherever there is one.
`latexmk` passes `-recorder` by default and writes `<jobname>.fls` beside the
other aux files; `flsManifest.ts` reads its `INPUT` lines against the run's
`PWD`, drops everything outside the workspace root (the distribution's classes,
packages, and fonts) and everything inside the build work directory (the
`.aux`/`.toc` this very run wrote and read back — inputs by label, outputs in
fact), normalizes separators, dedupes, and sorts. Windows drive containment is
compared case-insensitively and the returned path keeps the case on disk; POSIX
containment remains case-sensitive, so a differently cased sibling is not
admitted as a workspace input. A run
naming more than `MAX_RECORDER_DEPENDENCIES = 256` workspace inputs reports
`truncated: true` with an _empty_ list rather than its first 256, and evidence
falls back to the root document alone: a narrower claim beats a partial one
presented as complete. tectonic writes no `.fls`, so there the fallback is the
root plus what `latexPreamble.ts` already reads out of it.

The check runs on every status poll of a finished, successful entry, and is
built for that cadence: one `stat` per dependency, a size difference decides on
its own, and the content hash is read only where size and mtime together leave
the question open. `LatexEvidenceMark` is the memory that makes it stable — the
size and mtime last _verified_ to match the recorded digest — so a formatter or
a checkout that rewrites a file with identical bytes costs one hash and then
stops costing anything. The first probe after a server restart has no marks, so
it streams and hashes every recorded dependency once before the cheap stat path
is restored; that is a deliberate correctness cost, not uniform poll behavior.
An mtime alone never forces a rebuild. On a mismatch the
service triggers the rebuild itself, through the same `startBuild` path a client
request uses, so it takes the same three-permit admission and the same
`pendingRerun` coalescing and adds no concurrency; the snapshot then reports an
active state, which is exactly what the web client's existing poll continuation
already handles, and the stale PDF stays on screen (`seedDescriptor`) while its
replacement compiles. No wire contract changed.

Evidence collection records `unverified` rather than `missing` when a present
dependency is temporarily unreadable. A probe leaves that marker alone while
the lock or permission failure remains, avoiding a rebuild loop; once the file
becomes observable, it requests one rebuild so the replacement record contains
the content identity the prior evidence never established. A per-path in-memory
marker records that this re-verification rebuild was spent. If post-build
evidence collection hits the transient lock again, another readable poll does
not start the same rebuild every 15 seconds; a later evidence record with a real
digest clears the marker.

Scient saves request rebuilds directly. For writes with no browser event — an
agent, another editor, or a checkout — an open successful reader asks status at
`LATEX_CURRENTNESS_POLL_INTERVAL_MS = 15 seconds`; active builds retain the
1.5-second cadence and failed/cancelled builds go quiet. This is the bounded
fallback until the neutral binding-change stream gains a server-to-browser
transport.

Restart synthesis obeys the same rule: a persisted binding that says a PDF was
published is only reported `succeeded` after the evidence check passes.
Evidence that is absent — every binding written before this existed — or that
this version cannot decode counts as a mismatch and earns exactly one rebuild,
which is what leaves evidence behind for every poll after it.

Two things this accepts and states rather than hides. The evidence is read
between the engine's exit and the publish, so a save landing in that window is
recorded as what the PDF was built from when it was not; the cost is one missed
rebuild of one document, which the next save corrects, against hashing every
input twice per build forever. And the in-memory copy is written before the
entry reaches `succeeded` and before the on-disk copy: a status poll must never
observe a published PDF with no evidence behind it, because that reads as
"cannot be vouched for" and would rebuild every document on every build. A state
directory that cannot be written therefore costs a re-check after restart and
nothing else.

**Forced reprocessing.** Every `latexmk` invocation carries `-g`. The work
directory outlives a build, and `latexmk` keeps its own decision state there in
`.fdb_latexmk`: both that the last run failed and which files it could not
find, recorded at the paths it looked in — for a missing package, a path inside
the output directory. Placing `microtype.sty` in the distribution's `texmf`
tree therefore changes nothing `latexmk` is watching, so the retry prints
"Nothing to do", never runs the engine, and exits non-zero. Since the service
deletes the expected PDF before every compile and every build here was
explicitly asked for, there is no run `-g` wrongly forces and one whole class of
"the build says it has nothing to do" failures it removes. tectonic keeps no
cross-run decision state and takes no equivalent flag.

**Missing packages, before the first compile.** TinyTeX ships TeX Live's
infrastructure plus a base set and expects everything else to be fetched on
demand, so without this step any document using a package outside that set
fails with "LaTeX Error: File mathtools.sty not found."

The first resolution round is upfront and reads the document rather than a
transcript, because a transcript can only ever reveal one name: LaTeX takes an
emergency stop at the _first_ input it cannot find. Before the first compile of
a build against a managed distribution, `latexPreamble.ts` reads
`\usepackage`/`\RequirePackage` names out of a bounded 64 KiB head of the root
document plus 16 KiB heads of up to eight files it `\input`s or `\include`s
(comments stripped, names held to the package-name pattern, include paths that
would leave the document's own directory dropped). Those names are dropped to
the ones `kpsewhich` cannot already find, and whatever is left is fetched in
_one_ `tlmgr` invocation, with every name in `installingPackages` so the strip
can say so. A distribution that already has them pays a few probes and no
fetch. The reactive loop below still runs afterwards, for the packages a
package pulls in.

**Missing packages, reactively.** `latexMissingPackages.ts` reads the missing
inputs out of the transcript — the LaTeX and tectonic "not found" wordings,
TeX's own "I can't find file", and latexmk's "Missing input file:" summary —
bounded to ten and deduplicated, and maps only `.sty`/`.cls` names to packages:
a missing `.tex`, `.bib`, or image is the author's own file and is deliberately
mapped to nothing. `missingLatexPackageInputs` keeps each package paired with
the file it was asked for, because the package name alone does not say whether
to look for a `.sty` or a `.cls` afterwards — and "can the engine see it now"
is the question that ends the round.

The transcript is only read for missing packages when the run needs it: a
compile that exited `0` and wrote a PDF resolves nothing, so a working document
never pays for a `tlmgr` round over a name the log mentioned in passing.

What happens next depends on who owns the engine. For
`toolchain.source === "scient-managed"`, `LatexBuildService` sets
`installingPackages` on the snapshot, runs `LatexPackageInstaller`, and — if
anything landed — compiles again inside the same production handle, without
beginning a second binding attempt. The state stays `running` throughout, so
the client's existing poll continuation needs no new predicate and only the
strip's label changes.

Resolution is bounded, but not by the round count doing the work. LaTeX takes
an emergency stop at the _first_ input it cannot find — `nonstopmode` does not
change that — so one compile reveals exactly one missing package however many
the preamble needs, and a document wanting five of them needs five rounds.
`MAX_PACKAGE_RESOLUTION_ROUNDS = 15` is therefore set above a real preamble
rather than as the safety rail; what actually ends the loop is a round that
places nothing new, plus a per-build set of already-attempted names so a
package no repository has cannot send the same document round again. Every
bound is checked before the fetch, and a cancel that lands during one is
honored before the retry. This is the only place a build reaches the network,
and only for the distribution the user explicitly asked Scient to install.

When the managed resolver runs and the package is still missing afterwards —
an offline machine, a name this frozen TeX Live's repository does not carry, an
author's own `.sty` that no repository ever had — the build appends its own
`error` diagnostic beside the engine's: "Scient tried to install 'X'
automatically and could not. If this is your own file, check its path;
otherwise retry when online." Without it the managed path fails silently on the
one thing it exists to do.

For a system TeX Live, MiKTeX, or tectonic, nothing is installed: that
installation is the user's own and Scient does not reach into it. Instead each
missing package gets a synthesized `error` diagnostic — "Missing LaTeX package
'mathtools'. Install it with your TeX distribution (tlmgr install mathtools, or
the MiKTeX Console), then rebuild." — appended after the engine's own error,
which is kept.

**Where the package bytes come from, and who chooses them.** `tlmgr` fetches
from TeX Live's own repository under TeX Live's own verification; these bytes
are not covered by the SHA-256 pin in `tinytexManifest.ts`, which pins the
distribution download and nothing after it. The names asked for come out of the
compiler's transcript, which means the document chooses them — exactly as
`\usepackage` already chooses what a compile loads and runs. So this is no
privilege the document did not already have, and it is stated here plainly
rather than implied by the digest pin one section above. Names are still
filtered through the package-name pattern before they reach argv, because a
transcript is untrusted text and `tlmgr` reads a leading dash as an option.

`LatexPackageInstaller` runs `tlmgr install <pkg…>` through the same
`ExecutionProcess` port the compiler uses, not through `ProcessRunner`, with a
10-minute budget per invocation and output bounded to a 512 KiB tail (the
verdict is the last thing `tlmgr` says). The port's `cancel` is a process-tree
kill — `taskkill /T /F` on Windows — and that is the whole reason for the
change: `ProcessRunner` kills only the process it spawned, so a fetch that
outran its budget lost its shim and kept its `perl`, which finished the install
minutes later and rebuilt the distribution's file index underneath a build that
had already been told nothing was placed. Short read-only probes (`kpsewhich`)
stay on `ProcessRunner`, which is what it is for.

On Windows the invocation is the `perl` script, not the shim.
`texliveScriptInvocation` encodes what `tlmgr.bat` does — derive the
installation root from the `bin` directory, put `tlpkg/tlperl/bin` and the
distribution's `bin` at the head of PATH, point `PERL5LIB` at the bundled
library, run `tlpkg/tlperl/bin/perl.exe texmf-dist/scripts/texlive/tlmgr.pl` —
because a `.bat` cannot be spawned without a shell, and that shell is both an
extra process to lose track of and a layer of argument quoting between Scient
and `tlmgr`. (The shim's remaining job is running a self-update script left by
`tlmgr update --self`, which this lane never asks for.) `mktexlsr` is a real
`.exe` in the same directory, and on macOS/Linux both are ordinary executable
scripts, so only Windows `tlmgr` needs the substitution. Every run takes a single permit, so
two of them never touch one distribution's package database at once — three
documents compile concurrently and the install's eager collections fetch can
overlap a first build, which is why `server.ts` mounts one
`LatexPackageInstaller` for both `LatexBuildService` and
`LatexManagedToolchain` rather than relying on layer memoization. The verdict
is read out of the output rather than the exit code, whose meaning has changed
across TeX Live releases. A package `tlmgr` reports as absent from the
repository gets one fallback: `tlmgr search --global --file /<name>.` maps the
file to the package that actually ships it (`algorithm.sty` comes from
`algorithms`), and that package is installed instead. A name that search
already failed to map is remembered for ten minutes (a small module-level map,
cleared whenever a managed install finishes, since a new distribution has its
own answers), so a document with a typo'd `\usepackage` does not buy a
repository query on every save. The service never fails —
a repository that cannot be reached, a `tlmgr` that will not run, a timeout all
come back as `failed` names — so a build keeps the compiler error it already
had rather than gaining a second one about the fetch.

**Finished is not visible.** `tlmgr` unpacks the files first and rebuilds the
distribution's `ls-R` file index afterwards, as a post-action, and a compile
started between the two searches an index that does not yet mention what was
just placed. That is the same "File `microtype.sty' not found" the round was
fetching for, from a tree that already has it, and it is what made the failure
this section exists to prevent look like a package problem rather than a timing
one. So a round that placed something does not report it placed until it can be
seen: the caller passes `expectedFiles`— the exact names the compile stopped
on — the installer asks`kpsewhich`(a 20-second`ProcessRunner`probe in the
managed environment), runs`mktexlsr`once through the port (120 seconds, tree-
safe) if the answer is no, and asks again. Names whose file is still invisible
move from`installed`to`failed`, and if nothing at all became visible
`installed`is emptied, so the caller does not recompile against a
half-registered tree — the F3 unresolved-package diagnostic says so instead. A
probe that cannot answer at all (no`kpsewhich`, a timeout) counts as "found":
a distribution whose probe will not run must not be one where nothing is ever
visible, or no build could ever recompile. `LatexManagedToolchain`'s collections
fetch passes no `expectedFiles` and is unaffected.

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
user-facing noise. Two shapes of wrapper noise are deliberately not
diagnostics: a `file:line:` line whose file is a TeX Live script wrapper
(`.tlu`, `.lua`) or whose message is "command failed with exit code …" —
`runscript.tlu` reporting the exit status of the Perl tool it drove, which
otherwise becomes the headline error at a path no reader can open — and, in
`summarizeLatexFailure`, `latexmk`'s "==> Fatal error occurred" verdict, which
is preferred against rather than for: the summary names the first error that is
not that line, and falls back to it only when the run left nothing else. `LatexBuildService.rebaseDiagnostics` then rewrites every
reported path: TeX resolves `\input` against its own working directory (the
root document's folder, not the workspace root), so the engine's paths are
rebased onto workspace-relative paths, and a diagnostic whose path would land
outside the workspace keeps its message but loses its file reference, since no
client could open it anyway. Every invocation also sets `max_print_line=1000`,
`error_line=254`, and `half_error_line=238` in the child environment — the
documented `texmf.cnf` knobs — because TeX wraps its own messages at 79
columns by default, which otherwise cuts file paths and error text in half
before the parser ever sees them.

**A failed build always says why.** Every terminal failure the build loop
records goes through `withFailureReason`, which appends an `error` diagnostic
carrying the failure summary when the list has none. This closes a gap that was
reachable in production, and was: `latexmk` declining to redo a target it had
already failed prints only its own prose — no `file:line:`, no `!`, no missing
file, and its one `file:line:`-shaped line is the `runscript.tlu` wrapper noise
the parser deliberately drops — so `parseLatexLog` returned nothing, and the
build recorded an empty diagnostics list under `summarizeLatexFailure`'s bare
"LaTeX build failed." The reader was told only that it had failed, on a run
that had plenty to say. `transcriptFailureDiagnostic` now reads that run's own
last words: its `Collected error summary` entries if it printed any, otherwise
the tail of what it did print with the tooling's self-narration (console code
pages, `Rc files read`, the latexmk banner, the wrapper's exit-code line)
filtered out, otherwise the status it exited with. The summary is then computed
from the augmented list, so it is never the bare fallback either.

## Toolchain discovery

`LatexToolchain.probe` tries `latexmk -v` first, then `tectonic --version`:
`latexmk` drives `bibtex`/`biber` and reruns to a fixpoint, which tectonic only
approximates, so an already-installed TeX Live or MiKTeX keeps building
exactly as it did before this feature existed. Only when nothing on `PATH`
answers does the probe fall back to a Scient-managed install, still probed
rather than trusted (a tree that no longer runs counts as no engine), and the
result carries `source: "scient-managed"` so callers can tell the two apart.
A missing engine is an ordinary spawn failure on every platform: `ProcessRunner`
resolves the executable itself through `resolveSpawnCommand`, which uses shell
mode only for a resolved `.cmd`/`.bat` shim, so a bare `latexmk` that resolves
nowhere fails with `ENOENT` and the probe reads that as absent. The Windows
"is not recognized…"/exit-9009 check (`isWindowsCommandNotFound`) covers the
other case — a shim that does resolve but cannot find what it wraps — so that
its diagnostic is not misread as "found."

The probe result is cached for `PROBE_CACHE_TTL_MS = 5 minutes` per server
process. Every build and every status poll asks for the toolchain, so the
cache is filled behind a single-permit `Semaphore`: one fiber runs the actual
subprocess probe, and every fiber that arrives while it is in flight reads the
answer that fiber leaves behind instead of shelling out again.

**Managed TinyTeX install.** `tinytexManifest.ts` pins exactly one TinyTeX
release, `v2026.08`, by hand-verified SHA-256 and exact byte size — nothing
resolves a "latest" pointer at install time. Windows x64, Linux x64, and the
universal Darwin bundle used by both macOS x64 and arm64 are pinned. Windows
arm64 and Linux arm64 remain explicit unsupported slots until their assets are
verified; the setup card falls back to plain install-it-yourself instructions
there. Upstream ships the Windows bundle as a 7-Zip self-extracting `.exe`;
Scient never runs that stub. `LatexArchiveUnpacker` shells out to `tar`, which
reads the SFX file as an ordinary archive and extracts its payload directly.
Only libarchive's tar
does that, though, so which `tar` cannot be left to `PATH` on Windows, where
Git for Windows and MSYS2 both place a GNU tar that rejects the bundle: the
unpacker resolves `%SystemRoot%\System32\tar.exe` (the bsdtar Windows 10+
ships) by absolute path and fails with `unpacker-unavailable` if it is not
there, which also keeps PATH — the one input on this path a user's other
software can rewrite — out of the install entirely. Elsewhere the command
stays `tar`: macOS ships bsdtar under that name, and Linux only ever reads the
`.tar.xz` asset.

The install downloads to a staging directory under
`<latexDir>/managed/.staging` (streamed with a declared-size check, a hard byte
ceiling, and a post-download SHA-256 comparison against the pinned digest),
unpacks there, and only then is promoted. Promotion renames the staged payload
into a directory no install has used before,
`<latexDir>/managed/tinytex-<version>-<8 hex>`, and then writes
`managed-state.json` — one atomic write recording version, install time, and
root — which is the install's single commit point, because that file is the
only thing that says which root is current. Before promotion, the staged
`latexmk` is made executable on POSIX and run with `-v` under a 30-second,
64-KiB-output bound with its own `bin` directory prepended to the child PATH.
An archive that verifies but cannot start on this host therefore never becomes
current. This same gate runs on Windows, macOS, and Linux; the dedicated native
asset workflow downloads, verifies, expands, and starts every pinned Windows
x64, Linux x64, macOS arm64, and macOS x64 release asset on its matching GitHub
runner.

An earlier install root is never removed during promotion: its engine may be
running, and on Windows a partial removal of a locked tree followed by a failed
rename is exactly how a working installation becomes no installation. Once the
new state file is committed, `cleanupSupersededInstalls` best-effort removes
unreferenced roots; a locked tree is left for the next successful install to
retry and cannot turn this install into a failure. The whole run also
sits under one 45-minute ceiling — above the sum of the per-phase budgets (ten
minutes of download plus fifteen of package collections, plus the expansion
between them), so it only cuts what they cannot — and a download that stalls
before its body ever streams (the redirect and header exchange the phase
timeouts do not cover) fails as `install-failed` and releases the single-flight
gate rather than leaving the state saying an install is forever in flight.

**Eagerly installed collections.** Promotion is not the last step. Once the
state file names the new root — that is, once the engine is installed and
discoverable — the run enters the `installing-packages` phase and asks
`LatexPackageInstaller` for `collection-latexrecommended` and
`collection-fontsrecommended` under a 15-minute bound. Source navigation is
not a TinyTeX package and does not add an install-time network dependency: the
application ships the same verified helper for managed TinyTeX, system TeX,
and Tectonic. The base set
holds neither `mathtools` nor `siunitx` nor most fonts, so without this a first
build almost always stops on a missing `.sty` and waits for the per-build
resolver to fetch one package at a time. The step can only ever add to a
working install: any outcome other than clean success — an offline machine, a
mirror having a bad day, a fetch cut short by shutdown — is recorded as the
optional `packagesWarning` on the install state, and the install still reports
`ready`, because the engine works and every build resolves what it turns out to
need. The setup card renders that note subtly beside a finished install instead
of a failure with a retry button, and `installing-packages` counts as an active
phase on both sides so the client keeps polling through it.
`latexEngineEnvironment` prepends the managed install's `bin`
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
`-outdir`/`--outdir` flag, so `.aux`, `.log`, `.fdb_latexmk`, `.fls`,
`.synctex.gz`, and the PDF itself all land there. Build-input evidence is the
only other per-document state this lane keeps, one JSON file per document under
`<latexDir>/evidence/` keyed by the same digest. The workspace directory the user edits
never receives compiler output, and neither does the agent's own checkpoint
history. The managed TinyTeX distribution lives under a separate
`<latexDir>/managed` root, entirely apart from build work directories. Published
navigation indexes live under
`<latexDir>/synctex/<artifact-id>/<revision-id>` and are swept when the shared
PDF store no longer retains the matching immutable revision.

## SyncTeX

Every invocation asks the engine for a SyncTeX index (`-synctex=1` for
`latexmk`, `--synctex` for tectonic), and it is written next to the PDF in the
build work directory like any other aux file. A successful publish copies that
index into an exact-revision navigation directory after the immutable PDF is
published and before the build reports success. Navigation metadata records
only the workspace/root identity, compile directory, and synthetic output
name. It never persists an executable path or the producing compiler's install
kind. Schema-version-1 and -2 metadata remain readable, but their persisted
command, bin directory, and managed flag are discarded as untrusted migration
input.
Failure to retain this auxiliary index never invalidates an otherwise valid
PDF.

The reader CLI is the official MIT-licensed SyncTeX standalone program, pinned
to source commit `82f46b64283b299b045a0295a09aadc11c644e1f` (CLI 1.7,
parser 1.31), linked statically to pinned zlib 1.3.2. Linux is fully static so
the helper does not inherit the hosted runner's glibc baseline; Windows uses
the static MSVC runtime. The staging script verifies both source archives by
SHA-256 before compiling, validates the source version contract, strips POSIX
binaries, runs a version smoke test, and writes a
per-file SHA-256/size provenance receipt beside both licenses. Desktop and
remote-server builds re-verify that receipt and target before copying it. The
server resolves only a receipt-verified bundled path; production never falls
back to an arbitrary `synctex` on `PATH`. Windows ships its native helper as a
desktop resource and Linux x64 inside the WSL server sidecar. Remote server
assets carry every released platform key.

Forward search starts on a plain double-click in the source editor only while
Split is already open and asks `synctex view` for the current successful
descriptor's exact artifact/revision. The inherited editor does not expose its
internal cursor on the current upstream seam, so Scient sends SyncTeX's explicit
unknown-column value instead of guessing a visual DOM offset for wrapped or
bidirectional text. It includes the reader's current page as a disambiguation hint. SyncTeX
returns ordered candidates: Scient preserves that order, uses the first valid
target point (`x`/`y`, not the potentially page-spanning `h`/`v` enclosing box
reported for some RTL material), converts that top-left big-point coordinate
into PDF.js's bottom-left coordinate system, scrolls, and briefly marks the
destination. If an engine records only line-level locations for a source line,
different columns can legitimately return the same candidates; Scient keeps
the official first candidate instead of inventing a more precise PDF position.

Inverse search starts when a plain PDF double-click selects a word while Split
is already open. The reader preserves native selection, converts the pointer's
page position back to top-left big points, asks `synctex edit`, and selects the
first returned candidate whose input is contained in the workspace. Source-only
and PDF-only modes never switch layout implicitly. The source pane opens that
file at the reported line; a negative or absent helper column remains
truthfully line-level instead of being guessed. Diagnostics with a valid
workspace-relative file are buttons through the same line-aware open seam. Any
revision change invalidates the in-flight navigation request and target, and a
missing/evicted revision or index returns a typed `unavailable` result rather
than navigating against a newer PDF.

## Verification

Server-side coverage is co-located unit tests per module —
`latexRoot.test.ts` (root resolution), `latexCommand.test.ts` (invocation and
managed-PATH construction), `latexLog.test.ts` (diagnostics parsing),
`LatexToolchain.test.ts` (discovery, caching, version parsing),
`LatexManagedToolchain.test.ts` and `LatexArchiveUnpacker.test.ts` (the
install pipeline, including `artifactUrlRejection`, unpack argument and
unpacker-path construction, staged-engine execution on Windows/macOS/Linux,
refusal before promotion when that execution fails, and that a second install
lands beside the first rather than over it), `syncTexOutput.test.ts`
(multi-block and multi-candidate command output, Windows-path colons, RTL
point-versus-box coordinates, ordered inverse locations, and legacy fields),
`LatexSyncTex.test.ts` (exact-revision publishing, column and page-hint
arguments, ordered safe-candidate selection, forward and inverse source
confinement, refusal to execute legacy persisted commands, truthful native
failure outcomes, unavailable stale revisions, and retained-index sweeping),
`SyncTexRuntime.test.ts` (release
target mapping, receipt hashing, and tamper rejection),
`latexMissingPackages.test.ts` (missing-input parsing over real transcript
shapes, the file/package pairing, and the deliberate `null` for the author's own
files), `latexPreamble.test.ts` (comment stripping, package and include
extraction, the bounds, and the paths deliberately not followed),
`flsManifest.test.ts` (recorder parsing: POSIX and Windows paths, the
distribution's own files and this run's outputs excluded, a parent walk that
cannot name a file outside the workspace, and the truncation fallback at the
256-input ceiling), `latexEngineGate.test.ts` (the magic comment in the
spellings and casings real editors write, engine-only package loads including
one named among others in a group, the comment-stripping that keeps prose and
commented-out lines from firing it, and the engine-conditional suppression: a
pandoc-shaped preamble and the older `ifxetex` idiom both pass, an unguarded
`\usepackage{fontspec}` is still refused, `\ifpdf` does not count as an engine
test, and a magic comment is still refused even when `iftex` is present),
`latexBuildEvidence.test.ts` (evidence round trip through JSON, the refusal to
read a state file it does not understand, missing- and deleted-dependency
markers, content change detected, an mtime-only rewrite deliberately _not_
detected, the root-only narrowing on truncation, and — over a fake filesystem,
because a real temporary directory cannot portably be put in this state — that
a file which exists and cannot be read is recorded `unverified` rather than
missing, never argues for a rebuild from either side of the probe, and keeps
its recorded digest so a real edit is still caught once the lock lifts),
`LatexPackageInstaller.test.ts` (the perl-direct `tlmgr` invocation shape, the
unknown-package search fallback, the `kpsewhich` visibility gate with its one
`mktexlsr` refresh, the fail-open probe, the tail-keeping output bound, and — on
a `TestClock` — that a `tlmgr` outliving its budget is cancelled through the
port rather than left running), `managedLatexInstall.test.ts` (install-root naming and
the containment rule that keeps a tampered state file from pointing the engine
outside the managed directory), and `tinytexManifest.test.ts` (manifest shape,
pinned-asset resolution, and the arch-keyed table itself: every
platform/architecture pair is listed explicitly whether or not it is pinned, a
pinned entry carries an HTTPS host and a digest and a relative executable path
that neither starts at the root nor walks upward, and an unpinned pair resolves
to a refusal naming the pair rather than to silence) — plus
`LatexBuildService.test.ts` for the
coordinator's lifecycle, coalescing, admission, cancel/supersession behavior,
the upfront preamble batch (one install call carrying every unresolvable name,
then a single compile) against the reactive loop that still handles what only a
compile could reveal, two diagnostics invariants — that no shape of build
failure leaves the diagnostics list empty or the summary at the bare fallback,
and the exact observed production sequence (failed install round, rebuild,
`latexmk` refusing to rerun) as a regression — the publish gate (an
error-carrying run that _did_ leave a PDF publishes nothing, and a prior clean
PDF survives it as the stale binding at the same revision), and the freshness
contract: a recorded dependency changing under a published document flips the
next poll out of a terminal state and starts one rebuild, an untouched document
stays `succeeded` across twenty consecutive polls with exactly one compile ever
run, a restored binding is reported built only while its evidence holds, one
whose sources moved on while the server was down rebuilds with its stale PDF
still on screen, and one whose state predates evidence entirely rebuilds once
and then stops. Two of its cases stand inside windows the harness could not
otherwise reach, through a `beginProductionGate` seam that parks a build inside
`store.beginProduction`: a cancel landing in that window still releases the
binding (watched on `store.changes`, because `getDescriptor` reports anything
not stale as current and so cannot see `producing` at all), and a build that
dies of infrastructure leaves a good PDF `current` rather than staling it. The
shutdown case asserts the end-to-end property — a server stopped mid-compile
comes back with its last good PDF still current — rather than isolating the
interrupt branch, since an interrupted fiber's handler is itself interrupted
before it can reach the store; `Cause.hasInterruptsOnly` there is defence in
depth that this suite cannot discriminate. Two suites self-skip at collection time when the machine cannot run
them: `LatexArchiveUnpacker.test.ts`'s last case expands a real archive
through the resolved system `tar`, which is the only coverage of the actual
spawn the stubs stand in for, and `LatexRealEngine.test.ts` runs a real TeX
engine. The latter skips unless `latexmk` or `tectonic` actually resolves on
`PATH` (the normal state of a machine and of CI), and where an engine does
exist it proves the two things only a real compile can: that the built argv
actually produces a PDF, and that a root document living in a subdirectory
still finds what it `\input`s and `\include`s.

Web-side coverage is `latexBuildStore.test.ts` (the watch-loop and coalescing
contract, including immediate authoritative reconciliation after a binding
event and the retained external-change poll), `latexToolchainSetupModel.test.ts` (setup-card state derivation),
`scientLatexSurfaceModel.test.ts` (status-strip and diagnostics-row
derivation), and `scientLatexSurfaceSeam.test.ts`, a static source audit of
the `FilePreviewPanel` mount — lazy import, path-kind gating, exact prop
parity between what the panel passes and what the surface declares, and that
the surface never imports the chat Markdown pipeline — following the same
pattern as `pdfFilePreviewSeam.test.ts` and `chatMarkdownMathSeam.test.ts`.

`.github/workflows/scient-latex-managed-install.yml` is the opt-in native
release-asset lane. On relevant pull-request changes it runs
`TinyTexAssetSmoke.test.ts` on Windows x64, Linux x64, Apple Silicon, and Intel
macOS runners; each job builds the pinned official SyncTeX helper, downloads
the TinyTeX manifest pin, checks byte count and SHA-256, expands it with the
host path the app relies on, applies POSIX execute permissions, starts the real
`latexmk`, compiles a multi-file PDF/index, forward-searches into the included
child source with the bundled helper, and exercises inverse navigation against
the retained-index layout. The stable release workflow separately builds the
four helper artifacts, injects the matching one into every desktop package,
injects Linux x64 into the Windows WSL sidecar, includes all four in the remote
server asset, and verifies the nested helper's macOS signature.

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
- **Build-dir GC.** Candidate PDFs are removed after every build, but
  `<latexDir>/builds/<digest>` work directories are never cleaned up
  automatically, so every document a workspace has ever built leaves its small
  aux directory behind. Superseded
  `<latexDir>/managed/tinytex-<version>-<8hex>` trees are no longer part of
  this: `cleanupSupersededInstalls` reclaims them once a new install is
  promoted.
- **Evidence garbage collection.** `<latexDir>/evidence/<digest>.json` is
  written per document and never removed, so a workspace whose documents are
  renamed or deleted leaves small orphan files behind. This belongs with the
  build-directory collector above rather than in a second sweep of its own.
- **SyncTeX artifact garbage collection.** Revision directories are swept when
  the same artifact publishes again or when a stale revision is requested, but
  retention can evict an entire artifact that is never opened or rebuilt again.
  Its `<latexDir>/synctex/<artifact-id>` tree then remains orphaned. Reclaim it
  with the build/evidence collector above rather than adding another hot-path
  global scan to each successful publish.
- **Selectable LaTeX providers.** Discovery currently prefers an existing
  system `latexmk`, falls back to Tectonic, and offers the pinned TinyTeX
  install only when neither is available. A user-facing provider registry and
  preference (TinyTeX, tex-to-PDF services, or future engines) is deliberately
  deferred to a later PR so this lane does not prematurely freeze provider
  vocabulary or send document sources to a network service without a separate
  consent and privacy design.
- **Overleaf integration.** Import/export, project synchronization, identity,
  and remote build behavior are outside this PR. They should consume the shared
  document-artifact and source-navigation contracts rather than being folded
  into the local compiler coordinator.
- **Warning file-attribution.** `parseLatexLog`'s `WARNING_PATTERN` branch
  captures a line number from the "on input line N." suffix but never a file,
  so every LaTeX/Package/Class warning is reported without a file even when it
  clearly originated in an included file.
