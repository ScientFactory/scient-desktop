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
- **Ask in chat** is the shared citation path, not a Compute one. `ComputeQuoteActions` puts
  `SelectionCitationToolbar` on the feed and the notebook; a `ComputeCitation`
  (`packages/shared/src/computeCitations.ts`) carries a run's ids or a notebook cell's id, so the agent
  reads the rest with `scient_compute_output` or `scient_notebook_read`. A chip opens through
  `openComputeCitation` and `computeQuoteReveal`. In a `# %%` script, `SourceCaretAction` offers a
  clicked cell as an ordinary file quote, using `computeCellQuote`.
- **Outside changes** reach an open editor through `moveEditorToSource`, as the smallest edit, on attach and while open, so a retained copy never outranks the latest text. Conflicts come from a refused save, never from comparing reads with the draft, which can catch your own save in flight. `authoritativeData` is the file as last read; `data` puts your draft first.
- **The active cell** is drawn by `useScientFileLineRange`, outside the editor's options. A changed
  option rebuilds the editor, and that restores a bare caret: it collapses a drag and can lose a click.
- **New console** opens `ComputeConsole` from project history. It owns a session like a file tab does,
  starts it on the first run, and tags runs with the `console` source. A script tab with no session of its own
  borrows a live Console session of its language (`computeConsoleSession`, `borrowSession`). A
  borrowed binding runs in that session without owning it, so closing the tab only lets go, while an
  explicit Restart or Stop acts on the shared session and capacity recovery never stops it. A
  notebook never borrows. An empty Console gives way to the first file opened from it
  (`useConsoleGivesWayToFiles`), and `ComputeConsoleNotebook` writes what succeeded to an `.ipynb`.
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

Figures a run saves into the project are found from what the run wrote, never by scanning the
project before and after it (`ComputeProjectOutputObserver`):

- Every session and file run reads one `@parcel/watcher` subscription per project folder
  (`ComputeProjectWriteWatch`), held for the session's runtime scope or one file run. `begin` only
  records a journal position, so admission never touches the disk. `collect` writes a sync file and
  waits for its event, which proves every earlier change was delivered. Coverage comes from this
  watch alone.
- Python kernels also carry an audit-hook recorder that notes figure and table files each cell opens
  for writing, renames or copies; the bridge sends it as `writes` on `execution-complete`. It adds
  candidates the watch may have lost and proves nothing about coverage: a write through a handle
  opened in an earlier cell, or relative to a `dir_fd`, raises no audit event. Callbacks are matched
  by their `ExecutionInfo`, so a nested blank `run_cell` keeps the outer cell recording; a lost
  lifecycle drops that cell's record. The observer authorizes every candidate (inside the project,
  regular file, changed since the run began) and reads it with the safe-read checks.
- A watch that is not ready, failed, or reported dropped events gives `watch-unavailable` or
  `watch-overflow`: the observer then searches for recently changed files without a baseline, and
  coverage is `partial`.
- On Linux, inotify watches a new folder only after it appears, so every created entry is listed if
  it turns out to be a folder (bounded; hitting the bound or an unreadable folder gives
  `scan-entry-limit` or `scan-unreadable`). inotify can also drop its queue without telling
  `@parcel/watcher`, so a healthy Linux watch still reports `partial` with `watch-unverifiable`.
- `complete` coverage with no output means the run wrote no figure. Only the macOS and Windows
  watches can give it.

## Linked results

Fresh saved-file runs use the results staging area. Run admission snapshots declared inputs
and root lockfiles before startup, passes overrides as JSON in `SCIENT_PARAMETERS`, and
gives the kernel an empty `SCIENT_RESULTS_DIR`. Python reads package metadata from the selected
kernel before analysis code runs. Publication combines those snapshots with the runtime's
observed reads and moves a complete revision into its final directory.
Python records capped directory listing digests and a count of distinct outside files.
The output folder and audit-observed writes are excluded from automatic file evidence.
For languages without an audit hook, setup can offer literal paths from the saved source.
Accepted paths use ordinary declared inputs.

The pending-attempt journal is independent of the revision store. Recovery clears abandoned
staging and keeps the last successful revision. Comparison reads the stored code identity,
setup, and output files through the same project-scoped operations used by the app and agents.

## Agents

The `compute` grant gives every provider session these MCP tools
(`apps/server/src/mcp/toolkits/compute/`):

