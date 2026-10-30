# Scient Compute

> For maintainers. Using Scient? See [Scientific computing](../user/scientific-computing.md).

Scient Compute runs code in stateful sessions that people and agents share. Code lives in ordinary
project files: scripts with `%%` cells (`.py`, `.m`) and Jupyter notebooks (`.ipynb`).

## Sessions

- A **session** is one live kernel in one project. `ComputeSessionService`
  (`apps/server/src/scient/compute/`) owns its lifecycle, queue, output budgets, persistence and
  recovery; `ComputeRpcGateway` resolves the project from a working directory for every caller.
- A session records its **owner**: a file tab (`{ _tag: "file", path }`, used for scripts and
  notebooks) or an agent's own session for one chat (`{ _tag: "agent", threadId }`). Every execution
  records its **actor**; an absent actor is the user.
- History is files under `<state>/compute/sessions/<project>/<session>/` (session record, journal,
  per-execution request/result/output, content-addressed resources). Reopening history never starts
  a kernel.

## Runtimes

- **Python** runs ipykernel behind `bridge/scient_compute_bridge.py`, a framed-JSON sidecar using
  `jupyter_client`. **R**, **Julia** and **SQL** (a DuckDB wrapper kernel) run behind the same bridge
  through `KernelComputeRuntime`, each described by a kernel command, discovery and setup. **MATLAB** runs through the Engine bridge (`scient_matlab_engine_bridge.py`) and,
  for `Run MATLAB batch`, the older `analysis` one-shot runner.
- **Scient-managed Python** is a private, uv-built CPython with reviewed Toolkits, installed as
  immutable generations (`ManagedPythonEnvironment`, `ManagedPythonProvisioner`, recipes in
  `managed-python/`). See [Managed compute recipes](../operations/managed-compute-recipes.md).
- Compute is trusted local execution with the server account's authority. Launches drop
  Python/Jupyter overrides and the app's own sign-in tokens (`ComputeEnvironmentPolicy`); the user's
  own credentials stay available to their code.

## Finding and choosing runtimes

- **Discovery reads files, never launches.** `RuntimeDiscovery` enumerates Pythons from the
  project's `.venv`, `.conda` and `.pixi/envs`, an activated environment, every PATH match,
  pyenv/asdf/mise, uv, conda/mamba roots and `~/.conda/environments.txt`, Homebrew, python.org
  and, on Windows, PEP 514 registrations (one bounded `reg.exe` read) and conventional folders.
  Microsoft Store shortcuts and broken virtualenvs carry their cause instead of being probed.
  R, Julia and MATLAB use the same PATH and versioned-folder helpers. The filesystem is an
  injected `RuntimeDiscoveryHost`, so Windows and Linux layouts are tested with fakes.
- **Probes are cached.** `RuntimeProbeCache` shares one probe per executable, bounds concurrency
  and keeps failures briefly with their reason. Inspection is per language (`languageIds`): each
  language is served from its last result and refreshed in the background, so opening a Python
  file never waits on R, Julia or MATLAB. A failed check is reported as `failure`, never as an
  empty list.
- **One selection rule** (`RuntimeSelection`) serves inspection and session start. Automatic
  runs the first ready runtime. An explicit choice and the project's own environment are intent:
  they run or block with their problem, and are never silently replaced.
- **Choices belong to one machine.** `scientificComputing.languages[*].selections` is keyed by a
  hash of host, platform, architecture and home (`<host>`, `<host>/<project>`), so a copied or
  synced profile never applies another computer's paths. An unscoped `executable` from older
  settings is migrated into this machine's slot at startup.
- **Installed Jupyter kernels** (`InstalledKernelRuntime`) add one language per uncurated
  kernelspec language found at startup, launched through the bridge as the spec says, without
  Variables. A bare `python` in a spec means the Python it was installed for (`kernelLaunch`), not
  the bridge's. Rust, Octave, Stata, Wolfram Language and SPSS are always bound, with a `setup` on
  their descriptor saying what they need, so `listInstallations` finds a new kernel on the next
  refresh and agents and Settings read the same requirement.
- A copied managed Python is detected from its `pyvenv.cfg` home or launcher link pointing outside
  this profile's compute directory; status names the old location and offers Repair.

## Outputs

Kernels publish MIME bundles. Inline Matplotlib figures carry PNG and PDF, so a shown figure can be
kept as vector graphics; `compute.saveOutput` copies a stored figure or resource into the project
without replacing an existing file.

## Agents

The `compute` grant gives every provider session these MCP tools
(`apps/server/src/mcp/toolkits/compute/`):

| Tool                       | Does                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scient_compute_run`       | Runs code in the agent's own session for its chat and language (started on first use, Scient-managed Python when installed) or in a given session; waits up to `waitSeconds` and returns text, errors and figures. |
| `scient_compute_output`    | Reads a run's output, by default the session's latest.                                                                                                                                                             |
| `scient_compute_sessions`  | Lists live sessions in the project with owners and recent runs.                                                                                                                                                    |
| `scient_compute_variables` | Lists a session's variables without running code.                                                                                                                                                                  |
| `scient_compute_control`   | Interrupts, restarts or stops a session.                                                                                                                                                                           |
| `scient_compute_setup`     | Installs Scient-managed Python or adds Toolkits.                                                                                                                                                                   |
| `scient_compute_inventory` | Lists languages, runtimes and Toolkits.                                                                                                                                                                            |
| `scient_notebook_read`     | An outline of a notebook, or listed cells in full, with each cell's state and output as text.                                                                                                                      |
| `scient_notebook_edit`     | Replaces, inserts, deletes or moves cells, or clears outputs.                                                                                                                                                      |
| `scient_notebook_run`      | Runs cells in the notebook's session, saves results into the file, and returns outputs and figures.                                                                                                                |

Figures return to the model as MCP image content (`scientToolImages.ts`). Agent runs appear in the
session's history like any other run, marked by their actor.

## Notebooks

The server owns each open notebook (`apps/server/src/scient/notebook/`). `notebookIndex.ts` reads a
file's structure without decoding stored figures; base64 holds no quotes, so skipping a figure is
one native search. `NotebookStore` applies cell edits and run results, saves through the workspace's
retained write after a short pause, copies unedited cells byte for byte, and replays unsaved edits
if the file changed underneath them. The app, agents and run results all go through it, so a
notebook never loads as text in the page.

The page keeps cells outside React (`notebookController.ts`), so typing re-renders one cell. Only
one CodeMirror exists at a time: each live editor measures the page on every scroll, so other cells
show static highlighted code laid out identically. Text cells use the document editor. Large
outputs load when their cell nears the view.

A run belongs to its cell on the server. `compute.submitCells` admits a run's cells under one lock
with `source.cell` set, a cell that does not succeed cancels later queued cells of that notebook,
and each cell durably expects its run (`metadata.scient.pending`), so results reach the file after a
tab switch or reload. Out-of-date cells come from `@t3tools/shared/notebookStaleness`: a code hash
for edits, and a name-based hint for cells reading from something that changed since.

## Data

`apps/server/src/scient/data/` reads CSV, TSV, Parquet and workbooks in place, a page at a time, for
the virtual grid in `apps/web/src/scient/dataTable/`. A kernel variable opens in the same grid
through silent table paging. Nothing needs Python.
