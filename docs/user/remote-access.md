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

1. Open **Settings → Environments** and choose **Add environment**.
2. Choose **SSH**.
3. Select a suggested host, or enter its host name, optional user, and optional
   port.
4. Review any host-key or password prompt and connect.

Packaged desktop releases install and start the matching Scient server release
on the remote host. Scient runs only that exact release, never a server command
already installed on the host or a package from npm. Saved SSH environments
reconnect through the same target. If the route, credentials, Node runtime, or
remote launch fails, Scient keeps the environment disconnected and reports the
problem instead of switching to another machine.

If Scient started the remote server for this SSH connection, disconnecting
stops that process. A compatible server that was already running is left
running.

### Where remote data lives

On the remote host, Scient keeps its server data in `~/.scient-next`, the same
folder Scient desktop uses on that computer. If the host also runs Scient
desktop, an SSH connection uses that computer's own Scient server. Scient never
connects to a server that uses the `~/.t3` folder, which other apps share.

Earlier Scient versions kept remote data in `~/.t3`. The first connection from
a newer version copies that data to `~/.scient-next` once, when
`~/.scient-next` does not exist yet and the data in `~/.t3` was written by
Scient. The copy holds threads, settings, attachments, and the server's
credentials. Worktrees, projects, and scratch folders stay where they are and
keep working from there; installed tools and runtimes download again when
needed. The data in `~/.t3` stays as it was so an older Scient version can
still use it, but the two folders do not share later changes. A `~/.t3` that
another app wrote, or that Scient cannot read, is never changed, and Scient
starts with an empty `~/.scient-next`.

The copy runs before the server starts, so that first connection can take
longer; the copy itself may run for up to 15 minutes. While it runs, a saved
connection reports that Scient is still preparing the host and keeps retrying;
it connects once the copy finishes, or shows the copy's error if it fails.
Before copying, Scient stops the
server it started on `~/.t3` for this connection, once it has confirmed that
process is that server. The connection fails without copying anything if
another older Scient server is still using `~/.t3`, if Scient cannot confirm
which process its old server is, or if `~/.t3/userdata` contains a symbolic
link, which the copy would share with the old folder. Disconnect older Scient
apps from the host or stop that server, then reconnect. To start fresh instead
of copying, create an empty `~/.scient-next` folder on the host before
connecting.

## Scient Connect

