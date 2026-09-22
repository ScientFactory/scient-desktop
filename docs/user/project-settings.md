# Settings and project overrides

On web and desktop, the Settings breadcrumb ends with the environment and project a change applies to. They start
at **All environments** and **All projects** and stay selected as you move between categories or
search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

On mobile, open **Settings** and use the filter in its header to choose connected environments
and a project. The filter stays available in server-setting pages. With **All projects** selected,
the **Server settings** categories and auto-settle controls in **Thread behavior** edit the
selected environments' defaults. Choosing a project edits its overrides on the selected
environments. Use **Use defaults** in a page to remove that page's project overrides.
Open **Settings → Projects & threads → Overview** to rename the project across its selected
connected checkouts and see where those checkouts live.
Settings that are environment-wide stay read-only while a project is selected. When selected
targets disagree, a control shows **Mixed** until you choose one value. Appearance, keyboard,
and other phone-only settings ignore the filter.

## Defaults and inheritance

General contains the model and workspace for new threads. Integrations controls agent browser
access. Source Control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

The Project category, shown while a project is selected, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there.

Settings a repository can also declare in `t3.json`, such as the workspace for new threads,
resolve in one order: a project override, then the environment setting, then `t3.json`, then the
built-in default. Leave a setting on **Inherit** to let the next tier decide.
Browser access changes apply when an agent session next starts.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Submodules** in **Settings → General** (with the project
selected to override it there) to **Top level only** to stop at the ones the repository declares
itself, or **Skip** to leave them for a setup script. It resolves in the same order as the
workspace default: a `"worktreeSubmodules"` value in the `t3.json` of the branch being checked out
applies when the project and environment are both on **Inherit**.

## Storage cleanup

Open **Settings → Storage** to enable automatic cleanup on one machine or all connected
environments. Policies are off by default and run on the server at startup, when changed, and
hourly. Offline machines keep their existing policies.

Select a project to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off keeps that project's worktrees until you remove them
manually. Custom applies separate worktree rules to the selected project or checkout. Browser
captures and log retention remain machine-wide.

Worktrees can be removed after a chosen number of inactive days, after merging, or when they
have no commits beyond the default branch. Only T3-managed worktrees are eligible. Active
sessions, shared worktrees, uncommitted changes, and ignored files other than `node_modules`
prevent removal. Branches and thread history stay; starting another turn recreates the checkout.
Merge cleanup requires the commits to be included in the remote default branch, so squash merges
may need the inactivity rule instead.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

Browser captures and rotated logs have separate retention periods. Expired capture links stop
working. Current logs, message attachments, and browser profiles are kept.

## Manage project skills

Open **Settings → Skills → Project skills**, then select the project. Valid skills from the selected
checkout's `.scient/skills` directory appear there. Choose **Agent access** to let the agent select a
matching skill, **$name only** to require explicit selection in the composer, or **Deactivated** to
hide it from future turns. These choices apply to the same Scient project across its worktrees;
each worktree still uses the skill files in its own checkout.

Project skills are project-owned instructions, not installed add-ons. Scient
validates them before use but does not rewrite them or grant them extra tools
or permissions.

## Customize a project icon

Scient selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files. If it does not find an image, it chooses a built-in
icon from the saved project name. In web and desktop, this icon stays the same when the sidebar
shows a repository label such as `owner/repo`.

To choose a different icon or emoji:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Next to **Project icon**, select **Choose icon**.
4. Search the full Lucide icon set and choose a color, or switch to **Emoji** and choose or paste
   an emoji.

To use an image from the project instead, select **Choose file**, search for an image, and select
it.

Scient supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Open a browser preview from a project action

Project actions that start a website or application can open it in Scient's Browser automatically:

1. Open a thread or new-thread draft in the project.
2. Use the project-action controls in the top-right thread header. Select **Add action**, or use the
   settings control beside an existing action to edit it.
3. Enter the development command and its **Preview URL**.
4. Turn on **Open Browser automatically when you run this action**.

When the action starts, Scient opens the Browser. Localhost preview URLs wait
for the configured server to become ready instead of showing an immediate
connection error. Running the action again focuses an already healthy matching
browser tab. If you leave or navigate the Browser while Scient is waiting, it
does not take focus back later.

Automatic preview is available in the Scient desktop app. Other clients still run the action but do
not open the embedded Browser. Actions that run automatically during worktree creation start on the
server and do not currently trigger this client-side Browser opening.

Local preview checks use the configured URL and its declared HTTP or HTTPS protocol. Scient does
not send web requests to arbitrary listening ports, including processes launched in its terminals:
a Python kernel or database may use a non-web protocol. For a server started elsewhere, enter its
URL in the Browser, or configure it as a project action's Preview URL. Printed terminal URLs and
recent browsing history do not by themselves enable background probing.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In **Source Control**, turn on **Automatically pull** to keep the default-branch checkout current.
Choose an environment to set the default or a project to override it.
Scient checks in the background and when the server starts. It uses the branch's configured
upstream and only performs a fast-forward pull when the checkout has no working-tree changes,
untracked files, or local commits.
On mobile, use **Settings → Source control** to change selected environment defaults or project overrides.

The pull is skipped if the checkout is on another branch, has no upstream, or contains local work.
Pull failures do not prevent the server from starting.
