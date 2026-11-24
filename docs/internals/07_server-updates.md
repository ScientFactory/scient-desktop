# Server updates

## Launcher ownership and compatibility

A [stable launcher](../../apps/server/src/serviceLauncher.ts) owns the runtime selected by systemd,
launchd, or Task Scheduler and is the only runtime writer of durable service state. Server children
request updates over inherited IPC and never rewrite their service definition. Foreground CLI
processes do not self-update.

Remote updates replace only the server child, not the launcher, so every existing background service
lags behind after a launcher-protocol bump. Keep new server runtimes compatible with the previous
launcher protocol unless impossible, and validate protocol compatibility during preflight.

Installations use exact versions and stage/preflight before publishing an immutable runtime so
restarts never depend on npm cache eviction or a moving tag.

## Commit boundary and database rollback

1. Record the pending update durably (atomic rename + fsync) before stopping the old child.
2. Refuse the update if a database snapshot will not fit on disk. After the old child exits, snapshot
   SQLite (main, WAL, SHM) once per update so failed trial migrations are reversible without down
   migrations. Never overwrite that snapshot on retry. Files outside SQLite (such as attachments)
   are outside this rollback boundary.
3. Start the new runtime as a trial. It must finish migrations, acquire fallible dependencies, bind
   HTTP, and hold long-running roots at the activation gate before reporting `prepared`.
4. Only after the launcher commits the new version durably and replies `committed` may the child
   release activation gates and accept work. A failed or timed-out trial stops and restores the
   snapshot before booting the old version.

## Client acknowledgement

An accepted update RPC is only pending. Clients correlate the launcher's update ID with the
reconnected ready state to distinguish commit from rollback. Desktop updates use a two-phase handoff
(prepare token while connected, commit after receiving it) because installing stops the bundled
backend.

## Recovering interrupted threads

- On startup, retire effects tied to the lost process before admitting new work.
- Persist restart-continuation intent in the durable outbox and wait for activation before running
  it so slow providers never delay readiness or the launcher's commit boundary.
- Cap consecutive crash recoveries per unfinished turn so a crashing turn cannot loop forever.
- Never auto-continue a turn that is archived, settled, snoozed, user-stopped, or waiting on a
  blocking user action (approval, question, or secret).

## Scient release authority

Scient release authority is `ScientFactory/scient-desktop`. Every eligible target is the immutable
`scient-server-<version>.tgz` asset attached to the matching Scient release; neither the updater nor
the operator may substitute T3's npm package or release channel. The package and executable keep the
internal name `t3` for host compatibility.

A target that requires database snapshots is blocked while the installed launcher is too old.
Upgrade the launcher once with the matching Scient release asset (replace the placeholder first):

```sh
SCIENT_SERVER_VERSION="<matching-release-version>"
SCIENT_SERVER_PACKAGE="https://github.com/ScientFactory/scient-desktop/releases/download/v${SCIENT_SERVER_VERSION}/scient-server-${SCIENT_SERVER_VERSION}.tgz"
npx --yes --allow-scripts=node-pty@1.1.0,msgpackr-extract@3.0.4 --package="$SCIENT_SERVER_PACKAGE" t3 service update
```

The command stops the unit, selects the new launcher and exact runtime, then restarts the service.
Later releases, including ones with migrations, can use the remote trial path.
