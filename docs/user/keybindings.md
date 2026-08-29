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

A `when` expression can use the current UI context, including
`terminalFocus`, `terminalOpen`, `previewFocus`, `previewOpen`, and
`modelPickerOpen`. Unknown keys evaluate to `false`.

Supported operators are `!` (not), `&&` (and), `||` (or), and
parentheses. For example:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "!terminalFocus"`

Rules are evaluated in array order. For a key press, the last matching rule
whose condition is true wins, even when an earlier rule belongs to a different
command. Use the conflict warnings in **Settings → Keybindings** to check the
result after editing the JSON.
