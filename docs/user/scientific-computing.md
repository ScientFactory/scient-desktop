# Scientific computing

Scient can run Python, R, Julia, SQL, and MATLAB from an initialized project without turning the
project into a notebook or installing a second copy of its files. All of them use the same session,
source, results, and history controls. Looking for a language does not download a runtime, install
packages, create a managed environment, acquire a license, or start a session. MATLAB requires a user-installed,
licensed runtime and a compatible Engine host. See [Run a MATLAB file](matlab-run-file.md) for its setup and
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

Setting up managed Python from a file that has no usable runtime selects the new environment. So does setting it up from Settings on **Automatic**. If you chose another Python, that
choice stays, and the managed environment becomes another runtime you can select.

The managed environment is optional. To use Python you already maintain instead:

1. Open **Settings → Scientific Computing** for the server environment you want to use.
2. Open **Python**.
3. Choose **Automatic** or an installation under **Runtime**. To enter a path, open
   **Found on this computer**, fill in **Add a location** and choose **Use**.

Any CPython runs, with nothing added to it. Scient needs `jupyter_client` and `ipykernel` to run a
session, and a Python that lacks them keeps running your code with your packages: Scient adds what
is missing in its own folder and never writes to your environment. The first time a computer has
no Python that can carry a session, Scient adds a small private Python of its own, about 60 MB,
once. It hosts sessions and SQL, and it never runs your code.

New sessions use the first of these that applies: a choice for this run, a choice remembered for
this project, the project's own environment (`.venv`, then `.conda`, then pixi's `default`, or a
single child folder with `pyvenv.cfg`), the path or Scient-managed Python you picked, Scient-managed
Python if set up, then other Pythons in PATH order. A runtime you chose that goes missing stays
chosen and says why it cannot run. Agents follow the same order.

Settings → Scientific Computing shows every language at once: **Most used** first, then one group
per field. Each language sits in one place and says where it stands: what it runs on, or **Not
connected** or a problem. **Kernel found** means a language's own kernel
was found and has not been started yet. **Not found** means Scient looked in the usual places, and
**Couldn't check** means a place did not answer in time. **Coming soon** beside a name means Scient
cannot run that language yet. Looking starts nothing: no language, kernel or licence check runs
until you press Run or Test. Every language opens its own page with what was found, where, and
**Add a location** for a copy Scient could not know about. A file's language status opens that page
directly. Each optional Toolkit has its own **Download**
action; installed Toolkits have a small menu with **Remove**. There is no separate Apply step.
Toolkits appear once Scient-managed Python is installed. Toolkit operations continue when you leave
the page; status reflects the server's verified installation, not the click.
You can request more Toolkits while another is installing. Each row shows its own progress,
queue, cancellation, or retry action. Pending requests are combined into the next verified
environment build; they do not run competing installers against the working environment.
Cancelling one pending Toolkit leaves the others requested. The queue lives on the server
and survives navigation, but not a server restart. A failed request can be retried independently.
Cancel immediately shows **Cancelling…** and prevents repeated clicks while the request is pending.
For an active build, feedback remains while shutdown and cleanup finish; a failed cancellation
restores the control so you can try again.
Every language page has the same rows. **Runtime** shows what new sessions use, with the one action
it needs, if any. Next comes what Scient itself adds, if anything: Scient-managed Python, a private
kernel such as Ark or IJulia, or the MATLAB connection helper, with its maintenance menu. **Found on this
computer** opens the full list, each with its version, where it came from (such as Homebrew, uv or
a conda environment), its path and **Test**.

Settings runs each Python briefly to read its version, a moment after the page opens, and gives up
on one that takes too long. **Test** starts and closes a real session without selecting that
runtime. **Testing…** shows an inline spinner. A green check and **Test passed** clear after four
seconds. **Test failed** stays available with error details and a retry action. **Copy path** copies
an installation's path. **Forget path** clears only a saved custom reference, never its files.
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
the same Python interpreter. Runtime selection remains available during preparation;
the latest selection is preserved when the verified generation becomes available.
**Repair** deliberately prepares a new private interpreter as well, so a damaged interpreter is
not reused or replaced underneath an existing session.
Downloads reuse Scient's private package cache, never a system or project cache. The installer
checks its size between provisioning stages and clears it when it exceeds 2 GiB; in-flight downloads
may exceed that retention limit. Cache cleanup cannot remove packages from an installed generation.
First-time downloads and verification still take time; the inline status reports the current stage.

