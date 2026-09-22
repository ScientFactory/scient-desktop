# Compute backend qualification — 2026-09-22

## Scope

This record qualifies the Compute backend without driving the desktop UI. The
candidate started from `661eee88c2` on
`codex/compute-backend-qualification-20260922`. The final pull-request revision
and hosted-CI result belong in the pull request because they do not exist at the
time this local record is authored.

The qualification exercises the real workspace resolver, RPC gateway, durable
session service, Python and MATLAB bridges, retained-output store, and session
cleanup path. It does not qualify layout, interaction, accessibility, visual
fidelity, or packaged-app behavior.

## Local evidence

### External corpus

The corpus at `/Users/yaacov/AAA/Compute Test` was copied into a fresh temporary
Scient project for each language and executed through the backend gateway.

| Runtime                     | Scenarios | Passed | Expected successful executions | Expected diagnostics | Cancellations |
| --------------------------- | --------: | -----: | -----------------------------: | -------------------: | ------------: |
| Managed Python 3.14.7 arm64 |       142 |    142 |                            128 |                    5 |             6 |
| MATLAB R2026a maca64        |       116 |    116 |                            104 |                    4 |             5 |

Both runs also passed runtime discovery, concurrent inventory reads, display
and retained-resource checks, interruption recovery, independent parallel
sessions, known protocol-corruption checks, and process cleanup. Every
journaled session was stopped and no owned bridge or runtime process remained
alive.

Local evidence is retained outside Git under:

- `/Users/yaacov/AAA/Compute Test/qa-output/review-runs/2026-09-22-backend-qualification-final/python`
- `/Users/yaacov/AAA/Compute Test/qa-output/review-runs/2026-09-22-backend-qualification-final/matlab`

### Focused real-process integration

Seventeen tests in seven files passed against the same managed Python runtime
and MATLAB R2026a. They cover Python kernel restart and loss, raw file
descriptors, output flooding, forty rapid executions, restart storms, tables,
figures, source contexts, port scanning, concurrent Python/MATLAB sessions,
and child-process cleanup.

The managed-recipe live test also passed separately, including provisioning,
toolkit selection, scientific execution, retained-kernel reuse, and private
environment removal. The product-level managed-Python live test was run
separately because combining both long live files in one local Vitest process
left the parent runner idle after the worker exited; that runner behavior is not
counted as product evidence.

### Repository gates

Formatting, lint, typecheck, build, and the desktop smoke test passed. The full
workspace test graph passed when package execution was serialized, including
8,723 web tests and 7,626 server tests (with their intentional skips preserved).

The default parallel test command initially exceeded an unrelated Markdown
typing-performance threshold under host load. The exact performance file then
passed in isolation, and the unchanged threshold passed as part of the complete
serialized workspace run. No production code or performance budget was changed
to hide that variance.

## Finding and fix

The Compute product did not produce a new backend defect in the local corpus.
The qualification process did expose an evidence-quality problem: the previous
broad runner was an ignored scratch script, inferred expected failures from
paths, could finish without a failing exit status, and had no maintained
contract for evidence isolation or cleanup.

The fix is a repository-owned, opt-in `compute:qualify:backend` command. It:

- validates a corpus manifest with typed schemas;
- requires a new evidence directory so candidates cannot be mixed;
- derives expected diagnostics from the manifest rather than filenames;
- fails the process when any scenario fails;
- records candidate, platform, runtime, scenario, resource, and cleanup data;
- verifies every retained resource through the Compute service; and
- tracks every owned bridge/runtime PID and requires all journaled sessions to
  be stopped.

The runner accepts an arbitrary external corpus and explicit runtime path. It
does not embed local fixtures, install packages, change runtime preferences, or
create a production code path.

## Platform boundary

Local native execution covers macOS arm64 only. Hosted CI already qualifies
managed Python on macOS and Linux and system Python at both supported-version
edges. This change extends the system-Python matrix to Windows; Windows remains
unqualified until those hosted jobs pass on the exact pull-request head.

Managed Python on Windows is out of scope because there is no published,
sealed Windows managed-runtime recipe. MATLAB remains a licensed local pass;
it is not represented as hosted cross-platform evidence.

## Manual review boundary

This qualification change has no UI implementation. It requires no visual
acceptance pass. Any existing UI work must be reviewed against its own
candidate and is not made green by this backend record.
