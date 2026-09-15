# Run a MATLAB file

Use Scient's MATLAB panel to run a project analysis, inspect its output and
figures, and save useful results beside the rest of the project. Scient can
always open and edit a `.m` file. Running it additionally requires a
user-installed and licensed MATLAB in the selected project environment.

## Live session

The code/results controls above a `.m` file run it in a live MATLAB session.
Choose **Connect MATLAB** on that file when MATLAB is not connected yet. This opens the correct
server's Scientific Computing settings, where the same action starts setup. The Engine connection
requires a compatible Python host. Scient can set up a small private
**MATLAB connection helper**, or choose an existing compatible host from
**Settings → Scientific Computing → Runtime**.
That helper is independent of Scientific Python. Opening a `.m` file does not
provision the scientific Toolkit; a helper setup failure is a one-line header
status with copy and details, not a wrapped stack across **Run**. The compact
MATLAB status opens Scientific Computing directly; it does not expand into an
executable-path menu. Scient does not install MATLAB or its license. The file
header names the detected release before startup and uses the shorter **MATLAB**
label while a live session is idle. Use the refresh control in Scientific
Computing to rediscover installations, and **Test** beside the enable switch when
you explicitly want to start and close a temporary connection.

The executable preference is shared with native batch runs. Scientific Computing is the
single place to choose it; there is no separate batch setup form.
See [Connect your MATLAB installation](scientific-computing.md#connect-your-matlab-installation)
for setup, repair, removal, and the distinction between the helper and MATLAB itself.

On macOS, MATLAB may check its usual Documents folder during startup. If macOS
asks whether Scient can access Documents, answer that permission prompt before
retrying the session. Scient does not grant operating-system permissions for you.

Use **Run file**, **Run selection**, or **Run cell** for `%%` sections. Variables
remain available between runs until the session stops or restarts. Open **Variables**
next to **Results**; it is always a sibling tab on that pane.
Running code is not sandboxed.

Choose **Run fresh** from the Run menu to execute the buffer in a new Engine-backed session
without clearing your existing session's variables. Scient keeps the results and closes that
temporary session automatically. It uses the same packages and filesystem, not a sandbox.

For saved-file batch execution and portable run artifacts, choose **Run MATLAB batch**
from that same Run menu. Batch does not require the Engine connection helper:

## Native batch file run

1. Open an initialized Scient project and select a text `.m` file.
2. Wait for any pending save to finish. Scient runs the exact saved version,
   not an unsaved editor buffer.
3. If MATLAB was not found, open **Scientific Computing**, enable MATLAB, then
   choose a detected installation or use **Use another path…**. The page refresh
   control scans again.
4. Choose **Run MATLAB batch**. Standard output, errors, status, figures, and the
   file's recent run history appear in Results. Discovery is not proof of a working license;
   sign-in, licensing, dependency, and startup failures are reported by the run.
5. If another MATLAB batch run is active, the new run waits in the queue and shows
   its position. **Stop** cancels a waiting run or stops the active run.
6. Select a captured figure to inspect it as a static view or floating card.
   You can drag a thumbnail into the conversation, resize the floating card,
   or download its FIG representation for continued work in MATLAB.
7. Choose **Save to project** when a useful run should become an ordinary
   project result. Scient creates a folder under
   `results/<source>/<run>/` containing readable output, figures, continuation
   files, notes, and a machine-readable manifest. Repeating the action reopens
   the same result without overwriting your edits.

Use **Remove this run** to remove one saved run, or **Clean up project** to
review and remove saved run files that are no longer needed. Scient confirms
the measured size before cleanup and keeps a lightweight history of what ran.

On macOS, a typical executable is
`/Applications/MATLAB_R2025b.app/bin/matlab`. Windows and Linux paths depend
on the installed release. Scient does not bundle MATLAB or provide a license.

## Understand results and failures

Viewing and editing a `.m` file never starts MATLAB. A missing or invalid
runtime is a setup state, not a file-viewer failure. A folder opened without
Scient project setup remains editable, but **Run file** stays disabled until
the folder is set up.

When MATLAB reports an `MException`, Scient separates the structured error
from raw output. Select a project-local file and line to open it, or choose
**Ask agent** to place a focused repair request in the composer for review
before sending.

If another program or an agent changes the open file, Scient refreshes it.
When you have unsaved edits, it asks whether to reload the disk version or
overwrite it instead of silently discarding either version. Figure-capture
failure is reported separately from calculation failure, and long output shows
an explicit truncation notice.

The native batch workflow runs a complete `.m` file in noninteractive batch
mode, independently of a live Compute session. Neither workflow adds debugging,
MATLAB notebooks, or viewers for `.mlx` and `.mat` files. An Engine connection test is
not a prerequisite or a substitute for proving native batch execution on that environment.

The results selector changes only what you view. Navigation does not stop work; closing
the owning tab stops all of its runs and waits for cleanup. A cleanup failure stays visible
instead of silently closing the tab. Both execution methods count toward the host's capacity.
