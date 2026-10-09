# Remote environments

A remote environment lets Scient work inside a project on another computer.
This is useful when the data, licensed software, laboratory instruments,
compute resources, or organization-managed files live on a workstation or
server rather than the computer in front of you.

The important rule is that the work runs where the environment lives. When a
remote environment is selected, provider tools, project files, terminals, Git
credentials, and other software belong to the remote computer. The desktop app
displays and controls that work; it does not silently copy the whole project or
run those tools locally.

## Connect over SSH

Desktop-managed SSH is the simplest supported remote workflow. Scient uses your
existing SSH configuration, starts the matching Scient server on the remote
host, and carries the connection through a local encrypted tunnel.

The computer running Scient needs an `ssh` client and network access to the
target. The remote host needs a compatible Node.js version. Configure an SSH
key, SSH agent, or host entry in `~/.ssh/config` first when possible.

1. Open **Settings → Connections** and choose **Add environment**.
2. Choose **SSH**.
3. Select a suggested host, or enter its host name, optional user, and optional
   port.
4. Review any host-key or password prompt and connect.

Packaged desktop releases start the matching Scient server release on the
remote host. Saved SSH environments reconnect through the same target. If the
route, credentials, Node runtime, or remote launch fails, Scient keeps the
environment disconnected and reports the problem instead of switching to
another machine.

If Scient started the remote server for this SSH connection, disconnecting
stops that process. A compatible server that was already running is left
running.

## Direct and private-network access

Advanced deployments can run a separately managed
[background server](background-service.md) and connect through a reachable
endpoint. A private network such as Tailscale can make the server reachable
without exposing it directly to the public internet.

Keep these responsibilities separate:

- the background-service setup decides how the server starts and updates;
- SSH, a direct endpoint, or a private network decides how the client reaches
  it; and
- a pairing credential decides what that client is allowed to do.

Endpoint behavior follows the actual address:

- an HTTPS/WSS endpoint works from clients allowed to reach it;
- a non-loopback HTTP endpoint can be used for direct LAN pairing; and
- `127.0.0.1` is reachable only from the server computer.

Prefer SSH forwarding or a correctly secured private HTTPS endpoint. Do not
expose an unauthenticated Scient server port to the public internet.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, SSH, or T3 Connect. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list, or next to it in the T3 Connect list.
Pairing the same machine again over another address also adds a route instead
of a second machine. A new route is placed by speed, in that order, and you can
reorder routes at any time.

While connected through T3 Connect or a paired address, Scient also learns the
machine's current LAN and Tailscale addresses and adds them as routes, so
pairing once through T3 Connect is enough to use the LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned. You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the machine stops
reporting that address.

Scient connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, Scient checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works.

On web and desktop, select the route count under the machine's name in
**Settings → Connections** to see its routes. Drag a route to change the order,
or remove it. On mobile, open the machine under **Settings → Environments** and
choose **Edit**. Signing out of T3 Connect removes only that route; a machine
you can still reach another way stays saved.

Open **Permissions** next to **Routes** in web or desktop, or **Your permissions**
in the mobile route details, to see what your current connection can do on that
environment. For a remote environment, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked. Direct pairing and T3 Connect have separate sessions and may grant
different permissions.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

When the desktop app detects Tailscale, **Settings → Connections** can show its
Tailnet IP, MagicDNS name, and an HTTPS MagicDNS endpoint. Tailscale HTTPS is
off until you explicitly enable it. Turning it on asks Tailscale Serve to proxy
private HTTPS traffic to the local Scient backend; turning it off removes that
mapping.

This is an endpoint option, not a separate kind of Scient environment. LAN,
custom HTTPS, Tailscale, and SSH connections all use the same environment and
pairing model.

### Headless server

For a separately managed server, use the exact Scient release archive and
`SCIENT_SERVER_PACKAGE` variable described in [Background service setup](background-service.md).
The retained compatibility executable is `t3`; do not use T3's npm package.
For example, a Tailnet-only server can be started with:

```bash
npx --yes --allow-scripts=node-pty@1.1.0,msgpackr-extract@3.0.4 --package="$SCIENT_SERVER_PACKAGE" t3 serve --host "$(tailscale ip -4)"
```

