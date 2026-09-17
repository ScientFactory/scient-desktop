# Scientific computing

Scient can run Python and MATLAB from an initialized project without turning the project into a
notebook or installing a second copy of its files. Both use the same session, source, results, and
history controls. Each language remains optional; MATLAB requires a user-installed, licensed
runtime and a compatible Engine host. See [Run a MATLAB file](matlab-run-file.md) for its setup and
**Run MATLAB batch**, available in the same file's Run menu and Results pane.

## Set up a runtime

The quickest path is to open a `.py` file and choose **Set up Python** in the file header. That
opens the correct server's Scientific Computing settings, where **Set up Python** starts the
installation. Scient downloads a verified installer and creates one private, shared Python
environment for that Scient server. The included **Scientific Python** Toolkit covers numerical
data, tables, statistics, machine learning, symbolic math, spreadsheets, and figures. It also
includes YAML configuration, basic image manipulation, PDF text extraction/splitting/merging,
HTTP requests, and Markdown/styled-table exports. PDFs containing only scanned images need
separate OCR; these Python libraries do not change Scient's native file previews or enable
arbitrary HTML in Results. Optional
reviewed Toolkits add large and multidimensional data, image analysis, or bioinformatics without
turning package management into a list of individual dependencies.

**Multidimensional and large datasets** adds Parquet/Feather through PyArrow, HDF5,
NetCDF (including nonstandard calendars), Zarr, and local Dask array/DataFrame processing.
It does not include a distributed cluster or every pandas optional file engine, such as
PyTables for `read_hdf()`. **Image analysis** includes codecs for compressed TIFF workflows;
**Sequences and bioinformatics** includes sequence parsing and indexed FASTA access.
PyArrow remains optional while its platform coverage is being qualified.

Existing managed installations receive these additions through **Update**; opening Settings
does not install them silently. Existing sessions retain their original environment until closed.
Selecting a system or project Python does not add these packages to that installation.

Setting up managed Python from a file that has no usable runtime enables Python and selects the new
environment. Setting it up from Settings while an existing Python is already selected leaves that
selection unchanged; the managed environment becomes another explicit runtime choice.

The managed environment is optional. To use Python you already maintain instead:

1. Open **Settings → Scientific Computing** for the server environment you want to use.
2. Select **Python** in the language strip.
3. Enable Python if it is off.
4. Choose **Automatic** or an installation under **Default runtime**. To enter a path, expand
   **Custom executable** and choose **Use path**. Typing, collapsing, or cancelling does not save it.

A ready Python needs CPython 3.10 or newer, `jupyter_client` 8.6 or newer, and `ipykernel` 6.29 or
newer. Install missing requirements with your own environment tooling, then use the page refresh
control. Prefer a project `.venv` or another virtual environment you control. Scient detects a project's
`.venv` when that project is open. The isolated compute bridge does not load packages installed
with `pip --user`; do not force packages into a Homebrew- or system-managed Python merely to make
runtime discovery succeed.

Settings → Scientific Computing has a compact language selector and shows one language at a time.
Select the open language again to collapse its panel. This only hides the settings; it does not
disable the language, cancel setup, or stop a session. Each optional Toolkit has its own **Download**
action; installed Toolkits have a small menu with **Remove**. There is no separate Apply step.
Setup is required before optional downloads. Toolkit operations continue when the panel is collapsed
or another language is selected; status reflects the server's verified installation, not the click.
You can request more Toolkits while another is installing. Each row shows its own progress,
queue, cancellation, or retry action. Pending requests are combined into the next verified
environment build; they do not run competing installers against the working environment.
Cancelling one pending Toolkit leaves the others requested. The queue lives on the server
and survives navigation, but not a server restart. A failed request can be retried independently.
Cancel immediately shows **Cancelling…** and prevents repeated clicks while the request is pending.
For an active build, feedback remains while shutdown and cleanup finish; a failed cancellation
restores the control so you can try again.
Julia, R, and SPSS appear as **Coming soon** previews only, with no setup or execution controls.
Supported languages use the same rows for Enable and Default runtime. Installations follow as
ordinary rows with their known version and a quiet **Default** marker for new sessions. An unknown
version says **Version not checked**; opening Settings does not execute Python to fill it in.
**Test** in an installation’s menu starts and closes a test session without selecting it,
and any observed version is shared with this view’s picker until refresh. **Testing…** shows an inline spinner.
A green check and **Test passed** clear after four seconds; the observed version remains. **Test failed**
stays available with error details and a retry action. **Copy path** copies that
installation’s path. **Forget path** clears only a saved custom reference, never its files.
System and project installations have no install, update, or remove actions. Scient-managed Python
has its own setup and maintenance actions; Toolkits explicitly target that private environment.
The MATLAB connection helper remains separate from the actual MATLAB installation. Runtime labels
stay short; path suffixes appear only when otherwise-identical installations must be distinguished.
Removing a managed runtime uses a compact confirmation beside the action; it does not obscure the
whole Settings page. Scient does not silently replace a broken selected interpreter.

