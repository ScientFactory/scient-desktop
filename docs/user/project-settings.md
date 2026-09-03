# Project settings

Project settings control project-specific behavior such as reusable agent
instructions, the icon shown in Scient, and commands that open a local preview.
They do not change the settings of every other project.

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
emoji from the project name.

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

## Keep the default branch current

Turn on **Automatically pull** in a project's settings to keep its default-branch checkout current.
Scient checks in the background and when the server starts. It uses the branch's configured
upstream and only performs a fast-forward pull when the checkout has no working-tree changes,
untracked files, or local commits.

The pull is skipped if the checkout is on another branch, has no upstream, or contains local work.
Pull failures do not prevent the server from starting.