Scient Connect reaches your computers from anywhere without opening ports or
setting up a VPN. Sign in to Scient on a computer and Scient Connect turns on
for it: that computer appears in Scient on your other devices and at
[app.scientfactory.com](https://app.scientfactory.com) in any browser.

1. On the computer to share, open **Settings → Sharing & access** and sign in
   with Google, Microsoft, GitHub or email.
2. That's all. The first time, Scient downloads the tunnel program
   (`cloudflared`) in the background, checks it against a pinned checksum,
   installs it and connects. **Sharing & access** shows each step, and so does
   the invite dialog if you are waiting to share a thread. If the network is
   down or the relay is busy, Scient keeps trying.
3. On another device, sign in with the same account. The computer is listed
   under Scient Connect; select it to connect.

To keep a computer off Scient Connect, turn **Scient Connect** off in
**Sharing & access**. Scient remembers that for the computer, also after you
sign out and back in, until you turn it on again. Signing out leaves the
computer reachable for your account; turn Scient Connect off to stop that.
Signing in with another account moves the computer to that account.

On a server without a screen, run `scient connect` and open the printed link on
any device to sign in. `scient connect status` checks the connection from that
computer. When a connection fails, see
[Scient Connect troubleshooting](./scient-connect-troubleshooting.md).

How it works: Scient's relay at `relay.scientfactory.com` keeps your account's
list of computers and creates one private Cloudflare tunnel per computer, at an
address under `scientusercontent.com`. Your threads, files and terminals travel
directly between your device and that tunnel; the relay does not carry them.
Cloudflare decrypts tunnel traffic at its edge before passing it on, as with
any site behind Cloudflare. A computer that stays offline for a while loses its
tunnel and gets a new one, at the same address, when it comes back.

Each account can link a limited number of computers at once. **Settings →
Sharing & access** shows how many are in use, and says so when a new computer
doesn't fit. To free a place, select **Manage tunnels**, then **Deregister** a
computer you no longer use, and turn Scient Connect on again.

Scient Connect runs on macOS (Apple Silicon and Intel), Windows (x64, and ARM on
Windows 11, which runs the x64 tunnel program) and Linux (x64 and arm64). A
network that blocks GitHub downloads stops the first setup; **Sharing &
access** shows the reason.

A computer is reachable only while Scient runs on it: the desktop app, or
`scient serve` on a server (see [headless server](background-service.md)). This
is the same on macOS, Windows and Linux; Scient does not install a background
service.

### Approve new devices

By default, any device signed in to your Scient Connect account can open a linked
machine. To require approval instead, turn on **Require approval for new
devices** with the Scient Connect settings in **Settings → Sharing & access** on the
host, or when you first set up Scient Connect. Then someone who takes over your
Scient Connect account cannot reach the machine from a new device without your
approval. Review the devices that are already approved, described below.

A new device waits and shows a code such as `K7QM-2XFD`. Approve it from a
device that is already connected, using the prompt or **Settings → Sharing &
access**. Check that the code matches the one on the waiting device. On a
headless host, run `scient auth connect-device list` and then
`scient auth connect-device approve K7QM-2XFD`. A request expires after 10 minutes,
and the device asks again when it retries. Deny keeps that device out until its
request expires.

Each device is approved once. Revoke it from **Scient Connect devices** in the same
settings page, or with `scient auth connect-device revoke <code>`. With approval on,
it has to ask again. With approval off, it can connect again on its own, so
revoking in the app offers to turn approval on first. Devices that connected through
Scient Connect while approval was off stay approved and appear in that list for you to
review. A device that has not connected since you updated Scient asks for approval like
a new one. Older apps cannot show the code, so update them before you turn approval on.

### Share a thread with people

People without Scient can join a thread in their browser, talk with you there and,
if you allow it, with the agent. See [Invite people to a thread](./thread-rooms.md).

## Direct and private-network access

Advanced deployments can run a separately managed
[headless server](background-service.md) and connect through a reachable
endpoint. A private network such as Tailscale can make the server reachable
without exposing it directly to the public internet.

Keep these responsibilities separate:

- how you run the server decides how it starts and updates;
- SSH, a direct endpoint, or a private network decides how the client reaches
  it; and
- a pairing credential decides what that client is allowed to do.

Endpoint behavior follows the actual address:

- an HTTPS/WSS endpoint works from clients allowed to reach it;
- a non-loopback HTTP endpoint can be used for direct LAN pairing; and
- `127.0.0.1` is reachable only from the server computer.

For a server you start in a terminal, `scient serve --lan` accepts connections
from your local network and tailnet, but not from public addresses. A pairing
code is then all that keeps other devices on those networks out.

Prefer SSH forwarding or a correctly secured private HTTPS endpoint. Do not
expose an unauthenticated Scient server port to the public internet.

On a computer with the desktop app, you can open the printed `scient://pair`
app link instead. The desktop app asks you to confirm the server address, then
adds it.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, or SSH. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list.
A pairing link for a saved machine is refused when it comes from an address
that machine does not have yet; add that address with **Add route** instead.
Pairing again over an address the machine already has still works. A new route
is placed by speed, in that order, and you can reorder routes at any time.

While connected through a paired address, Scient also learns the machine's
current LAN and Tailscale addresses and adds them as routes, so pairing once
is enough to use the LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned: **Network access** in the desktop app, or
`scient serve --lan` for a server in a terminal.
You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the machine stops
reporting that address.

Scient connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, Scient checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works. A
route whose machine refused this device's sign-in is marked **Sign-in
refused**; pair that address again with **Add route** to use it.

On web and desktop, select the route count under the machine's name in
**Settings → Environments** to see its routes. Drag a route to change the order,
or remove it. On mobile, open the machine under **Settings → Environments** and
choose **Edit**.

Open **Permissions** next to **Routes** in web or desktop, or **Your permissions**
in the mobile route details, to see what your current connection can do on that
environment. For a remote environment, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked. Separately paired routes have separate sessions and may grant
different permissions.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Environments → Load balancing** to automatically choose a machine for
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

When the desktop app detects Tailscale, **Settings → Sharing & access** can show its
Tailnet IP, MagicDNS name, and an HTTPS MagicDNS endpoint. Tailscale HTTPS is
off until you explicitly enable it. Turning it on asks Tailscale Serve to proxy
private HTTPS traffic to the local Scient backend; turning it off removes that
mapping.

Your tailnet needs MagicDNS and HTTPS certificates enabled; see
[Tailscale's HTTPS setup](https://tailscale.com/docs/how-to/set-up-https-certificates).
On Linux, Scient also needs permission to manage Tailscale; see
[operator permission](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission)
for non-root users. If any of these is missing, Scient still starts but can't
add the HTTPS route.

This is an endpoint option, not a separate kind of Scient environment. LAN,
custom HTTPS, Tailscale, and SSH connections all use the same environment and
pairing model.

### Headless server

For a separately managed server, use the exact Scient release archive and
`SCIENT_SERVER_PACKAGE` variable described in
[Run a Scient server without the desktop app](background-service.md). Do not
substitute a package name for the release URL. For example, a Tailnet-only
server can be started with:

```bash
npx --yes --allow-scripts=node-pty@1.1.0,msgpackr-extract@3.0.4 --package="$SCIENT_SERVER_PACKAGE" scient serve --host "$(tailscale ip -4)"
```

Use the same package command with `scient serve --help` for the complete options. To ask the server to manage
Tailscale Serve directly, use `--tailscale-serve`; advanced users can add
`--tailscale-serve-port 8443` for another HTTPS port. The command prints the
address and temporary pairing information needed by a client.

## Pair a client safely

In **Settings → Sharing & access**, create a time-limited pairing link or code with
only the read and write permissions that client needs. Share it only with the
intended device, and revoke unused links or sessions from the same page.

Pairing codes and share links are available only in the client that created them,
while its Sharing & access page remains open. After leaving or reloading that page,
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

When the remote server version differs from the desktop client, Scient offers
the appropriate action from the sidebar's update controls and
in **Settings → Environments**. Use that
exact action or copied command; see [Update Scient](updating.md). Changing the
package or version can produce an incompatible server.

The hosted app at app.scientfactory.com follows the latest Scient release, so
keep computers you open there updated.

Scient cannot answer a second sign-in prompt such as a Duo code. On macOS and
Linux it can reuse a connection you signed in to in a terminal instead: turn on
connection sharing for the host in `~/.ssh/config`, run `ssh <alias>`, then
connect. When that connection closes, sign in again in a terminal and retry.

```sshconfig
Host <alias>
  ControlMaster auto
  ControlPath ~/.ssh/cm-%C
  ControlPersist 8h
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that Scient launched; a server that was already
running is left alone.

Each desktop app keeps one session on the host for its SSH connection and reuses
it when it reconnects. Revoke sessions you no longer use in **Settings →
Sharing & access** on the host, or on a headless host with `scient auth session list` and
`scient auth session revoke <id>`. A desktop that can still sign in over SSH pairs
again on its next connect.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-another-device).

## Use the desktop app only for remote environments

If this computer should only control work running elsewhere, turn off **Local
environment** in **Settings → Environments**. Scient restarts without a local
server: local providers and terminals stop, WSL backends stay off, and other
devices can no longer connect to this computer. Existing local projects, history,
and saved connections are kept.
If a [background service](./background-service.md) on this computer uses the same Scient home,
the app still treats it as this computer: **Open in** and file reveal for its projects run here,
whichever connection you reach it through.

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

A tab you open yourself in the desktop app for another environment loads on
your computer instead, so the element picker, screenshots, and annotations work
as they do locally. Its `localhost` addresses still reach servers on the host,
over the connection the app already has, whichever way you connected. If the
host cannot be reached, the tab shows a connection error; a `localhost`,
`127.0.0.1`, or `[::1]` address never opens a server on your own computer.
Other names that point at your computer, such as `/etc/hosts` entries, still
do. These tabs ignore your system proxy settings, so they can't reach a host
you connect to only through a proxy or over HTTPS with a privately issued
certificate. The web app keeps streaming.

The desktop app can also forward a port on the host to your computer, so any
app there, such as your own browser, `curl`, or a database client, reaches it
at `localhost`. Use the forward button on a server in the thread's **Servers**
list, or **Forwarded ports** in the command palette, where you can also type
any port number and stop forwards. A forward keeps the host's port number
unless that port is taken on your computer, in which case it uses a free one
and shows it. Forwards end when you stop them or quit the app. ⌘-click
(Ctrl-click on Windows and Linux) on a remote server forwards it and opens it
in your browser.

A forwarded port behaves like a server running on your computer: anything on
your computer can reach it, including web pages open in your browser, so a
forwarded service is exposed the same way a local dev server is. Forwards
listen only on your computer's loopback, never on your network. On Linux they
accept only apps running as your user; on macOS and Windows, other users signed
in to the same computer can reach them too.

On iPhone, iPad, and Android, a tab showing one of the host's `localhost` pages
has **Open on this device** in its menu. So does a long press on a `localhost`
link in a chat. It opens the page in the phone's own browser view, at the same
`localhost` address, so it scrolls and responds to touch natively. Like the
desktop app, it never opens a server on the phone itself. The streamed tab
stays where it was, and agents keep using it. Each host keeps its own cookies
and site data on the phone. On iPhone and iPad the page runs under a stand-in
address while the address bar shows `localhost`, so browser features that need
a secure page, such as the clipboard or service workers, aren't available there.

All of this rides the host's preview tunnel. Turn off **Settings → Sharing &
access → Preview tunnel** on the host to stop other devices from loading its
`localhost` pages themselves: port forwarding and **Open on this device** go
away, and open tunnels close. Tabs keep working by streaming from the host, so
anyone who can use the host's browser tabs can still view its `localhost` pages
there. An administrator can also turn it off with a
[managed policy](./managed-policy.md#other-capabilities).

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

### Local servers

The browser lists a local server once it has a **Preview URL**: set one on the
project action that starts the server. Scient checks that address and opens it
as written, including HTTPS addresses and specific paths. It does not send web
requests to other ports, even ones your terminals and agents opened, because a
process may use a non-web protocol. To open any other local server, enter its
URL in the browser.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo scient browser setup
```

The server shows the exact line for the installation that runs it, usually with
the full path of the desktop app's `scient` launcher or of the Node runtime and
server it runs from, so it works even where `scient` is not on your `PATH`. It
keeps your `PATH` when Node is installed only for your user. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries and system fonts with apt; pages that load without text
can mean the host has no fonts. It is safe to run again, and each run reloads
the AppArmor profile: run it again if the browser reports a blocked sandbox on a
host restored from an image or snapshot, where the profile can be on disk
without being loaded. Without `sudo`, it only reports what it would change.

The browser runs in Chrome's sandbox by default. Chrome cannot start that sandbox
as root. If your Scient server runs as root, run it as a nonroot user to keep
sandboxing enabled. `scient browser setup` does not fix this root restriction.

If you need to run as root, or cannot enable the sandbox on your host, set
`T3CODE_SERVER_BROWSER_SANDBOX=0` in the **Scient server's environment** and restart
the server. This disables Chrome's sandbox. For a manual launch:

```sh
T3CODE_SERVER_BROWSER_SANDBOX=0 npx --yes --allow-scripts=node-pty@1.1.0,msgpackr-extract@3.0.4 --package="$SCIENT_SERVER_PACKAGE" scient serve
```

If you run the server under your own systemd unit, add
`Environment=T3CODE_SERVER_BROWSER_SANDBOX=0` under `[Service]` in its configuration,
run `sudo systemctl daemon-reload`, then restart that unit. Setting the variable in an
agent's terminal does not change the environment of an already running Scient server.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents Scient did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Link another environment

Link two machines, such as your laptop and a VPS, and agents on one can work on
the other: launch, message, wait on and stop its threads, answer their
questions, and manage its queues, projects and scheduled tasks.

Linked environments is a beta. Turn it on for both machines in **Settings →
Labs**; on mobile, **Settings → Labs** lists each connected machine. On a
headless server, open its address in a browser and pair to reach its **Settings
→ Labs**, or add `"linkedEnvironmentsEnabled": true` to `settings.json` in its
`userdata` directory, such as `~/.t3/userdata/settings.json`; a running server
picks it up. While it is
off on either machine, agents start nothing over a link between them. A task
already running on the other machine still finishes, and if that machine has it
off, its result arrives once it is back on.

On the machine you will work from, open **Settings → Environments → Linked environments**,
choose **Link**, and pick the other machine or enter its address. The list
holds the machines this app knows. If this app has an address for that machine
and is connected to it with a session that manages access there, it makes the
pairing code itself; otherwise paste one from that machine's
**Settings → Sharing & access**. An address you type always needs a pasted code.
From a terminal, use
`scient environment link <address> --pairing-code <code> --access <mode>`.

To link many machines at once, choose **Link several…** (it appears once this
app has two other machines saved). Tick the machines, pick one access level for
all of them, and confirm once. A machine can be ticked when this app is
connected to it with a session that manages access there and has an address
another machine can reach; the list says why when it cannot. Each machine
reports its own result, and the ones that failed stay ticked so you can try
only those again. Machines already linked are left as they are.

For machines no app is connected to, put one `<address> <pairing-code>` per
line in a file (make each code with `scient pair` on that machine) and run
`scient environment link --from <file> --access <mode>`, or `--from -` to read
standard input. It prints a result per line, leaves machines already linked as
they are, and exits non-zero if any line failed, so the same file can be run
again with fresh codes for the failures.

You can also ask an agent to link a machine by name, such as "delegate this to
my vps". It shows a card in the thread where you pick the machine the same way
and the access, then approve. An address the agent gives that this app does
not know for one of your machines also needs a pasted code. Paste one only for
an address you trust: the code is sent there.

- The access you pick is the most agents from this machine may do there. An
  agent also never gets more there than its own mode here.
- Threads a link starts are marked **From** and this machine's name there.
- A full-access link works there like that machine's own agents. Below full
  access, the link's agents can change only threads it started, not that
  machine's own threads, projects or settings, and they skip its project setup
  scripts.
- The link shows up in that machine's **Settings → Sharing & access** like any
  outside agent, and can be revoked there. **Forget** on this machine also ends
  it there when that machine confirms it. If it can't, such as when it is
  offline or on an older Scient, Forget says so; revoke it in that machine's
  Sharing & access.
- A link stays valid while agents use it. One unused for 30 days expires, as
  does one to a machine on an older Scient after 30 days; link again with a
  new pairing code.

On web and desktop, **Settings → Environments** opens as a map of your machines:
this app, each environment with one line per route (the one in use is
highlighted), and the machines an environment links to. Select a machine to
manage it, or switch to **List** for the same controls as rows. To link from
the map, drag the plus on an environment onto another machine, or press it and
pick one. If this app is connected to both machines, knows an address the first
can reach the other at, and its session on the other one manages access there,
it needs no pairing code.

A machine this app is not connected to, shown only because another environment
links to it, can still be linked without a code when that link has full access:
drop the plus on it and the environment holding the link gets the pairing code
from it. Your session on that environment must manage access there and already
have the access you pick. The result
is a separate link with the access you pick, listed and revocable on the linked
machine like any other. Links still do not chain.

A link goes one way. To let the other machine's agents work back, tick **Also
link … back** when you create the link, or select a one-way link and use
**Link back…**. It is offered when this app is connected to both machines and
may manage access on each. Two machines linked to each other at the same access
are drawn as one line with an arrowhead at each end; they are still two links,
and each is forgotten on its own.

To link one environment to several machines at once, Shift-click the machines
(or Shift-drag a box around them, or press Space on a focused machine), then
drag the environment's plus onto any of them, or use **Link several…** above
the map. Dropping the plus on a stack offers the stack's machines. The dialog
ticks the machines it can link without a pairing code and says why for the
rest. When this app is connected to none of them, each needs a pairing code,
so the map says so and offers to link one at a time instead.

Large setups fold: machines known only through links that share the same
linking environments and access levels become one stack, and once this app
knows more than 12 environments, the ones that are not connected and have no
links fold by state. Select a stack to list and filter every machine in it.
Opening a stack on the map draws its first 24 below its card: the rest of the
map stays where it is and the map grows taller, so pan or press the fit button
to see all of it. **Find a machine** above the map searches by name, and Enter
goes to the first match. The **?** button above the map lists these gestures.

The map draws the links of the machines this app is connected to; a machine it
is not connected to may hold links the map cannot show. A link reaches one
machine and does not carry on through that machine's own links.

An agent can also hand a task to a linked machine with `delegate_task`: it runs
there as an ordinary thread, in the project with the same repository (or the
one `target.projectId` names), and this thread wakes with its result when it
ends, as for any delegated task. It keeps following the task across restarts.
If the other machine revokes the link, or the link is removed here, the task
fails with that reason.

### Read a linked machine's threads

You can read a thread on a linked machine without connecting this app to it. Open
a task that was delegated there from the thread's agents, or a thread link that
points there, and the thread opens read-only, streamed through the machine you
are connected to over its link. It follows the thread live. On web and desktop
it opens as a tab in the right panel, beside the thread you are in, or in the
main view with ⌘/Ctrl-click, like
[subagents and side chats](thread-sidebar.md#open-a-thread-beside-the-one-you-are-in).
On mobile it opens in the inspector on layouts that have one, where Maximize
fills the screen, and as its own screen elsewhere. It shows the same timeline as
any other thread on web and desktop, and a shorter read-only list on mobile.

- The view is marked **Read-only** with both machines' names. To reply, approve
  or stop the thread, choose **Connect to interact**. When the link has full
  access, this app pairs with that machine in one step and opens the thread
  there; you need permission to manage access on the machine you are connected
  to. Otherwise the add-environment form opens for that machine and asks for a
  pairing code you create on it.
- This app connects to that machine directly, so it must be able to reach one of
  the addresses the link uses. If it cannot, the view says so and stays
  read-only. The new connection appears in that machine's **Settings → Sharing &
  access**, named after this device and the machine it came through, and is
  revoked there like any other.
- Files, images and published visuals stay on that machine and do not load
  here. A command's output shows as of when you open its row.
- If this app is already connected to that machine, the thread opens there as
  usual instead.
- You need permission to read threads on the machine you are connected to, and
  Linked environments must be on there. Both machines need a version of Scient
  that has this view.

## Manage or revoke access

Turn **Local environment** back on in the same place to restore the previous local
environment.

Removing a saved remote environment from **Settings → Environments** forgets it on
this device only. A computer linked through Scient Connect stays on your
account until you turn Scient Connect off on it, or remove it from your account
in **Settings → Sharing & access**; that also deletes its tunnel.

When the app connects to more than one environment, choose one at the top of the
page. A desktop app with **Local environment** off can manage a background
service on the same machine this way.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
scient pair --scope orchestration:read --scope relay:read
```

The selected scopes replace the default permissions. The same option works with
`scient auth pairing create` and `scient auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens and issued
bearer sessions get the standard client permissions, including managing access.
Setting up or replacing a Scient Connect link requires the separate `relay:configure` permission.
A terminal or a full-access agent on the host can reach those as well, so a
client that should not manage access also needs to go without `terminal:operate`
and `orchestration:operate`.

A paired device stays signed in while you keep using it, until you revoke it in
**Settings → Sharing & access** on the host. One unused for 30 days, or paired
with a host older than this release, has to pair again.

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

Settings changes, provider management, environment maintenance, access
management, and Scient Connect preferences can each be granted separately. Setting
up or replacing a Scient Connect link requires the administrative
`relay:configure` permission. `relay:write` covers preferences and unlinking.
New pairings without `--scope` include the standard client permissions. Existing clients keep the
permissions they paired with and can stay connected after an update, but newly
separated features may require pairing again with the permissions they need.
Older clients may show controls that the server denies. Create a fresh pairing
link to change a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

Some permissions also give a client indirect access. With `terminal:operate`,
a client can run commands that read or change any files the server’s OS account
can access, even when the pairing link omits file permissions. With
`relay:configure`, a client can replace the trusted issuer of pairing
credentials. Grant these permissions only to clients you trust with those
capabilities.

Treat pairing URLs and authorization codes as passwords. Do not include them in screenshots, logs, or bug reports.