Use the same package command with `t3 serve --help` for the complete options. To ask the server to manage
Tailscale Serve directly, use `--tailscale-serve`; advanced users can add
`--tailscale-serve-port 8443` for another HTTPS port. The command prints the
address and temporary pairing information needed by a client.

## Pair a client safely

In **Settings → Connections**, create a time-limited pairing link or code with
only the read and write permissions that client needs. Share it only with the
intended device, and revoke unused links or sessions from the same page.

Pairing codes and share links are available only in the client that created them,
while its Connections page remains open. After leaving or reloading that page,
create a new link to share. Other clients can see a link's name, scopes, and expiry,
and can revoke it if they have access-management permission.

The default endpoint controls the QR code and primary copy action. You can change
it in the expanded endpoint list. The preference follows the endpoint type rather
than a particular IP address.

Treat a pairing link like a temporary password:

- do not paste it into a public issue, repository, or shared transcript;
- choose the smallest useful permission set;
- revoke it after an unexpected disclosure; and
- remove saved access from a device you no longer control.

Connecting successfully does not give every operation unlimited access. The
server continues to enforce the selected scopes and the conversation's
permission mode.

## Antigravity sign-in on a remote environment

Antigravity runs and saves its Google credentials on the selected environment.
You can start setup from a remote Scient client without signing in over SSH.

Google returns to a `127.0.0.1` address on the device running the browser. If
that browser is on another computer, the final page may fail to load; this is
expected. Copy the complete return address, including its query string, and
paste it into the same Antigravity setup flow where sign-in started. Do not
change the address to the server hostname or paste it into a conversation or
bug report. See [Antigravity](./providers-antigravity.md) for the complete flow.

## Keep versions aligned

When the remote server version differs from the desktop client, Scient shows
the appropriate action in the composer and **Settings → Connections**. Use that
exact action or copied command; see [Update Scient](updating.md). Changing the
package or version can produce an incompatible server.

Scient does not currently provide a public hosted relay for remote projects.
Use desktop-managed SSH or a separately secured direct/private-network
deployment.

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that Scient launched; a server that was already
running is left alone.

## Use the desktop app only for remote environments

If this computer should only control work running elsewhere, turn off **Local
environment** in **Settings → Connections**. Scient restarts without a local
server: local providers and terminals stop, WSL backends stay off, and other
devices can no longer connect to this computer. Existing local projects, history,
and saved connections are kept.

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

The first tab downloads a headless Chrome, about 120 MB, into the Scient home. It
is the same browser [HTML renders](html-renders.md) use, so a host downloads it
only once. Some Linux hosts need [setup](#browser-host-setup) before it can
start.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

On a phone, tap the floating preview's corner dot to show its controls, then
**Pop into separate window** to keep watching in picture-in-picture over other
apps.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo t3 browser setup
```

The server shows the exact line for how you started it, such as
`sudo npx t3 browser setup`, and keeps your `PATH` when Node is installed only
for your user. Where `t3` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the app's own `t3` instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries with apt. It is safe to run again. Without `sudo`, it
only reports what it would change.

The browser always runs in Chrome's sandbox. Where you cannot change the host,
set `T3CODE_SERVER_BROWSER_SANDBOX=0` for the environment to run without it.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents Scient did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Manage or revoke access

Turn **Local environment** back on in the same place to restore the previous local
environment.

Removing a saved remote environment from **Settings → Connections** forgets it on
this device only. Scient hosts no relay, so there is no account-level
registration left behind to revoke.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
t3 pair --scope orchestration:read --scope relay:read
```

The selected scopes replace the default permissions. The same option works with
`t3 auth pairing create` and `t3 auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens retain
standard client permissions and issued bearer sessions retain administrative
permissions.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For mobile or a saved remote environment
in web or desktop, use **Add Environment** with the fresh link or code; pairing
the same environment replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows.

Settings changes, provider management, and environment maintenance can be granted
separately from access administration. New standard pairings include these
permissions. Existing clients can stay connected after an update, but newly separated
features may require pairing again with the permissions they need. Older clients
may show controls that the server denies. Create a fresh pairing link to change
a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

Treat pairing URLs and authorization codes as passwords. Do not include them in screenshots, logs, or bug reports.