| Tool                       | Does                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scient_compute_run`       | Runs code in the agent's own session for its chat and language (started on first use, Scient-managed Python when installed) or in a given session; waits up to `waitSeconds` and returns text, errors and figures. |
| `scient_compute_run_file`  | Runs a saved script through the project session gateway used by the editor. Sessionless languages use the one-shot runner.                                                                                         |
| `scient_compute_output`    | Reads a run's output, by default the session's latest.                                                                                                                                                             |
| `scient_compute_sessions`  | Lists live sessions in the project with owners and recent runs.                                                                                                                                                    |
| `scient_compute_variables` | Lists a session's variables without running code.                                                                                                                                                                  |
| `scient_compute_control`   | Interrupts, restarts or stops a session.                                                                                                                                                                           |
| `scient_compute_setup`     | Installs Scient-managed Python or adds Toolkits.                                                                                                                                                                   |
| `scient_compute_inventory` | Lists languages, runtimes and Toolkits.                                                                                                                                                                            |
| `scient_notebook_read`     | Reads headings, parameter defaults, cells, and saved alternatives.                                                                                                                                                 |
| `scient_notebook_edit`     | Edits and folds cells, tags a parameters cell, or clears outputs.                                                                                                                                                  |
| `scient_notebook_run`      | Runs cells in the live session, or the whole notebook in a fresh kernel; that run publishes a linked revision when it writes to `SCIENT_RESULTS_DIR`.                                                              |
| `scient_notebook_stop`     | Stops a fresh notebook run or sweep by path and run ID; completed sweep settings stay saved.                                                                                                                       |

Both execution tools are exposed before discovery on providers that defer tools. File runs
with parameters or declared inputs use an isolated runtime lifetime and record that setup. The
runtime receives the same JSON environment variable as a linked-result run. Use
`scient_results_run` to publish results.

Figures return to the model as MCP image content (`scientToolImages.ts`). Session runs record the
agent actor independently of the session owner. One-shot runs store the invoking thread on their
receipt. Older one-shot receipts may lack attribution.

`compute.runHistory` reads the workspace's retained session executions and merges them with
one-shot receipts. The same read is available through `scient_compute_sessions` with `history`.
The server keeps a rebuildable in-memory index of request references for recently read projects.
It selects the page using those references and reads full receipts for the selected entries.
A notebook batch whose settled summary is unavailable also reads its member receipts.
Exact execution links with a session ID can read the referenced receipt directly.
Notebook submissions store a batch ID on each cell request. Project history groups cells by that
ID before paging. A session also emits the settled count and failure position as soon as all
receipts in the batch are terminal. Pass `history.notebookBatchId` to page through the cells of a batch.
The project history fetches output when its row is opened. File Results match the document
path across sessions. The chat inspector reads the retained run by session and execution ID
and can render the tool's text output when the provider supplies only the tool result.

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

The outline comes from Markdown cell source. Fold edits preserve JupyterLab metadata and keep
hidden output viewers unmounted. The index retains inter-cell whitespace and raw field values so
saving a fold leaves the attachment and output bytes alone.

A clean run starts a server-owned job. The editor subscribes to a notebook's latest job, including
jobs started by another window or an agent, and receives a current snapshot when it reconnects.
An agent can read status by run ID. The job snapshots the saved code, runs the cells in a fresh kernel and
copies cell outputs before allowing transcript cleanup. Source edits pause while the job
runs. Folds remain editable.

After success, the publisher retains files from `SCIENT_RESULTS_DIR`. The guarded notebook
write updates the injection, parameter evidence and cell outputs when the code still matches
the snapshot. Display limits are labelled in cell outputs. Sweeps save alternative revisions
and keep the notebook's published setting. The reader can switch to revisions made with the
same ordered code, excluding the injected cell, without starting a kernel.

## Data

`apps/server/src/scient/data/` reads CSV, TSV, Parquet and workbooks in place, a page at a time, for
the virtual grid in `apps/web/src/scient/dataTable/`. A kernel variable opens in the same grid
through silent table paging. File profiles reuse these sources. Delimited profiles
stream over the indexed rows. Parquet profiles keep exact footer statistics
and run the Python DuckDB worker over the file for distinct and common values.
Small categories are counted exactly. For higher cardinalities the worker
estimates distinct values and can estimate which common values to count.
A bounded leading sample is available on request or when the worker cannot
finish. Live Python table profiles scan within the kernel's idle inspection
request and fall back to its bounded first page when the scan budget expires.

Saved-view RPCs use the project binding, an isolated Python DuckDB process and
a private result directory. Host runtime discovery is cached while the SQL
runtime preference stays the same. DuckDB receives only verified project file
paths from the saved SQL. The preview expands supported file globs into explicit
project paths. The view must contain one SELECT statement.

For a delimited grid search, the save checks that the grid and DuckDB select
the same source row positions before writing the SQL. The SQL re-runs the
raw-text filter against the source each time. View saves and exports stage
their output beside the destination. Publication uses an exclusive hard link
or an exclusive copy when the volume does not support hard links.
