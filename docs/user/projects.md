# Starting a project

Scient can open an existing folder or create a new one from **Add project**.
The source choices for Git URLs, GitHub, GitLab, Bitbucket, and Azure DevOps
remain available.

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

Scient never replaces an existing `PROJECT.md` or `AGENTS.md`. If an earlier
setup was interrupted, Scient can continue only while the recorded files are
unchanged. Conflicting or invalid state is shown for attention, but the folder
can still be opened normally.

Projects initialized by the previous Scient app keep their compatible local
identity and existing skill record without silently changing either one.

If setup fails after project registration, the project remains usable and the
notification offers **Retry setup**.

Project setup does not install skills, migrate data from the previous desktop
app, or change source-control provider behavior.
