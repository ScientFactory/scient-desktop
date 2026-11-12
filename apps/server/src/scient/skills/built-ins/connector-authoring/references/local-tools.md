# Local files, databases and command-line tools

Read this when a connector works with things on the user's computer: a folder of data, a
database file, or a program the user already has (a lab instrument's command-line tool, an
analysis script, `pandoc`, `samtools`).

## Settings, not hard-coded paths

- Ask for folders and files with `user_config` fields of type `directory` or `file`. Pass
  them in `env` (or `args`; they are not secrets). Give a `default` with `${HOME}`,
  `${DOCUMENTS}` or `${DOWNLOADS}` when there is an obvious one.
- A program the user has: a `file` setting for its path, or look it up on PATH (Scient gives the
  connector the user's login environment). If it isn't there, start anyway and have the tools
  say what to install or set.
- To work in the chat's project folder instead of the connector's own folder, set
  `_meta["com.scientfactory.scient"].workingDirectory` to `"project"`.

## Files

- Use `node:path` to build paths (`path.join`), never string joins. Windows uses `\` and
  drive letters.
- Resolve every path the agent passes against the allowed folder and refuse anything outside
  it (`path.relative(root, target)` must not start with `..` or be absolute).
- Read by default. A tool that writes or deletes files is a separate tool that says so.
- Return text, not whole files: the first lines, a summary, or a page with paging. Return
  paths the agent can open, not file contents, for large or binary files.

## Databases

- Open them read-only. With Node's built-in SQLite:
  `new DatabaseSync(file, { readOnly: true })` (from `node:sqlite`).
- When an app keeps the file open and locked (Zotero's `zotero.sqlite` while Zotero runs),
  read a fresh copy in a temporary folder and say the data is as of that copy. Prefer the
  app's own local API when there is one (Zotero: `http://localhost:23119/api/`).
- Always use bound parameters (`prepare("… where id = ?").all(id)`), never SQL built from
  the agent's text.
- `node:sqlite` works without flags from Node 22.13; Scient's own Node has it. A connector
  that must also run on older Node checks for it and says what is needed.
- Other databases (Postgres, MySQL) need a driver library; see "Libraries" in the template
  README. Their password is a key (`sensitive: true`).

## Command-line tools

- Start programs with `execFile` or `spawn` and an array of arguments, never a shell command
  string built from the agent's input.
- On Windows, `.cmd` and `.bat` programs (most npm tools) need a shell: call
  `cmd.exe /d /s /c` with the program and arguments, quoting each argument, or call the
  program's real `.exe`.
- Set a timeout and a cap on output (`maxBuffer`). Kill the process when the call is cancelled
  (pass the handler's `signal` to `spawn`).
- Read the program's exit code and stderr. A failure becomes a tool error with the last useful
  line of stderr and what to try.
- Prefer the program's machine-readable output (`--json`, `--format tsv`) to parsing text
  meant for people.
- Don't wrap a program that only needs one run; a script or Scient Compute fits that better.
