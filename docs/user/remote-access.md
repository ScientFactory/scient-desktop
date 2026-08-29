# Remote environments

A remote environment lets Scient work inside a project on another computer.
This is useful when the data, licensed software, laboratory instruments,
compute resources, or organization-managed files live on a workstation or
server rather than the computer in front of you.

The important rule is that the work runs where the environment lives. When a
remote environment is selected, provider tools, project files, terminals, Git
credentials, Zotero, MATLAB, and other software belong to the remote computer.
The desktop app displays and controls that work; it does not silently copy the
whole project or run those tools locally.

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

An address such as `127.0.0.1` is reachable only from the server computer.
Prefer SSH forwarding or a correctly secured private HTTPS endpoint. Do not
expose an unauthenticated Scient server port to the public internet.

## Pair a client safely

In **Settings → Connections**, create a time-limited pairing link or code with
only the read and write permissions that client needs. Share it only with the
intended device, and revoke unused links or sessions from the same page.

Treat a pairing link like a temporary password:

- do not paste it into a public issue, repository, or shared transcript;
- choose the smallest useful permission set;
- revoke it after an unexpected disclosure; and
- remove saved access from a device you no longer control.

Connecting successfully does not give every operation unlimited access. The
server continues to enforce the selected scopes and the conversation's
permission mode.

## Keep versions aligned

When the remote server version differs from the desktop client, Scient shows
the appropriate action in the composer and **Settings → Connections**. Use that
exact action or copied command; see [Update Scient](updating.md). Changing the
package or version can produce an incompatible server.

Scient does not currently provide a public hosted relay for remote projects.
Use desktop-managed SSH or a separately secured direct/private-network
deployment.