**Runtime** changes only which runtime new sessions prefer. **Automatic** restores discovery instead
of pinning an installation. Choosing an existing Python also
releases Scient-managed precedence; it does not copy or modify packages. **Repair** builds and
verifies a fresh managed generation before activating it; an existing generation remains available
if setup fails. **Update** appears when Scient's release catalog offers a newer compatible,
qualified Python or Toolkit recipe. It appears as a small **Update** button beside the managed row's menu, including when
that installation is not selected; progress replaces the button while updating. The MATLAB
connection row follows the same rule for Scient's helper only, not the MATLAB application or
licensed toolboxes. Repair and Remove remain in the menu.

First-time setup checks for the newest compatible qualified recipe and installs it directly;
there is no required install-then-update step. Opening Settings checks for releases in the
background but never changes installed packages. **Update** preserves the optional Toolkits you
have installed. Adding/removing a Toolkit and **Repair** stay on your installed recipe instead of
silently updating unrelated packages. An unrecognized older installation may need an explicit
Update before it can be repaired with this app's supported recipe contract.

If the release check is unavailable, Settings says so without marking a working runtime broken.
Cached releases remain usable. A first installation can fall back to Scient's bundled recipe if
the latest recipe files cannot be downloaded; package downloads still require the network unless
already cached. An Update never substitutes an older environment. Recipes withdrawn for safety
are not offered for new installs, repair, or Toolkit changes; existing sessions are not killed.

**Remove** deletes only Scient's private environment and is refused while a Scient-owned
session or probe is using that environment. Sessions using unrelated Python installations do not
block removal. Scient tracks environment usage, not individual Python imports: an idle session can
still import a package later. Old generations are reclaimed after their last user closes, while the
active generation and one rollback generation are retained. Interpreter builds and the bounded
download cache are retained for reuse; removing an environment is not a purge of those stores.
If activation metadata cannot be read, startup preserves the existing generations rather than
treating them as abandoned. This also applies to MATLAB connection-helper generations.
These usage guarantees cover processes owned by Scient, not arbitrary external terminals launched
against its private environment paths. Project `.venv`, configured, system, Homebrew, Conda, pyenv, and
other user-owned installations are never repaired or removed.

Before a session starts, the file header names the interpreter it found (**Python 3.12**,
**MATLAB R2026a**) when you can run. That listing is a package check, not proof a Jupyter or Engine
session already started. A live session identifies its current environment, such as **Python · System**
or **Python · Scient-managed**, and adds **Running** while busy. The tooltip includes its version and
executable. The compact status opens Scientific Computing, or offers an explicit switch when a
different ready default is available; it never expands into a full-path card.
If setup fails for the runtime the file needs, the header shows a one-line status with a copy control and a details toggle; it
never wraps a stack or path across **Run**. A code error remains a result of that execution; it does
not make a healthy Python or MATLAB runtime unready. The refresh control in Scientific Computing
performs lightweight runtime rediscovery so an installation or environment change can be recognized
without reloading the app. **Test** in the installation menu starts and closes a temporary session;
a package check is not a successful test.
**Repair** rebuilds a damaged Scient-managed generation; it is not how you recover from a failed
Test. Scient never swaps the interpreter beneath a live session. If the selected Python changes
while a session is open, select its environment label or **Switch Python environment…** in the run
menu. Confirmation names the replacement environment, checks its availability, and starts a new
session only after the old idle session has stopped. Current variables are cleared; run history is
kept. A busy session is not stopped by switching, and no code is automatically rerun. Changing a
default alone never replaces a live session or overrides a deliberate per-tab choice.

Setup, repair, removal, and runtime-selection changes update open compute views automatically,
even if you leave Settings before setup finishes. Use the Settings refresh after Python, MATLAB, or
their packages change outside Scient. Settings opened from a project always manages that project's
server.

If a selected managed installation is damaged, Scient keeps it visible for **Repair** rather than
quietly running your code with a different Python. You can explicitly choose an existing environment
instead. Removing the managed installation intentionally returns new sessions to existing-runtime
discovery; it does not remove your other Python installations.

