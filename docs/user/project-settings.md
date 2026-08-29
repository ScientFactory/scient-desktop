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

Scient selects a project icon automatically from common favicon and app-icon
paths or icon links in project HTML files.

To choose a different icon:

1. Open the project selector at the top of the sidebar.
2. Select the settings control beside the project.
3. Under **Project → Project icon**, select **Choose file**.
4. Search for an image file and select it.

Scient supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, use the reset control beside **Project icon**.

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
