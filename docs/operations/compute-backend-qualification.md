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
