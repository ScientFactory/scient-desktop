# Scient Connect troubleshooting

When a connection fails, open **Settings → Environments**, find the computer, and select
**Details**. Then find the section below that matches the failure.

**Details** shows the four parts of a connection, in order:

1. **This device** reaches Scient Connect over the internet.
2. **Scient Connect** checks your sign-in and the computer's link.
3. **The computer's tunnel** (`cloudflared` on that computer) carries the request to it.
4. **Scient on that computer** answers.

To check the computer's side, open **Settings → Sharing & access** on that computer, or run
`scient connect status` there. Both check its Scient Connect address from that computer and explain
any failure. They cannot test another device's network: if only one device cannot connect, open
**Details** on that device.

## The computer's tunnel is offline

Scient Connect could not reach the computer's tunnel. One of these is true:

- The computer is asleep, turned off, or offline.
- Scient is not running on it. A computer is reachable only while the desktop app or `scient serve`
  runs.
- Its network blocks the tunnel. See
  [Port 7844 is blocked on the computer](#port-7844-is-blocked-on-the-computer).

Fix:

1. Make sure the computer is awake and Scient runs on it.
2. On that computer, run `scient connect status`. It names the problem on that side.
3. If the computer was offline for a long time, Scient Connect removed its tunnel. Start Scient
   there and update it; it gets a new tunnel at the same address.

## Port 7844 is blocked on the computer

The tunnel connects out to Cloudflare on port 7844, over TCP and UDP. When the computer's network
blocks that port, the tunnel cannot start, while ordinary web traffic still works, so the computer
looks online.

Common causes:

- **A Tailscale exit node on a network that blocks port 7844.** The tunnel's traffic goes through
  that network. Turn the exit node off with `tailscale set --exit-node=`, or allow outbound port 7844
  on its network.
- **A VPN.** Work VPNs often block unknown ports. Ask for port 7844 to be allowed, or use a direct
  route (below).
- **A firewall or strict network.** Allow outbound TCP and UDP port 7844.

If you cannot unblock the port, connect without Scient Connect: when both devices are on the same
Tailscale network, add the computer's Tailscale address as a direct route. See
[Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways).

## The tunnel works, but Scient does not answer

The tunnel is up but cannot reach Scient on the computer. Common causes:

- Scient on that computer stopped, crashed, or is still starting.
- Scient restarted on a different port, and the tunnel still points at the old one.
- A server started with `--host` listens only on one address. The tunnel sends requests to
  `127.0.0.1`, so the server must listen there too.

Fix: restart Scient on that computer, then run `scient connect status` there.

## The Scient Connect address does not resolve or answer

The computer's Scient Connect address did not resolve, refused the connection, failed the secure
(TLS) connection, or did not answer in time.

Fix:

1. Make sure the computer is awake and online.
2. On that computer, run `scient connect status`.
3. If the check fails only there, check that computer's DNS, VPN or proxy.

## This device can't reach Scient Connect

The problem is on this device's network, not on the computer. This device could not reach Scient
Connect, or it reached Scient Connect but not the computer's tunnel address.

Fix:

1. Check this device's internet connection. On a captive or dead Wi-Fi network the device can look
   online and still reach nothing.
2. A VPN, firewall, ad blocker or DNS filter on this device can block Scient Connect. Turn it off
   for a moment to test.
3. Try another network, or add a direct route to the computer, such as its Tailscale address. See
   [Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways).

## Sign-in, account, or link problems

This device's Scient Connect sign-in is not ready yet, or Scient Connect has no active link between
your account and the computer.

- **The computer is linked to a different account.** Sign in with the same account on both. On the
  computer, run `scient connect logout`, then `scient connect`.
- **Scient Connect is off on the computer.** There, open **Settings → Sharing & access** and turn on
  **Scient Connect**, or run `scient connect`.
- **The computer was linked, but its server did not apply the link yet.** Restart Scient there:
  quit and reopen the desktop app, or stop `scient serve` and run it again.
- **This device's sign-in expired, or the computer no longer accepts this device.** Sign out of
  Scient Connect and sign in again.
- **This device is still loading its sign-in.** Wait a moment; Scient retries on its own. If it
  keeps waiting, reload or restart Scient on this device.
- **Your account has reached its computer limit.** In **Settings → Sharing & access**, select
  **Manage tunnels**, then **Deregister** a computer you no longer use. Restart Scient on the
  computer you want to add.

## The clock is off

Turn on automatic date and time on both devices, then retry. Scient Connect's signed requests
expire quickly, so it rejects them when either clock is a few minutes wrong.

## The computer runs an older Scient

This device needs a newer Scient on the computer. [Update Scient](./updating.md) there.

## Scient Connect returned an error

| Error                                               | Fix                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or a tunnel limit | In **Manage tunnels**, **Deregister** a computer you no longer use, then restart Scient on the computer you want to add.                     |
| `auth_invalid` or `invalid_bearer`                  | Run `scient connect login`. If the sign-in was revoked, run `scient connect logout`, then `scient connect`. Restart Scient after signing in. |
| Expired or invalid link proof                       | Check the computer's date and time, update Scient, then restart it.                                                                          |
| HTTP 403 without a recognized error                 | Check proxies and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                                               |
| HTTP 408, 429 or 5xx                                | Wait a few minutes. Scient retries temporary failures on its own.                                                                            |

After you fix a permanent rejection, restart Scient on the computer.

## Report a problem

If none of this helps, open an issue on
[GitHub](https://github.com/ScientFactory/scient-desktop/issues). Include:

- The text from **Copy diagnostics** in the computer's **Details**.
- The output of `scient connect status` on the computer.
- The trace ID, if one is shown.
- If the tunnel dropped earlier, the computer's tunnel log, `relay-client.ndjson` in the logs
  folder (`~/.scient-next/userdata/logs` by default). It records when the tunnel connected, warned,
  exited and restarted, with the tunnel token removed.
