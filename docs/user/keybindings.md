# Keybindings

Keybindings let you open common Scient actions without leaving the keyboard.
Open **Settings → Keybindings** to see every command and the shortcut used by
the version you are running.

The settings page shows whether a shortcut is built in or customized and warns
when two active commands conflict. Change a shortcut there, remove a custom
shortcut, or reset it to the default. Use the command list in the app rather
than a copied list because available actions can change between versions.

## Composer controls

In **Settings → General → Send shortcut**, choose whether Enter sends, requires
`mod+Enter` for multiline prompts, or always requires `mod+Enter`. `Shift+Enter`
inserts a new line. This applies to the web and desktop composer at desktop widths.

**Follow-up behavior** chooses Queue or Steer while the agent runs. Use
`mod+Enter` to do the opposite for one message. When sending requires `mod+Enter`,
use `mod+Shift+Enter` for the opposite action. In a new thread, `mod+Enter` keeps
starting the thread in the background.

Use `mod+shift+m` to choose a model and `mod+shift+h` to choose a host.
Use `mod+shift+e` for effort, `mod+shift+a` for access mode, `mod+shift+x` for the
workspace, and `mod+shift+g` for the Git branch. The workspace menu includes the
current checkout, a new worktree, and the previous worktree when available.
Use `mod+shift+l` to reuse the previous worktree directly.

In the model picker, press Left in an empty search field or Shift+Tab to reach
the provider list. Use Up/Down to move and Enter to choose. Right returns to
model search. `mod+shift+up` and `mod+shift+down` switch providers directly and clear the
search. These provider shortcuts can also be changed in Settings.

These shortcuts run inside the focused web or desktop client. `mod` uses Command
on macOS and Ctrl on Windows and Linux, including GNOME, KDE Plasma, Niri, and
Hyprland. If a custom desktop shortcut takes the same keys, choose another binding
in Settings.

## Copy pull request references

With a PR open in the right panel or on the Pull Requests page, use `mod+shift+c`
to copy its URL and `mod+shift+k` to copy its number with a `#` prefix.
Both shortcuts can be changed in Settings. Search for “Copy Link or Thread ID”
or “Copy Number”. They copy the selected PR and leave terminal input alone.

## iPad

With a hardware keyboard, use `Cmd+1` through `Cmd+9` to open the first nine
displayed threads. The shortcuts follow the current list filters and order.
`Cmd+K` opens the command palette to search commands, projects, and threads.
Use the arrow keys and Return to choose a result, or `Cmd+1` through `Cmd+9` to
choose directly. Escape or `Cmd+K` closes the palette. Start a search with `>`
to show only actions.

In the composer, Return sends and `Shift+Return` inserts a new line. `Cmd+Return`
also sends. To make Return insert a new line instead, change the Return key
behavior in Settings → Keyboard.

Common searchable commands include opening the command palette, creating a
thread, toggling the terminal or right panel, finding a project file, searching
inside project files, refreshing a preview, and running a configured project
action. Project actions use command IDs such as `script.test.run`.

Useful current commands include:

- `filePicker.toggle` (`mod+p`) searches files in the active project;
- `projectSearch.toggle` (`mod+shift+f`) searches inside project files;
- `themeEditor.toggle` (`mod+alt+shift+t`) opens the floating theme editor;
- `thread.settle` (`mod+shift+s`) settles or restores the active thread;
- `thread.pin` (`mod+shift+p`) pins or unpins the active thread; and
- `rightPanel.toggleMaximized` maximizes or restores the open right panel and has no default shortcut.

Repeating either search shortcut closes it; opening the other replaces the current search. The theme
editor's **Inspect** mode selects one visible element and reveals its color token, then disarms. Use
**Cancel** or `Escape` to leave Inspect and clear its spotlight.

The command palette searches settings, active thread titles, projects, branches, user messages, and
final agent responses across connected environments. A setting result opens its exact control or
section. Message search begins after two characters and keeps the matching thread's project, branch,
and machine context visible.

## Edit the JSON directly

Use **Open keybindings.json** only when you want advanced control. It opens the
authoritative file for the selected environment. A remote environment therefore
has its own keybinding file; editing one environment does not silently change
another.

