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