Changing Toolkits or accepting a reviewed Toolkit update never mutates the active environment in
place. Toolkit downloads/removals, **Update**, and **Repair** each build and verify a fresh generation before
it becomes available. Existing sessions keep the exact generation they started with.
The pinned Python interpreter is reused from Scient's private, versioned interpreter store.
Package files use independent filesystem clones where supported, or copies otherwise; they never
share writable hardlinks with the cache or another generation. Changing Toolkits does not reinstall
the same Python interpreter. Enablement and runtime selection remain available during preparation;
the latest selection is preserved when the verified generation becomes available.
**Repair** deliberately prepares a new private interpreter as well, so a damaged interpreter is
not reused or replaced underneath an existing session.
Downloads reuse Scient's private package cache, never a system or project cache. The installer
checks its size between provisioning stages and clears it when it exceeds 2 GiB; in-flight downloads
may exceed that retention limit. Cache cleanup cannot remove packages from an installed generation.
First-time downloads and verification still take time; the inline status reports the current stage.

**Default runtime** changes only which runtime new sessions prefer. **Automatic** restores discovery instead
of pinning an installation. Choosing an existing Python also
releases Scient-managed precedence; it does not copy or modify packages. **Repair** builds and
verifies a fresh managed generation before activating it; an existing generation remains available
if setup fails. **Update** appears only when Scient ships a newer reviewed Python or Toolkit
revision. It appears as a small **Update** button beside the managed row's menu, including when
that installation is not selected; progress replaces the button while updating. The MATLAB
connection row follows the same rule for Scient's helper only, not the MATLAB application or
licensed toolboxes. Rebuild and Remove remain in the menu.
**Remove** deletes only Scient's private environment and is refused while a Scient-owned
session or probe is using that environment. Sessions using unrelated Python installations do not
block removal. Scient tracks environment usage, not individual Python imports: an idle session can
still import a package later. Old generations are reclaimed after their last user closes, while the
active generation and one rollback generation are retained. Interpreter builds and the bounded
download cache are retained for reuse; removing an environment is not a purge of those stores.
These usage guarantees cover processes owned by Scient, not arbitrary external terminals launched
against its private environment paths. Project `.venv`, configured, system, Homebrew, Conda, pyenv, and
other user-owned installations are never repaired or removed.

Before a session starts, the file header names the interpreter it found (**Python 3.12**,
**MATLAB R2026a**) when you can run. That listing is a package check, not proof a Jupyter or Engine
session already started. A live idle session uses the shorter **Python** or **MATLAB** status, and a
busy session says it is running. Selecting this compact status always opens Scientific Computing for
that server; it never expands into a full-path card.
If setup fails for the runtime the file needs, the header shows a one-line status with a copy control and a details toggle; it
never wraps a stack or path across **Run**. A code error remains a result of that execution; it does
not make a healthy Python or MATLAB runtime unready. The refresh control in Scientific Computing
performs lightweight runtime rediscovery so an installation or environment change can be recognized
without reloading the app. **Test** in the installation menu starts and closes a temporary session;
a package check is not a successful test.
**Repair** rebuilds a damaged Scient-managed generation; it is not how you recover from a failed
Test. Scient never swaps the interpreter beneath a live session. If the selected Python changes
while a session is open, the header offers **Switch Python**; confirmation stops the old namespace,
keeps its run history, and lets the next run start with the newly selected environment.