The file is a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  {
    "key": "mod+shift+g",
    "command": "terminal.new",
    "when": "terminalFocus"
  }
]
```

Each rule has:

- `key`: a shortcut such as `mod+j`, `ctrl+k`, or `cmd+shift+d`;
- `command`: the command ID to run; and
- optional `when`: a condition that limits where the shortcut is active.

`mod` means `Cmd` on macOS and `Ctrl` on Windows and Linux. Other accepted
modifier names include `cmd`, `meta`, `ctrl`, `control`, `shift`,
`alt`, and `option`.

Scient ignores an invalid rule. If the complete JSON file is invalid, it keeps
the app usable with the valid built-in configuration and reports the problem
in the server log.

## Commands

Commands are IDs like `terminal.toggle`, `commandPalette.toggle`, `preview.refresh`, and
`chat.new`. Project scripts are addressable as `script.{id}.run`, for example `script.test.run`.

`filePicker.toggle` opens file search for the active project and defaults to `mod+p`.
`projectSearch.toggle` searches inside the active project's files and defaults to `mod+shift+f`.
Repeating either shortcut closes that search, and switching shortcuts replaces the open search.
`themeEditor.toggle` opens or closes the floating theme editor and defaults to
`mod+alt+shift+t`. Select a color label to spotlight the elements that use it; select the label
again to clear the spotlight. The swatch and hex field keep that color selected while you edit it.
Advanced mode groups related app tokens into a smaller set of color families. Changing a family
updates its paired text and interaction states while leaving every unrelated imported color intact.
Use **Inspect** to pick an element in the app and reveal its color token. Inspect disarms after one
successful pick; its hover glow and badge preview the element and color family that click will select.
**Cancel** or `Escape` exits Inspect and clears its selection and spotlight.

`rightPanel.toggleMaximized` maximizes or restores the open right panel. It has no default shortcut,
so add one in **Settings** → **Keybindings** if you want to use it.

`rightPanel.close` closes the active right panel tab and defaults to `mod+w`. Press it again to close
the next tab. With the terminal focused, `mod+w` closes the terminal instead, and with nothing left
to close it closes the desktop window as before. Browsers reserve `mod+w` for closing their own tab
and never pass it to the page, so in a browser rebind this command (and `terminal.close`) to a
shortcut the browser leaves alone, such as `alt+w`.

`thread.copyReference` copies the active thread's pull request link, or its thread ID when no pull
request is available. Its default shortcut is `mod+shift+c`, and it does not replace terminal copy
while the terminal has focus.

`thread.settle` settles the active thread or restores it when it is already settled. Its default
shortcut is `mod+shift+s`, and it does not run while the terminal has focus.

`thread.pin` pins the active thread to the pinned section of the sidebar, or unpins it when it is
already pinned. Its default shortcut is `mod+shift+p`, and it does not run while the terminal has
focus. See [Organizing threads](./thread-sidebar.md) for how pinned threads are ordered.

The command palette searches settings, active thread titles, projects, branches, user messages, and
final agent responses across connected environments. A setting result opens its exact control or
section. Message matches show one labeled excerpt while keeping the thread's project, branch, and
machine context visible. Message search begins after two characters and uses SQLite's ASCII
case-insensitive matching.

The full command list and the current defaults are shown in **Settings** → **Keybindings**, which
always matches the build you are running. Use that rather than a copied list.

`thread.stop` interrupts the running turn in the focused thread. It has no default
shortcut; assign one in **Settings → Keybindings**.

`chat.new` may ask you to choose a project when there is more than one.
`chat.newLocal` skips that chooser. Both use your
[new-thread defaults](./thread-sidebar.md#start-a-thread).

Note that `chat.new` and `chat.newLocal` both create a thread through the same path. A new thread
inherits the project you were in, along with model and mode selections. Branch, worktree, and
environment mode always come from your configured defaults, not from the thread you were looking
at. To keep a worktree, use the explicit "new thread in this worktree" action in the branch
toolbar. The only difference between the two commands: with the current sidebar and more than one
project, `chat.new` opens a project chooser first.

Background submission from a new thread is the exception. `mod+enter` starts that thread and opens
another new thread with the same workspace mode and base branch. **New worktree** remains selected,
but the new thread does not reuse the worktree created for the thread that just started.

## `when` Conditions

A `when` expression is evaluated against context keys describing the current UI state. The keys
the app supplies today are `terminalFocus`, `terminalOpen`, `previewFocus`, `previewOpen`,
`modelPickerOpen`, `isWeb`, and `isDesktop`. `isWeb` is true in a browser tab and `isDesktop` is
true in the desktop app. The set is open and grows over time, so treat that as the current list
rather than a fixed one. Any key the running app does not supply evaluates to `false`.

`mod+1` through `mod+9` jump to the first nine threads, and to models while the model picker is
open. Those defaults use `isDesktop` so they do not steal the browser's tab-switch shortcuts.
Remove that condition in Settings if you want the same jumps in a browser.

Operators: `!` (not), `&&` (and), `||` (or), and parentheses.

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "!terminalFocus"`

Rules are evaluated in array order. For a key press, the last matching rule
whose condition is true wins, even when an earlier rule belongs to a different
command. Use the conflict warnings in **Settings → Keybindings** to check the
result after editing the JSON.
