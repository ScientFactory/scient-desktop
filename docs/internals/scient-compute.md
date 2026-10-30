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
  `jupyter_client`. **MATLAB** runs through the Engine bridge (`scient_matlab_engine_bridge.py`) and,
  for `Run MATLAB batch`, the older `analysis` one-shot runner.
- **Scient-managed Python** is a private, uv-built CPython with reviewed Toolkits, installed as
  immutable generations (`ManagedPythonEnvironment`, `ManagedPythonProvisioner`, recipes in
  `managed-python/`). See [Managed compute recipes](../operations/managed-compute-recipes.md).
- Compute is trusted local execution with the server account's authority. Launches drop
  Python/Jupyter overrides and the app's own sign-in tokens (`ComputeEnvironmentPolicy`); the user's
  own credentials stay available to their code.

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

Figures return to the model as MCP image content (`scientToolImages.ts`). Agent runs appear in the
session's history like any other run, marked by their actor.

## Notebooks

`.ipynb` files open in `apps/web/src/scient/notebook/` on the document persistence lease that also
saves Markdown and LaTeX. Code cells run in the notebook's file session through the shared Run
control; a finished run's outputs become nbformat outputs on the server (`compute.notebookOutputs`,
figures inlined) and are written into the cell. Unedited cells keep their saved form.