Setup, repair, removal, and runtime-selection changes update open compute views automatically,
even if you leave Settings before setup finishes. Use the Settings refresh after Python, MATLAB, or
their packages change outside Scient. Settings opened from a project always manages that project's
server.

If a selected managed installation is damaged, Scient keeps it visible for **Repair** rather than
quietly running your code with a different Python. You can explicitly choose an existing environment
instead. Removing the managed installation intentionally returns new sessions to existing-runtime
discovery; it does not remove your other Python installations.

An existing Python can run ordinary code without every scientific library. If the reviewed
Scientific Python packages are missing, the status tooltip notes that some scientific packages are missing.
Run remains available for code that does not need those packages; Scient does not
silently install them into a user-owned environment.
An unrelated managed setup or removal failure does not disable or replace the status of a usable
independent runtime. The file keeps its healthy live session status, or the independent runtime's
status before startup. A cached probe alone does not clear a failure of the managed runtime itself.
Setup failures remain available in Settings under **Error details**; active setup progress and Cancel
remain visible on the file. Select the file's Python status to open
the right server's Scientific Computing settings. After choosing or repairing an environment, rerun
the code yourself; Scient never replays a failed run automatically.

## Connect your MATLAB installation

Open a `.m` file and select its MATLAB status to open **Scientific Computing** for that server.
Enable MATLAB there and choose **Connect MATLAB** when a connection helper is needed.
Opening the file does not start Scientific Python or provision its Toolkit. When the file needs the
failed helper, its failure appears as a short header status with copy and details;
setup and recovery remain available in Settings. Scient does not
install MATLAB or a license. If several copies are installed, open
**Settings → Scientific Computing**, select **MATLAB**, and choose the installation, or
leave automatic discovery selected.

The same executable preference is used by live Compute sessions and fresh-process
MATLAB runs. Existing preferences are respected; saving a new choice or clearing it
does not reintroduce an older path.

Opening Settings and its refresh control only look for installations and read their metadata; they do not
import MATLAB Engine or start Python/MATLAB. Recent status stays visible while being rechecked.
Choosing an installation does not promise that the Engine works or a license is available. Run the
file, or use **Test** in the installation menu, to prove the Engine host. A license/startup failure
stays visible with recovery guidance.

If an Engine host is missing, **Connect MATLAB** on the file opens Scientific Computing settings.
**Connect MATLAB** there installs a small private Python helper for your selected MATLAB, then checks its Engine import. It does
not install MATLAB, activate a license, or install the scientific Python Toolkit. Assisted setup currently accepts
MATLAB R2024b–R2026a; other releases may use an existing compatible Engine host. You still
need MATLAB installed and licensed on the server where the code runs.

The helper stays tied to the MATLAB installation it was built for. Selecting another
MATLAB does not pretend the helper already matches it; **Set up connection**
can prepare a replacement for the new default.

**Use existing MATLAB Engine setup** returns to a compatible Engine host you maintain.
**Rebuild connection** prepares a fresh private helper for the selected MATLAB and activates it only
after verification. Use it after changing your MATLAB installation. **Remove connection helper**
removes only this helper, never
MATLAB, its license, your projects, or Scientific Python. Removal is blocked while a live
MATLAB Compute session uses the language. A broken selected helper is reported instead
of silently choosing another Python host. These maintenance actions live in the **Runtime** overflow
menu; when the selected MATLAB needs a new helper, **Set up connection** is promoted to the main row.
Setup and repair can be cancelled.

The helper and Scientific Python are independent: installing, selecting, repairing, or
removing one does not select or remove the other. No MATLAB-to-Python translation or
automatic Octave fallback takes place.

## Run code and view results

Open a `.py` file in the ordinary project editor. Its header offers three views:

- **Code** gives the editor the full surface.
- **Split** keeps code and the selected run's results side by side.
- **Results** gives text, errors, and figures the full surface.

The contextual **Run** action executes exact selected text when one exists, otherwise the explicit
`# %%` cell containing the caret, and otherwise the whole current buffer. Cmd/Ctrl+Enter uses the
same rule. Its menu also provides the explicit actions:

- **Selection** runs the exact selected text (the existing gutter line selection also remains
  available).
- **Cell** runs the current `# %%` cell without its marker lines.
- **File** runs the exact current editor buffer.