An existing Python can run ordinary code without every scientific library. If the reviewed
Scientific Python Toolkit packages are missing, the status tooltip notes that some Scientific Python Toolkit packages are missing.
Run remains available for code that does not need those packages; Scient does not
silently install them into a user-owned environment.
An unrelated managed setup or removal failure does not disable or replace the status of a usable
independent runtime. The file keeps its healthy live session status, or the independent runtime's
status before startup. A cached probe alone does not clear a failure of the managed runtime itself.
Setup failures remain available in Settings under **Error details**; active setup progress and Cancel
remain visible on the file. Select the file's Python status to open
the right server's Scientific Computing settings. After choosing or repairing an environment, rerun
the code yourself; Scient never replays a failed run automatically.

For a missing, recognized Python dependency, the error offers one action. When Scient-managed
Python is installed and has the package, it is **Switch to Scient-managed Python**: one click
rechecks the environment and package, stops this tab's idle session with confirmed cleanup, and
starts an empty managed session. Variables reset, as the note beside the button says; nothing is
installed, rerun, or changed in your default environment. Otherwise the error offers
**Python settings**. Package presence is not a guarantee that the script will succeed. Unknown
project imports and missing submodules get neither action.

## R, Julia, and SQL

R, Julia, and SQL run as Jupyter kernels behind the same bridge as Python. `.R` and `.jl` files
use `# %%` cells and `.sql` files use `-- %%`; Run cell, selection, file, and **Run fresh** work as
they do for `.py`. Run needs no setup step: a missing kernel is added the first time you run.

