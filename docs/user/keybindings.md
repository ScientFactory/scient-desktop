# Keybindings

Keybindings let you open common Scient actions without leaving the keyboard.
Open **Settings → Keybindings** to see every command and the shortcut used by
the version you are running.

The settings page shows whether a shortcut is built in or customized and warns
when two active commands conflict. Change a shortcut there, remove a custom
shortcut, or reset it to the default. Use the command list in the app rather
than a copied list because available actions can change between versions.

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

The command palette searches active thread titles, projects, branches, user messages, and final agent
responses across connected environments. Message search begins after two characters and keeps the
matching thread's project, branch, and machine context visible.

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

## Conditional shortcuts

A `when` expression can use the current UI context. The keys supplied today include
`terminalFocus`, `terminalOpen`, `previewFocus`, `previewOpen`, and
`modelPickerOpen`. The set can grow over time; unknown keys evaluate to `false`.

Supported operators are `!` (not), `&&` (and), `||` (or), and
parentheses. For example:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "!terminalFocus"`

Rules are evaluated in array order. For a key press, the last matching rule
whose condition is true wins, even when an earlier rule belongs to a different
command. Use the conflict warnings in **Settings → Keybindings** to check the
result after editing the JSON.