Files without explicit `# %%` markers remain ordinary files; Scient does not invent notebook cells.
In a marked file, placing the caret inside a cell gives the code that would run a quiet active
background and a gutter run action while normal caret placement and editing continue to work.
Selecting text removes the cell treatment because the exact selection becomes the run target;
moving the pointer alone never changes the active cell.

MATLAB `.m` files use the same controls with MATLAB `%%` sections instead of Python cell markers.
Scripts, including scripts with local functions, can use **Run file**. A top-level function, class,
package member, class-folder member, or `private` function is a definition rather than an executable
script, so the file action says **Definition** and explains that it must be called from a script.
The server enforces the same rule even if a stale client attempts the submission.

The first run starts this file tab's session when necessary and reveals **Results** by default, or
**Split** when that was the last results layout you chose. Each Compute tab owns its own session, so
several Python and MATLAB files can run independently within the server's capacity. Values defined
by one successful execution remain available to later executions in that tab until you restart or
stop its session.

Code/Split/Results and Results/Variables are presentation choices owned by the file tab. Switching
to another right-panel tab or thread and returning preserves them; it does not stop, restart, or
replay the session. Explicitly closing the owning file tab stops that tab's live session and clears
its temporary presentation state while preserving run history.

Compute sessions use the opened Scient project as their working directory, as terminals and other
project tools do. A saved full-file run still receives native source identity: use `__file__` in
Python or `mfilename('fullpath')` in MATLAB when data should be resolved beside the source file.

Running an unsaved buffer does not save it. History records the exact submitted code and its saved
base revision, and labels the run as unsaved. A saved submission is accepted only when its
recorded revision and source range still match the project file.

## Control and review a session

- **Cancel** removes queued work or requests cancellation of the named execution.
- **Interrupt** stops active work while preserving the namespace when the runtime succeeds.
- **Restart** creates a new namespace generation and clears in-memory state.
- **Stop** ends the live runtime but keeps its transcript.

The results surface shows one selected run rather than an ever-growing feed. Its compact history
selector lets you revisit earlier runs of the same file. Static PNG and SVG figures emitted with
normal display behavior such as `plt.show()` or IPython's `display(...)` appear inline at a useful
size and open directly in Scient's existing full static-image viewer when selected. The small image
toolbar's menu offers copy, original download, available MATLAB FIG download, and the floating viewer;
figure details stay in the menu. If a preview cannot load, **Try again** retries the image without
rerunning your code. Original and native downloads remain available independently of preview decoding.
Moving a figure between the full
and floating viewers preserves one presentation owner rather than showing two copies; closing that
viewer stops its updates and later runs never reopen it.

A viewer opened from the current result can follow a generated project figure by its project path,
or a runtime figure by its language, saved full-file source path, and figure position. It advances
only after a newer matching run succeeds. Failed, cancelled, interrupted, or lost runs keep the last
good image. A successful full-file run that omits a followed runtime figure keeps the prior image
labelled **Previous figure**. New bytes are decoded before replacing the visible image, while an
identical-content rerun renews its retained resource without resetting zoom. Figures from a cell,
selection, unsaved buffer, historical run, or output without stable provenance remain immutable
snapshots.

PNG and SVG project files created or changed by that execution also appear inline, so an ordinary
script that saves figures remains useful without notebook-only display calls. Discovery is bounded
and reports when a project or execution exceeds its safety limits; Scient never guesses figure paths
from printed console text.

While the newest run is still updating, its text and status remain current but Results keeps the
last successful figures from the same file and session generation visible. The figures are labelled
as previous and link back to the run that produced them. The same continuity remains after a failed,
cancelled, or lost run; it clears immediately when the new run produces figures or succeeds without
any.

The selected run's result is shown immediately. The file results surface does not repeat the full
submitted code beside the editor; it shows only whether the run used the file, a selection, or a
cell, the relevant line range, and whether the submitted buffer was unsaved. Scient still retains
the exact submitted bytes as durable provenance. If a saved file has changed since the selected run,
the same compact context says **Source changed** without exposing a revision hash.

