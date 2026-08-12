# Run a MATLAB file

Status: candidate behavior under review; not yet a released Scient capability.

Scient can open and edit a project-owned `.m` file even when MATLAB is not installed. When a
user-installed MATLAB is available on the same environment as the Scient server, the file viewer
adds a compact **Run file** panel.

## Use the candidate

1. Open an initialized Scient project and select a text `.m` file.
2. Wait for any pending save to finish. Scient runs the exact saved revision, not an unsaved or
   stale buffer.
3. If MATLAB was not found, expand the panel, enter the path to the MATLAB executable, and choose
   **Use path**. You can also ask Scient to scan again.
4. Choose **Run file**. Standard output, errors, status, and a local per-file run history appear in
   the panel.
5. Choose **Stop** to cancel an active run.

On macOS, a typical executable is
`/Applications/MATLAB_R2025b.app/bin/matlab`. Windows and Linux paths depend on the installed
release. Scient uses the user's installed and licensed MATLAB; it does not bundle MATLAB or grant
a license.

Viewing and editing never launches MATLAB. A missing or invalid runtime is a setup state, not a
file-viewer failure. A folder opened without Scient project setup remains viewable and editable,
but Run file stays disabled until the folder is set up. Output is capped with an explicit
truncation notice, and an interrupted run is shown as lost after Scient restarts.

This first candidate runs a complete `.m` file in noninteractive batch mode. Selection/section
execution, figures, variables, `.mlx`, `.mat`, toolboxes, license diagnostics, debugging, tests,
notebooks, and agent/MCP integration remain future work.
