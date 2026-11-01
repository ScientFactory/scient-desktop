# Run a Scient server without the desktop app

This is an advanced deployment for a machine that should host a Scient
environment without the desktop app. The ordinary local workflow uses the
server bundled with Scient desktop and does not need this setup.

## No background service command

Current Scient builds do not include a `service` command, so they cannot
install, update, or remove a systemd unit or launch agent for you. Run the
server in a terminal session you keep open, such as one inside `tmux`, or under
a process manager you configure and maintain yourself. Servers started this way
cannot update themselves; see [Update Scient](./updating.md).

## Requirements and package authority

Use the server archive from the exact
[ScientFactory/scient-desktop release](https://github.com/ScientFactory/scient-desktop/releases)
you want to run. Each release publishes
`scient-server-<version>.tgz` from the same source as its desktop artifacts.
The target machine also needs a Node.js version accepted by that archive.

Scient publishes its server only as this release archive, not as an npm
package. Never substitute a package name for the release URL below.

Set the exact Scient release once in the current shell, replacing the quoted
placeholder, then start the server:

```sh
SCIENT_SERVER_VERSION="<version>"
SCIENT_SERVER_PACKAGE="https://github.com/ScientFactory/scient-desktop/releases/download/v${SCIENT_SERVER_VERSION}/scient-server-${SCIENT_SERVER_VERSION}.tgz"

npx --yes \
  --allow-scripts=node-pty@1.1.0,msgpackr-extract@3.0.4 \
  --package="$SCIENT_SERVER_PACKAGE" \
  scient serve
```

Use the same package command with `scient serve --help` for the complete
options. Archives from releases published before the `scient` command was added
provide the same server under its earlier executable name, `t3`, which current
archives keep so existing scripts continue to work.

To move to another release, stop the server, set `SCIENT_SERVER_VERSION` to the
new exact version, and start it again. Let active agent work and terminal
commands finish first.

## Connection and removal boundaries

Starting a server does not publish it to the internet, create a Scient cloud
account, or authorize another client. Configure the intended SSH, direct, or
private-network access separately; see [Remote environments](./remote-access.md).

Revoking a client credential or disconnecting a remote environment does not
stop the server. Stopping the server does not delete its project files or
silently erase the server state directory.

Keep diagnostic messages when reporting failures, but never share pairing
credentials or the secrets directory.

## Reclaim database space

Scient removes superseded internal history on its own while it runs; your
conversations are kept. A database created before this shrank automatically
still holds the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. **Settings → Maintenance** suggests the repair
when at least 1 GiB can be reclaimed and shows the exact command for that
environment. Copy and run that command on the machine that hosts the
environment; it names the installation and data directory that reported the
space.

The command runs `doctor`. It reports the database size and the space it can
reclaim, then asks which repairs to run; `--fix` runs the recommended ones
without a prompt, and `--dry-run` only reports. An installed background service
for the same data directory is stopped for the repair and started again
afterwards, also when the repair fails. Quit the desktop app or a server you
started by hand first: the repair refuses to touch a database that is in use.

The repair can take several minutes on a large database. It rebuilds the
database through a temporary copy, so it needs free space of about the
database's size twice over: once in the system temporary directory (`TMPDIR`
or `/tmp` on Linux and macOS) and once next to the database for its
write-ahead log.

If you upgraded from an older version, its original database (`state.sqlite`)
is kept next to the current one. Scient still reads it to bring in older
conversations, so `scient doctor` does not delete it.
