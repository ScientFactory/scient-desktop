# Work inside a project

Scient is designed for your AI to work inside a project, not only answer
questions in a chat. A project is the folder that contains the real work you
want help with: code, data, notebooks, papers, notes, figures, LaTeX files, or
other research material.

When you open a project, its conversations run in that project's selected
folder and environment. Depending on the provider, available software, and
permission mode, the AI can:

- inspect and search the project's files and structure;
- read, create, and edit files;
- run commands, scripts, tests, and analysis tools available in the
  environment; and
- examine the results and continue the work from what actually happened.

This is what makes Scient a working environment rather than a separate chat
window. Instead of copying fragments into a conversation, you can ask the AI
to investigate the actual project, run its workflow, update its outputs, and
keep the resulting files together.

For scientific work, a “project” does not need to be a software repository. It
can be an experiment folder, an analysis, a manuscript, a literature review,
or any other folder whose files belong together.

Opening a project does not automatically change every file or grant every
action. The AI accesses files and runs commands as needed for the task, subject
to the selected provider, environment, and [permission mode](permission-modes.md).
Use **Supervised** when you want to approve commands and file changes.

## Open or create a project

Scient can open an existing folder or create a new one from **Add project**.
You can also add projects from Git URLs, GitHub, GitLab, Bitbucket, and Azure
DevOps.

## Local folders

In the desktop app, open **Add project** and choose **Local folder**. You can:

- browse to a folder and select **Add**;
- type a new folder path and select **Create & Add**;
- choose **New folder** to prepare a collision-safe name in the current
  directory; or
- drop one local folder onto the folder browser.

**Open in Finder** remains available while browsing on macOS.

## Optional Scient project setup

Before a local or remote folder is registered, Scient checks only its small
project foundation. An ordinary folder offers two choices:

- **Set up a Scient project** creates missing `PROJECT.md`, `AGENTS.md`, and a
  local `.scient/project.json` identity; or
- **Open without setup** registers and opens the folder without changing it.

Both choices let Scient work inside the folder. The optional setup adds a
small, project-owned foundation so people and agents can record project context
and instructions; it is not required for ordinary file access or command
execution.

Scient never replaces an existing `PROJECT.md` or `AGENTS.md`. If an earlier
setup was interrupted, Scient can continue only while the recorded files are
unchanged. Conflicting or invalid state is shown for attention, but the folder
can still be opened normally.

If setup fails after project registration, the project remains usable and the
notification offers **Retry setup**.

Project setup adds only the project foundation described above. It does not
install software or change the project's source-control configuration.
