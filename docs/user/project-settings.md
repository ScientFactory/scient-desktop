# Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Open a browser preview from a project action

Project actions that start a website or application can open it in Scient's Browser automatically:

1. Open **Settings** and select **Projects**.
2. Select the project and create or edit an action.
3. Enter the development command and its **Preview URL**.
4. Turn on **Open Browser automatically when you run this action**.

When the action starts, Scient opens the Browser. Localhost preview URLs wait for the configured
server to become browser-ready instead of showing an immediate connection error. If startup takes
longer than one minute, the Browser remains available and lists the local preview as soon as the
server is detected. Running the action again focuses an already healthy matching browser tab.
Scient cancels a pending automatic open if you switch tasks, close or leave the Browser surface,
open or close a Browser tab, or navigate the tab shown while it waits, so it does not take focus
back later.

Automatic preview is available in the Scient desktop app. Other clients still run the action but do
not open the embedded Browser. Actions that run automatically during worktree creation start on the
server and do not currently trigger this client-side Browser opening.
