# Run a Scient server in the background

This is an advanced deployment for a machine that should host a Scient
environment without keeping a terminal open. The ordinary local workflow uses
the server bundled with Scient desktop and does not need this setup.

Background services are supported for a user account on Linux and macOS.
Windows background-service installation is not currently supported.

## Requirements and package authority

Use the server archive from the exact
[ScientFactory/scient-desktop release](https://github.com/ScientFactory/scient-desktop/releases)
you want to run. Each release publishes
`scient-server-<version>.tgz` from the same source as its desktop artifacts.
The target machine also needs a Node.js version accepted by that archive.

Scient does not publish T3's npm package. Never substitute `t3@latest` for the
release URL below. In these commands, the final `t3` is the server archive's
retained compatibility executable name, not a request for a T3 package.

Set the exact Scient release once in the current shell, replacing the quoted
placeholder, then install:

```sh
SCIENT_SERVER_VERSION="<version>"
SCIENT_SERVER_PACKAGE="https://github.com/ScientFactory/scient-desktop/releases/download/v${SCIENT_SERVER_VERSION}/scient-server-${SCIENT_SERVER_VERSION}.tgz"

npx --yes \
  --allow-scripts=node-pty@1.1.0,msgpackr-extract@3.0.4 \
  --package="$SCIENT_SERVER_PACKAGE" \
  t3 service install
```

With those variables still set in the shell, use the same package and replace
only the final service action to inspect, repair, or remove the service:

```sh
# Show the installed service, selected runtime, and log path.
npx --yes --allow-scripts=node-pty@1.1.0,msgpackr-extract@3.0.4 --package="$SCIENT_SERVER_PACKAGE" t3 service status

# Install the exact runtime and current launcher, then restart the service.
npx --yes --allow-scripts=node-pty@1.1.0,msgpackr-extract@3.0.4 --package="$SCIENT_SERVER_PACKAGE" t3 service update

# Stop the service and remove it from automatic startup.
npx --yes --allow-scripts=node-pty@1.1.0,msgpackr-extract@3.0.4 --package="$SCIENT_SERVER_PACKAGE" t3 service uninstall
```

Let active agent work and terminal commands finish before an install, update,
or uninstall. If a remote update is already running, wait for its terminal
outcome before starting a local service operation.

## Reliability model

The service manager starts a small stable launcher. Exact Scient server
versions are installed in separate runtime directories. During a remote update,
the launcher:

1. installs and preflights the exact target archive;
2. stops the old child only after accepting the trial;
3. snapshots the SQLite database and side files;
4. starts the target and waits for its migrations and long-running services to
   become ready; and
5. commits the target or restores the previous runtime and database snapshot.

The installed service definition therefore does not point at an ephemeral
`npx` cache. A target that requires a newer launcher protocol is blocked before
it can alter the database; run the exact local `service update` command once to
upgrade that launcher.

## Platform behavior

### Linux

Scient uses a systemd user unit at
`~/.config/systemd/user/scient.service`. Installation enables user lingering
so the service can remain active without an interactive login.

### macOS

Scient uses the launch agent
`~/Library/LaunchAgents/com.scientfactory.scient.service.plist`. It starts when
the user logs in and stops when that login session ends. Installing over SSH
cannot immediately start the agent when no graphical user is logged in; the
command may report that final start failure even though the agent will start at
the next login.

macOS can attribute protected-folder permission prompts to the Node executable
recorded in the launch agent. If the server cannot access Desktop, Documents,
or Downloads, review that executable in **System Settings → Privacy &
Security**. Do not grant broader filesystem access unless the hosted projects
require it.

## Connection and removal boundaries

Installing a service does not publish it to the internet, create a Scient cloud
account, or authorize another client. Configure the intended SSH, direct, or
private-network access separately; see [Remote environments](./remote-access.md).

Revoking a client credential or disconnecting a remote environment does not
uninstall the service. Conversely, uninstalling the service does not delete its
project files or silently erase the server state directory.