A normal successful file run shows its figures and text directly, without another large card that
only says **File**. If one run produces several figures, they appear as peer result cards in the same
run. Compact context remains visible when it matters, such as for a selection, cell, unsaved buffer,
running execution, or failure. The separate Compute history keeps source labels because it can span
multiple files.

The separate **Compute** project surface is secondary: use **New compute session** from the
right-panel add menu when you need a kernel that is not tied to the open file, or open project
history once more than one session exists. It is
not a second editor and has no generic code composer.

Supported scalar tables appear as bounded previews, and Plotly outputs use Scient's existing
interactive chart viewer. Plotly is part of Scient-managed Python; a user-owned Python must provide
its own Plotly package. A **Limited preview** label identifies clipped tables; this is not a
full dataset browser. Unsupported or malformed rich output retains its available plain-text
fallback. Viewing results does not enable executable HTML or widgets.

The secondary **Variables** view describes the current live Python namespace with bounded names,
types, shapes or sizes, and safe previews for simple values. It is a sibling tab of **Results**
whenever that pane is open. The session overflow is only **Restart session** and **Stop session**;
**Interrupt** appears while code is running. It refreshes after a run finishes,
including a failed run because assignments before the exception may remain. It is not saved in run
history, cannot be attached to an older session, and clears when the session restarts. Unsupported
objects remain visible by name and type without asking them to generate an arbitrary representation.

While code is running, **Interrupt** cancels that execution but keeps variables already stored in the
session. The session actions menu contains **Restart session**, which clears Python variables while
keeping history, and **Stop session**, which closes the kernel while keeping history. Restart and stop
ask for confirmation because their in-memory state cannot be recovered.

Past sessions retain their exact submitted code, text output, errors, tracebacks, and static figures.
Reopening a result never starts a kernel or replays code. Source links in the separate Compute
surface return to the ordinary project editor. Python errors keep their full bounded traceback and
show project-local frames as source links; dependency and standard-library frames stay readable but
cannot become filesystem links. Files created by code are ordinary project files;
writing an SVG or PNG during an execution also snapshots that static figure into the retained result.
Changing the project file later does not rewrite what the earlier run displayed. Other generated
file types remain ordinary project files and are not inferred from their names or printed paths.
Retained compute history is operational data, not a second project filesystem or a portable result
package.

Scientific code runs with the filesystem and network authority of the selected Scient server
environment. It is not sandboxed. Only run code you trust, especially when the server is remote.

Python is disabled by default until a user enables it or explicitly starts managed setup. R, Julia,
arbitrary package installation, notebook editing, rich executable HTML/widgets, rich variable
drill-down/table browsing, and portable stateful compute-result promotion remain future work.

### Run fresh and MATLAB batch

**Run file** reuses this tab's session. Choose **Run fresh** from the Run menu to execute the
whole buffer in a new Python or MATLAB session. Its variables start empty; your existing
session is untouched. Scient retains the results, then closes the temporary session.
Fresh does not mean sandboxed: it uses the same selected runtime, packages, project files,
and server permissions. It can still modify files.

After a fresh or batch run, the compact results selector lets you return to **Session** or
view a previous run without executing anything. Switching threads or views does not stop
work. Closing the owning file/Compute tab stops its session and any fresh or batch runs;
if shutdown cannot be confirmed, the tab stays available with an error.

MATLAB also offers **Run MATLAB batch** for the exact saved `.m` file. This uses MATLAB's
native `-batch` process, not the Engine connection helper. It needs enabled, installed,
licensed MATLAB but does not require **Connect MATLAB** or an Engine connection test.
Results appear in the same pane, with the existing batch history and **Save to project**
action. Batch runs remain queued per MATLAB runtime; interactive and fresh sessions can
run concurrently within the host's resource limit.

Sessions, fresh runs, connection tests, and MATLAB batch share one host budget. The default allows
one slot per 4 GiB of total host memory, with a minimum of one and maximum of sixteen. This limits
simultaneous runtimes, not open tabs, and does not reserve or enforce memory for individual programs.
On a one-slot host, a live session leaves no room for Run fresh. Scient never stops it automatically:
the capacity menu offers **Stop this session and run fresh…**, with confirmation that its variables
will be lost. Cancel keeps the session. Fresh execution begins only after shutdown is confirmed;
another operation may take the freed slot, in which case the capacity warning remains actionable.