- **R** uses the R found on PATH, in its usual install locations, in a conda environment or in the
  Windows registry. An R that already has IRkernel uses it. Otherwise Scient adds
  [Ark](https://github.com/posit-dev/ark), a standalone R kernel of about 8 MB, to its own folder.
  Nothing is installed into your R libraries, so renv projects and pinned packages are unaffected.
  On Windows Scient always uses Ark, because IRkernel cannot be interrupted there.
- **Julia** uses a person's own IJulia, or adds IJulia to a private Julia depot and project. Your
  default environment stays first, so `using` and `Pkg` keep working on your own packages. A folder
  with a `Project.toml` uses it, unless you set `JULIA_PROJECT` yourself.
- **SQL** runs DuckDB from any Python that has it, otherwise from Scient's private Python. Paths
  resolve from the
  project, so `SELECT * FROM 'data/table.csv'` or a Parquet file works directly. Tables and views
  last for the session and appear under Variables; **Restart** starts with an empty database.
  Results show the first 100 rows of each statement.

## Other languages

Every language Settings lists runs from its file. Open a `.sh`, `.c`, `.f90`, `.rs`, `.do` or
`.lean` file and press **Run**: Scient uses the best command it found on this computer, builds
first where it must, streams the output, keeps a record of the run and can stop it. Add a location
on the language's page when the tool lives somewhere unusual.

Scient runs the copy your terminal would, the first one on `PATH`, unless that is the copy the
computer came with and a newer one is installed. `JAVA_HOME` chooses Java. A choice on the language's
page outranks all of these. C++ builds to the newest standard your compiler knows and Rust to edition 2021. A file type two languages share goes to the first of them on this computer: `.m` to MATLAB, then
Octave; `.gp` to gnuplot, then PARI/GP; `.v` to Rocq, then Verilog; and `.pro` to IDL, then Prolog. A
`.sql` file that uses sqlite3's dot commands, such as `.bail on`, runs with `sqlite3` when it is here.
A `.lean` file in a Lake project runs through Lake from the project's folder, so its imports build
first; a Mathlib project fetches Mathlib's ready-built files the first time. Stata and SAS write
their results to files in the project's folder, and Run shows them: Stata's log, or SAS's listing
followed by any warnings. A do-file that stops at an error fails with that error, though Stata
itself reports success. A Stan model samples four chains with the CmdStan that cmdstanpy or cmdstanr
installed, reading its data from `<name>.data.json` beside it, and shows the summary and
diagnostics; the draws stay in `<name>-draws` beside the model. A NetLogo model runs its first saved BehaviorSpace experiment and shows the results table, since
NetLogo runs nothing else without its window; save an experiment in the model to run it. A run gets
no typed input, so a tool that waits at a prompt after its file exits instead.

The output fills the pane. A file shows only **Run** until it has a result; then **Code**, **Split**
and **Results** appear, and reopening the file brings its last run back. Each `file:line` in the
output opens that line. A failed run offers **Ask agent**, which adds the error to your chat as a
quote and leaves what you are typing alone. Selected output offers **Ask in chat**, as in every other
language. Pictures a run writes in the project show as results, and tables it writes are linked. The run's menu holds
**Run with**, for one run on another install, **Save to project**, **Remove this run** and **Clean up
project**.

Any installed Jupyter kernel also works in notebooks and for agents. Scient finds kernels in
Jupyter's usual folders and in every Python environment it can see, and a new kernel works without
restarting Scient. These languages have no Variables pane, and Scient has no private part in them.

| Language         | Needs                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Rust             | [evcxr](https://github.com/evcxr/evcxr/tree/main/evcxr_jupyter)                                              |
| GNU Octave       | GNU Octave and [octave_kernel](https://github.com/Calysto/octave_kernel)                                     |
| Stata            | Stata 17 or later and [nbstata](https://hugetim.github.io/nbstata/)                                          |
| Wolfram Language | Wolfram Engine and [WolframLanguageForJupyter](https://github.com/WolframResearch/WolframLanguageForJupyter) |

A notebook in a language Scient cannot find opens normally and shows **Not found**.

## Find a run

Choose **Compute history** in the Console toolbar to see the project's runs, newest first.
Choose a run to see its code and output. Use **Filter by file** to find a script's runs.
Use **Stop** on a running entry. Choose **Sessions** to open a session and see its variables.
Switch back to **History** to return to your filter and opened runs.
Notebook **Run All** appears as one entry and shows the current cell out of the total. Open it to see the cells and their output. If a cell fails, the entry shows where the run failed and how many cells did not run.
The agent icon opens the chat that started the run. A script's **Results** also shows runs
of that file started by agents in other chats. You can review history without starting a runtime.

## Console

Open **+** → **Scientific computing** to start a Console. If a blank Console is already open in
this thread, Scient selects it. For another tab, choose **New console** in the Console toolbar or
in Compute history.

Type code and run it to see the output above the input. The first run starts the language.
Each Console has its own session. Values stay available until you restart or stop that session.

**Shift+Enter** or **⌘Enter** runs, **Enter** adds a line, and **↑** and **↓** walk through what you
ran. The picker in the box lists every language installed on this computer. One Console holds one
language, so picking another after you have run something opens a second Console beside it. Before
that, the Console and anything you have typed simply move to the new language. If the language a
Console ran on is no longer available, the Console says so and keeps your code. It never runs it in
another language on its own.
**Variables** appears once there are variables. **Save as notebook** turns what worked into an
`.ipynb` in the project and opens it; runs that failed are left out. **Run file…**, **Restart session**
and **Stop session** are in the **⋯** menu.

Opening a file from an empty Console replaces it, as an address does in a new browser tab. A Console
with anything in it, even a half-typed line, stays where it is and the file opens in a new tab.

**A script shares memory with a Console of its language.** With a Python Console open, running a
`.py` file that has no session of its own uses the Console's session: the script sees the Console's
variables, and the Console sees the script's. Results appear in both places, and the Console waits
while a long file runs. Closing the script leaves the Console running; Restart or Stop from the
script acts on the shared session, so the Console loses its variables too. Without a Console, each file
tab has its own session. A notebook always has its own memory, so **Restart and run all** gives the
same result every time.

## Connect your MATLAB installation

Open a `.m` file and select its MATLAB status to open **Scientific Computing** for that server.
Turn MATLAB on there and choose **Connect MATLAB** when a connection helper is needed.
Opening the file does not start Scientific Python or provision its Toolkit. When the file needs the
failed helper, its failure appears as a short header status with copy and details;
setup and recovery remain available in Settings. Scient does not
install MATLAB or a license. If several copies are installed, open
**Settings → Scientific Computing**, select **MATLAB**, and choose the installation, or
leave automatic discovery selected.

The same executable preference is used by live Compute sessions and fresh-process
MATLAB runs. Existing preferences are respected; saving a new choice or clearing it
does not reintroduce an older path.

Opening Settings and its refresh control only look for MATLAB installations and read their metadata;
they do not import MATLAB Engine or start MATLAB. Recent status stays visible while being rechecked.
Choosing an installation does not promise that the Engine works or a license is available. Run the
file, or use **Test**, to prove the Engine host. A license/startup failure
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
- **Split** keeps code and the results side by side.
- **Results** gives the results the full surface.

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

The first run starts this file tab's session when necessary and reveals **Split** by default, or
**Results** when that was the last results layout you chose. Each file tab owns its own session unless
a Console of its language is open, so several Python and MATLAB files can run independently within the
server's capacity. Values defined
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

Results is the session's feed: every run of the session, oldest first, including runs an agent
submitted (marked **Agent**) and Run fresh runs. It follows new output while you are scrolled to the
bottom and stops following when you scroll up. A restart adds a divider instead of clearing earlier
runs. Each run has one quiet header line naming what ran (**File**, **Cell 4–8**, **Selection 12**,
plus **unsaved** when relevant); selecting it opens those source lines. Status appears only while a
run is queued or running, or when it was cancelled or failed without an error shown below it.
Hover the header for its time and duration.

Results render text with ANSI colors and carriage-return progress bars (such as tqdm), merge
consecutive stream chunks, and keep standard error subtle. Rich results render HTML (sanitized: no
scripts, styles, or remote content), Markdown, LaTeX math, JSON as a collapsible tree, pandas tables,
Plotly, and PNG, SVG, JPEG, and GIF images. Long outputs collapse with **Show all**; hover an output
to copy it.

Figures emitted with normal display behavior such as `plt.show()` or IPython's `display(...)`
appear inline at a useful size, directly in the run, and open in Scient's full static-image viewer
when selected. Figure actions appear
on hover: open in the viewer, and a menu with copy, original download, available MATLAB FIG
download, the floating viewer, and **Save to project**. Saving copies the figure into
`figures/<source file name>.png` (and `.pdf` when Matplotlib supplied one, as Scient-managed Python
does for shown figures); an existing file is never replaced, so a second save becomes `-2`, `-3`, ….
If a preview cannot load, **Try again** retries the image without rerunning your code. Original and native downloads remain available independently of preview decoding.
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

PNG and SVG project files created or changed by that execution also appear inline, at any depth and
however large the project is, so an ordinary script that saves figures remains useful without
notebook-only display calls. Scient never guesses figure paths from printed console text.

The separate **Compute** project surface is secondary: use **Scientific computing** from the
right-panel add menu when you need a kernel that is not tied to the open file, or open project
history once more than one session exists. It is
not a second editor and has no generic code composer.

The separate surface shows one runtime indicator, such as **Python 3.14**, with a spinner while the
kernel is busy; it becomes a session switcher only when there is more than one session.

pandas tables appear as bounded previews, and Plotly outputs use Scient's existing
interactive chart viewer. Plotly is part of Scient-managed Python; a user-owned Python must provide
its own Plotly package. A **First 100 rows** caption identifies clipped tables; this is not a
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
Scient learns which SVG/PNG files an execution wrote and retains verified static figures, at any
depth and through any library. It watches the project folder for the session or run; hidden folders,
`node_modules`, and Python or conda environments are left out. Python also reports the files each
cell saves. Scient reads only files inside the project that changed during the execution.

If the watch cannot start or loses events, for example while thousands of files change at once or on
some network folders, Scient falls back to a bounded search for recently changed files. When that
search cannot finish, verified figures are still retained alongside a compact coverage warning. The
warning does not mean the code failed or establish that any figures were lost. A watched file also
does not prove which process wrote it.
Changing the project file later does not rewrite what the earlier run displayed. Other generated
file types remain ordinary project files and are not inferred from their names or printed paths.
Retained compute history is operational data, not a second project filesystem or a portable result
package.

Scientific code runs with the filesystem and network authority of the selected Scient server
environment. It is not sandboxed. Only run code you trust, especially when the server is remote.

Nothing is installed until you or an agent runs something that needs it. Arbitrary package installation into Scient-managed Python, interactive widgets,
and saving a session's state as a portable result remain future work.

### Run fresh and MATLAB batch

**Run file** reuses this tab's session. Choose **Run fresh** from the Run menu to execute the
whole buffer in a new Python or MATLAB session. Its variables start empty; your existing
session is untouched. Scient retains the results, then closes the temporary session.
Fresh does not mean sandboxed: it uses the same selected runtime, packages, project files,
and server permissions. It can still modify files.

Fresh runs appear in the file's Results feed, marked **Fresh**. After a MATLAB batch run, the
compact results selector lets you return to **Session** or view a previous run, named by its time,
without executing anything. Switching threads or views does not stop
work. Closing the owning file/Compute tab stops its session and any fresh or batch runs;
if shutdown cannot be confirmed, the tab stays available with an error.

MATLAB also offers **Run MATLAB batch** for the exact saved `.m` file. This uses MATLAB's
native `-batch` process, not the Engine connection helper. It needs an installed,
licensed MATLAB but does not require **Connect MATLAB** or an Engine connection test.
Results appear in the same pane, with the existing batch history and **Save to project**
action. Batch runs remain queued per MATLAB runtime; interactive and fresh sessions can
run concurrently within the host's resource limit.

Sessions, fresh runs, connection tests, and MATLAB batch share one host budget. The default allows
one slot per 4 GiB of total host memory, with a minimum of one and maximum of sixteen. This limits
simultaneous runtimes, not open tabs, and does not reserve or enforce memory for individual programs.
When the host is full, a new run closes the session that has been idle longest, and that file says so
where its variables were; its results stay. Running work is never stopped. If everything is busy, the
capacity menu offers **Stop this session and run fresh…**, with confirmation that its variables will
be lost, and Cancel keeps the session.

### Save and compare linked results

Save the script, then make it write its outputs to the folder in `SCIENT_RESULTS_DIR`.
Scient keeps JSON values, CSV tables and figures from a successful fresh run as a revision.
Use **Insert ▸ Result** in a manuscript to link to that revision.

- Choose **Run ▸ Run with setup…** in a file or **Run setup…** on a linked result.
  The same dialog opens with the last saved setup. Parameters use JSON values. Enter `0.7` for a number and `"adults"` for text. The script receives one
  JSON object in `SCIENT_PARAMETERS` when you supply overrides. A script's own defaults stay
  in its code.
- Select **Add file…** to declare an input. A saved SQL view also declares the files it names.
  A missing declared file stops the run before it starts. The result shows how many files you
  declared, how many Scient saw the runtime read, and when the check covered only some inputs.
  In R, Julia, SQL and MATLAB, **Suggested from the code** shows existing project files named in the
  saved script. Choose **Add** beside a suggestion to declare it for this run.
- Open **Run details** to see which inputs Scient checked. Python can record directory listings
  and name data files read outside the project. Freshness for those outside files is unknown.
  Declare datasets read by native readers such as DuckDB, PyArrow or Polars.
- **Run fresh** and **Re-run** reuse the latest saved setup. Remove all parameters or all
  declared files in setup to clear that list for the next run.
- Open **Compare with…** from a result or a manuscript link. Choose the **From** and **To**
  revisions by time and parameters. **Swap sides** reverses the comparison. **Show unchanged**
  includes matching values and files. Open either revision's actions menu to export it for rerun.
  Older figures and tables may have aged out of local history.
- When a run fails or stops, the paper keeps its saved value. Choose **View output** to see what
  happened or open **Run details** to see what the saved run checked. If a later run succeeded,
  check its value before choosing **Update value**.

Each revision records the runtime and any recognized lockfiles at the project root. Python
can also report its installed package versions. **Environment may differ** means a recorded
lockfile changed or disappeared. Compare the saved evidence to review what differed between runs.

Agents can use `scient_results_run` with parameters and input paths, `scient_results_list`
with the analysis path to find revision IDs, and `scient_results_compare` to compare them.

## Share a result for rerun

Choose **Export for rerun…** from **Result packages** in Compute history, on a result card, or
from either revision's actions menu in a comparison. Choose the saved revision by its date and
parameters. Export from a card or comparison starts with that revision selected.

Select the data files you want to share. Scient automatically includes local code files the run
was recorded reading. Data already under `data/` keeps that package path. The README maps every
included data file to its original project path. Scient shows file sizes and flags changes since
the run. Review the environment files and clear any you want to leave out. Scient removes a
machine-specific Conda prefix and excludes environment files that still contain a home-folder
path. Choose where to save the package. Scient shows progress as it computes file digests and
opens the package location when the Compute computer has a file manager.

The folder contains a README, a manifest, the source that ran, the saved outputs, available
environment evidence, and RO-Crate metadata. If the project has a LICENSE file, the package
carries it with the crate. The manifest lists the size and SHA-256 digest of each input where
available and identifies digests computed at export. Give your colleague access to any data they need to
supply separately. Review the copied files before sharing them. If Scient cannot find source
that matches the saved run, restore the matching source or save a new result and export it.

### Verify a package

1. In Compute or the command palette, choose **Verify a result package…** and select the package
   folder on the Compute computer.
2. If the author left inputs out, open **Separately supplied inputs** and choose a folder that
   holds those files at their original project-relative paths. Open **Verification settings**
   to select a runtime, change the tolerances or the 60-minute time limit, or put your name
   on the report.
3. Choose **Run and verify** only if you trust the package's code. Scient checks the files and
   runs the source in a new working folder with the recorded settings. You can close the dialog
   while it runs and return through **View verification** in the status notification. Choose
   **Cancel verification** to stop the rerun and save a cancelled report.
4. Read the verdict and each output's outcome. Expand the matched outputs or the rerun environment
   details to see more. The full report is saved as
   `verification.json` in a new folder beside the package.

Verification supports Python scripts and notebooks and R and Julia scripts. Set up the matching
runtime and dependencies before you run. Python notebooks need IPython. Copied lockfiles and
package lists help you choose the environment.

Scient compares tables, text and other files byte for byte. It compares JSON numbers with
absolute tolerance `1e-12` and relative tolerance `1e-9` by default. You can change both.
Strings, booleans, nulls and pairs of integer values must match exactly. Figures are compared by
hash and shown alongside the verdict. If values and other files match but the original inputs
changed or their coverage is incomplete, Scient reports **Outputs matched · original inputs
unconfirmed**.

Agents can use `scient_results_export` and `scient_results_verify` with folders inside the
current project. For export, pass a script or notebook path for the newest revision, or an exact
revision ID from `scient_results_list`. Tell your agent which files to share and whether it may
run the package's code.

## Notebooks

Open a Jupyter notebook (`.ipynb`) to edit its cells and see its saved outputs.

- Open **Notebook outline** in the toolbar and choose a heading to jump to it. The outline marks the
  selected section. Click a code cell's language label to fold its code to one line, and again to
  show it. Use **Cell actions** to collapse a heading's section or hide a cell's outputs. The file
  keeps those folds when you reopen it in Scient or JupyterLab.
- Point at a cell's number to run it, or choose **Run all**. Cells run in order and stop at the
  first failure; a summary under the toolbar shows the first failed cell, how many later cells were
  skipped, and a button to jump directly to it. Click code to edit it at the pointer, or click a
  Text cell to edit its Markdown.
- If a cell needs setup from earlier cells, select it and choose **Run from top through this cell**
  from the Run menu. When the selected cell reads a name that only an earlier, unrun cell defines,
  that action moves up to sit right after **Run all**. A Python error for an undefined name can also offer replay or a jump to the
  defining cell when live evidence shows it failed. Full tracebacks stay collapsed under
  **Details**.
- Text, figures, observed written file links and errors appear below the cell that produced them.
  Silent cells show a compact **No output** line, and outputs from an earlier session show when
  they ran and that they have not run in the current session. Choose **Show outputs** if a cell's
  output is folded.
- A dot and dimmed output mark a cell whose code changed or whose output may be out of date.
  Scient uses names in the code to guess which cells depend on earlier ones.
- Press Shift+Enter to run and move on or Cmd/Ctrl+Enter to run and stay. Press Esc to leave the
  editor. Then use `A` or `B` to add a cell, `J` or `K` to move, `D D` to delete, `Z` to restore
  the deleted cell, and `M` or `Y` to switch it to Text or Code. Press `I I` to interrupt a cell run.
- Open **Variables** to see the live session's variables.
- **Expand section** under a collapsed heading reveals its hidden cells.

### Run with parameters

1. Put simple assignments in a Python, R or Julia code cell. Open **Cell actions** and select
   **Tag as parameters**.
2. Change values in the parameters bar. These changes stay pending when you switch files and
   apply when you choose **Run fresh with input** from a data file. The bar can show the values
   the last clean run used. Expressions in the parameters cell run before the overrides apply,
   so move calculations that depend on changed values to a later cell.
3. To record data files with the run, choose **Input files…** from the Run menu. The list starts
   with the last published run's files. Add or remove files for the next fresh run; the
   confirmation names the files it records.
4. Choose **Run with changes** and confirm. Scient starts a fresh kernel and runs the saved notebook
   from top to bottom. It saves the overrides in an `injected-parameters` cell and updates the
   notebook outputs after success. A failed or stopped run keeps the previous outputs.

The fresh run shows the current cell and a **Stop** action. Before replacing the saved outputs,
Scient keeps the current notebook in **Retained file versions**. Choose **Restore…** there to
restore its source and outputs together.

**Run fresh** saves the notebook outputs, including for notebooks without parameters.
To publish a linked result revision as well, write figures, CSV tables or JSON values to
`SCIENT_RESULTS_DIR`. If there are no outputs to retain there, the last linked revision stays
published. The kernel receives the overrides as JSON in `SCIENT_PARAMETERS`.

Notebook authors can set control hints in the parameters cell's `metadata.scient.parameters`.
Use `{"threshold":{"min":0.3,"max":0.7,"step":0.1}}` for a slider or
`{"group":{"options":["all","adults"]}}` for a dropdown.

### Explore saved settings

Choose **Run for each … value** in the Run menu to save alternatives for one parameter. Scient
proposes values from the parameter's control hint. Edit them, up to 20, one per line, before
starting. Scient reports which settings it saved and which failed.
Open **Reader view** to choose among the saved settings and see their
values, tables and figures. Inline result values linked from the notebook's Markdown follow the
selected revision.

**Reset** returns to the published run or, if none exists, the newest saved setting that matches
the current notebook. Reader uses saved linked results. View ordinary cell outputs in the notebook
editor. Code starts folded; click a cell's language label to see the source saved with that run
when it is available. The line
under the parameters shows the saved run's time or tells you when no saved run matches.
When a setting was made with earlier
code, **Run for this value** saves an alternative while keeping the published setting and notebook
file in place. Browsing settings uses saved results.

Agents can read headings, parameter defaults and saved alternatives with `scient_notebook_read`.
They can tag or fold cells with `scient_notebook_edit` and publish a fresh run with
`scient_notebook_run` using `fresh: true` and JSON overrides such as `{"threshold": 0.7}`.

## Working with agents

Ask an agent to run a saved script by name, for example “Run threshold.py at its default
threshold and tell me the recall.” The file tool uses the project's Compute runtime and records
the run under the file. Agents use their own session by default. Ask the agent to use your open
session when you want it to see your current variables. Both kinds of run show **Agent** in Results.

Ask for parameter values and name the input files when a script needs them. The script must read
parameter values from `SCIENT_PARAMETERS`. Compute records the values and input paths. These runs
use a fresh session for session-based languages. Ask to publish a result when the outputs need to
be linked in a document.

Agents use the code tool for snippets and notebook tools to run cells. A run from the shell leaves
no Compute record. Parameters passed to a saved script appear in its history and chat rows.
Use values such as `{"threshold": 0.7}` for scripts that read `SCIENT_PARAMETERS`.
For a sweep, the agent runs the saved file once per setting. The tool reports project files
observed changing during the run. Expand a Compute run in chat to see its output. Agents run
code with the same authority as your own code.

### Files changed outside the editor

An open file shows the latest version by itself, so an agent's edit or a script's output appears while you keep your place, and what you see is what runs. Undo takes back your own edits, not outside ones. If you have unsaved edits when a file changes, nothing is overwritten: choose **Reload from disk** or **Use my edits**.

### Ask in chat

**Ask in chat** works as it does in documents. Select text in the Console, in Results or in a
notebook cell and choose **Ask in chat**: the quote becomes a chip in your message, with an optional
comment. To ask about a whole run or cell, such as a figure, use the same action at its top right.
In a script with `# %%` cells, click a cell and choose **Ask in chat** beside the pointer to quote
that cell. The agent receives the text and where it came from, and reads the rest of the run or cell
itself.

Click a chip, in your message or a sent one, to go back to the quote. A run opens in its script or
Console while they still hold its session, and otherwise in Compute history.
