# Appearance and themes

On web and desktop, open **Settings → Appearance** to choose a theme and follow the system
appearance or stay in light or dark mode. To use different themes for light and dark mode, select
the corresponding preview within each theme. Appearance preferences are saved separately on each
device or browser.

On web and desktop, use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Use **Change appearance** in the command palette to choose System, Light, or Dark independently of
the theme. **Cmd+Option+Shift+A** on macOS or **Ctrl+Alt+Shift+A** on Windows/Linux cycles through
those modes. Customize these shortcuts under **Settings → Shortcuts**.

On mobile, open **Settings → Appearance**. Mobile has its own themes and text,
code, and terminal preferences. It does not follow environment themes or defaults.

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors. Like other themes, Material You
can be selected separately for light and dark appearances.
Android uses **Material You Layout** by default unless you have turned it off in Appearance.
It changes shapes, spacing, and controls independently
of the selected theme.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Composer context** to keep those controls visible after the thread starts. This preference
applies to the web and desktop clients.

## Math

Web and desktop retain Scient's scientific math renderer, including source-preserving copy
and bounded wrapping; see [Math in chat](./math-in-chat.md).

In the retained mobile client, **Render math** in **Settings → Appearance** is opt-in.
It recognizes `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, and fenced `math` blocks outside of code.
With rendering off or unavailable, readable TeX stays visible. The composer keeps TeX source
editable, and the preference is saved separately on each device. This retained capability
does not establish a supported Scient mobile release.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads does not replay those transitions.

## Custom themes

Choose **Create theme** to adjust a palette, or import a Scient, T3 Code, or VS Code theme.
The theme editor's color picker lets you select an area of the app to find the color to change.
Export your theme as JSON to share it.

### Custom CSS

For a change that colors cannot make, open **Custom CSS** in the theme editor. The CSS is saved with
the theme, applies after Scient's own styles on web and desktop, and is included in exports. Use
`.dark` or `:root:not(.dark)` to target one appearance.

Custom CSS cannot load files. `@import`, `image-set()`, and `url()` are ignored, except `url()`
with a `data:` address or an `#id`. This keeps an imported theme from sending what is on your screen
to another site.

Class names in the app change between releases. For rules that keep working, target `data-slot`
and other `data-` attributes, such as `[data-chat-header]` or `[data-slot="button"]`.

If a rule hides something you need, run `scient theme set t3-chat` on the server to switch to the
built-in Orchid theme, or press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to
pick another theme.

### Ask an agent

An agent on the same machine as the server can restyle Scient for you. Ask it to change the look,
for example "make Scient's chat header taller" or "give Scient a solarized theme". It publishes
an [environment theme](./environment-theme.md) with colors and CSS, and web and desktop clients of
that server switch to it. It can also switch them to light, dark, or system mode. The thread must
run in Full access. Ask the agent to set a built-in theme to undo it.

For themes published by your connected machine and server defaults, see
[Environment themes](./environment-theme.md).
