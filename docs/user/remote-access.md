# Remote environments

Scient desktop can connect to an environment on another machine. The preferred
current workflow is desktop-managed SSH: Scient uses your local SSH
configuration, launches the matching Scient server archive on the remote host,
opens a loopback tunnel, and keeps the environment available in the app.

Remote access does not change where work runs. Provider CLIs, project files,
terminals, Git credentials, Zotero, MATLAB, and other local tools belong to the
remote environment when that environment is selected.

## Connect over SSH

The computer running Scient desktop needs an `ssh` client and a usable route to
the target. The remote host needs a Node.js version accepted by the matching
Scient server archive. Configure keys, an SSH agent, or a host entry in
`~/.ssh/config` before connecting when possible.

1. Open **Settings → Connections** and choose **Add environment**.
2. Choose **SSH**.
3. Select a suggested host discovered from SSH config and known hosts, or enter
   a host/alias, optional user, and optional port.
4. Review any host-key or password prompt and connect.

For a packaged release, Scient launches the immutable
`scient-server-<desktop-version>.tgz` archive from the matching
`ScientFactory/scient-desktop` GitHub release. It may use an internal
compatibility executable named `t3`, but it does not install `t3@latest` from
the npm registry. Development builds use their explicitly configured
development runtime and are not release evidence.

The desktop process owns SSH launch, authentication prompts, local port
forwarding, readiness checks, and cleanup. The renderer sees an ordinary
authenticated environment through the loopback tunnel. If Scient started the
remote server, disconnecting stops that launched process; a compatible server
that was already running is left running.

Saved SSH environments reconnect through the same target. If the SSH route,
credentials, Node runtime, or remote launch fails, Scient keeps the environment
disconnected and reports that failure instead of silently switching to another
machine.

## Direct and private-network access

Advanced deployments can run a separately managed Scient background server and
connect through a reachable direct endpoint. Tailscale can provide a private
network address, and Scient can manage a Tailscale Serve HTTPS endpoint when
that option is available in **Settings → Connections**.

Keep launch and access separate:

- the [background-service procedure](./background-service.md) decides how the
  server starts and updates;
- SSH, a direct endpoint, or Tailscale decides how a client reaches it; and
- a pairing credential decides what the client is authorized to do.

A local address such as `127.0.0.1` is reachable only on the server machine.
Plain HTTP or WebSocket endpoints also cannot be used by an HTTPS page when the
browser would block mixed content. Prefer SSH forwarding or a correctly secured
private HTTPS endpoint instead of exposing a server port to the public internet.

## Pairing and permissions

**Settings → Connections** can create a time-limited pairing link or code with
selected read/write scopes. Share it only with the intended client and revoke
unused links or sessions from the same page.

Long-lived bearer or DPoP credentials are sent in authenticated HTTP headers.
The WebSocket handshake uses a separate short-lived ticket rather than placing
the long-lived credential in the socket URL. Individual server operations still
enforce their own scopes after the connection succeeds.

Treat a pairing link like a temporary secret:

- do not paste it into an issue, chat transcript, shell history, or repository;
- select only the permissions the client needs;
- revoke it after an unexpected disclosure; and
- remove saved access from a device you no longer control.

## Version coordination

The environment descriptor reports the remote server version. When it differs
from the desktop client, Scient shows the applicable action in the composer and
**Settings → Connections**. Use that exact action; see
[Update Scient](./updating.md). Do not replace its immutable Scient release URL
with `npx t3@latest`.

## Current product boundary

Scient currently publishes the desktop app and server archive, not a Scient
mobile app or a Scient-hosted equivalent of `app.t3.codes`. T3 Connect, T3's
relay service, T3-hosted pairing URLs, and T3 mobile distribution are not
current Scient services. Their retained source foundations do not authorize
users to send Scient credentials or project access through T3 infrastructure.

If you need access from another computer today, use Scient desktop with SSH or
a separately secured direct/private-network deployment. Do not treat an
inherited T3 cloud URL as a Scient endpoint.
