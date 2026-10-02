# Compute backend qualification

This runbook qualifies Scient Compute without driving the desktop UI. It sends
an external synthetic corpus through the real workspace resolver, RPC gateway,
durable session service, Python or MATLAB bridge, retained-output store, and
session cleanup path.

This is an opt-in maintainer command. The corpus is executable code, and MATLAB
may consume a licensed runtime. The command does not install packages or change
the selected runtime.

## Run a corpus

From the repository root:

```sh
pnpm compute:qualify:backend -- \
  python \
  /absolute/path/to/python \
  /absolute/path/to/corpus \
  /absolute/path/to/new-evidence-directory
```

Use `matlab` and the absolute MATLAB executable for the MATLAB pass. The
evidence directory must not exist; refusing to reuse it prevents evidence from
different candidates from being mixed.

The corpus root must contain `suite-manifest.json` with a `tests` array. Each
test declares its relative `path`, `language`, `role`, expected output
`markers`, and human-readable `purpose`. It may also declare:

- `expectedDiagnostic.errorName` and `expectedDiagnostic.messageIncludes` for
  an intentional failure;
- `minimumDisplays` for display events; and
- `minimumResources` for retained binary resources.

The runner copies the corpus to a temporary initialized Scient project and
excludes prior `qa-output`, `archive`, and `.scient` state. Ordinary cases run
as saved files. Intentional error and interruption fixtures run their first
section, then their recovery section. Files named as the paired parallel-session
fixtures run in independent sessions.

## Pass contract

The command exits successfully only when every recorded scenario passes. It
checks:

- runtime discovery and concurrent inventory reads;
- expected status, markers, and diagnostics;
- display and retained-resource minima;
- retained-resource lookup through the Compute service;
- absence of known bridge/protocol corruption signatures;
- interruption followed by session liveness;
- independent parallel sessions; and
- stopped-session process cleanup for every bridge and runtime PID started by
  the run.

Python package probes follow the runtime inventory. Baseline packages are
required. Optional toolkit packages are probed only when the runtime reports
that toolkit as ready; absence of an optional toolkit is not converted into a
false product failure.

The evidence directory contains candidate/runtime metadata, one JSON record per
scenario, copied generated artifacts, and `summary.json`. Evidence paths are
local artifacts and should not be committed.

## Qualification boundaries

This command is backend evidence. It does not qualify layout, interaction,
accessibility, visual fidelity, or packaged-app behavior. Review those
separately when a change has a UI surface.

Hosted CI qualifies system Python kernels on macOS, Linux, and Windows. Managed
Python is qualified on macOS and Linux against the supported toolkit
combinations. MATLAB needs a licensed protected runner. Any platform or runtime
absent from the current workflow remains not qualified; source portability is
not execution evidence.

## Packaged application acceptance

For a release claiming Compute support, also qualify the exact packaged app on
each claimed native target. Source checkout tests and tests that extract the
entire app archive before running cannot establish this boundary.

The desktop artifact build rejects a missing, archived-only, or truncated Compute
bridge payload in the final packaged application. This structural gate complements
the runtime acceptance below; it does not establish interpreter or license readiness.

Use a fresh isolated profile with no managed installer, interpreter, or
environment cache. Leave the app in its packaged ASAR layout and exercise the
same setup operation exposed by Settings. Verify that:

1. Scientific Python completes setup from the empty profile.
2. A synthetic project starts a session, executes arithmetic and emits a figure,
   then shuts down without leaving its bridge or kernel alive.
3. Restarting the app reuses the installed environment; repair also completes.
4. MATLAB helper setup, verification, and a synthetic execution succeed on a
   machine with a supported, activated MATLAB installation. A skipped licensed
   test is an explicit qualification gap.
5. Failed or interrupted setup can be retried without corrupting an existing
   working environment or changing a system installation.

Record the artifact identity, OS and architecture, fresh-profile evidence,
setup result, execution result, and shutdown result. The bridge scripts must be
readable as physical files by the external interpreter, and every subprocess
working directory must be a real directory outside ASAR. Keep source CI,
packaged runtime acceptance, signing, and release approval as distinct evidence.
