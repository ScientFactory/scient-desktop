# Antigravity in Scient

Scient runs Google's official Antigravity ACP agent and connects it to the
account or credential method you select. The runtime, credentials, files, and
conversation state stay on the environment that runs your project. Scient
never asks for your Google password or silently substitutes another sign-in
method.

For behavior shared by assisted providers, see
[Providers in Scient](./providers.md).

## Assisted setup

Open **Settings > Providers**, select Antigravity, and choose **Manage**. The
model picker can open the same compact setup flow. On mobile, open
**Settings > Environments** and choose **Set up Antigravity** for the host
environment.

1. If Antigravity is missing, choose **Install Antigravity**. Scient downloads
   the qualified official runtime into private app storage, checks the archive
   and executable, and activates it only after validation succeeds.
2. Choose **Sign in with Google** or **Connect**, according to the configured
   authentication method.
3. Complete the provider-owned flow. Scient then checks the account and loads
   the models available to it.

Installation and sign-in continue if you leave the setup surface. Background
status checks never open a browser or start a sign-in flow.

### Sign in from another device

Google returns to a `127.0.0.1` URL on the device running the browser. When the
browser and provider environment are on different devices, that final page may
not load. Expand **Signing in on another computer?**, copy the complete URL
from the browser address bar, and paste it into Scient. Keep the query string
and do not replace the host with the server address.

The response must match the current sign-in attempt. Other connected clients
can see that setup is in progress. If the attempt expires, start a new one and
use its new URL.

### Authentication methods

The Antigravity provider settings select one of the methods exposed by the
official agent:

| Method                     | Configuration                        | Connection flow         |
| -------------------------- | ------------------------------------ | ----------------------- |
| Google account             | None                                 | Google sign-in page     |
| Gemini Enterprise          | GCP project and location             | Google sign-in page     |
| Gemini API key             | API key                              | **Connect**, no browser |
| Agent Platform (Vertex AI) | API key, or GCP project and location | **Connect**, no browser |

Gemini Enterprise resolves access for its configured project and location.
Agent Platform can use Application Default Credentials on the environment.
Configured keys are stored in that environment's provider settings and passed
only to Antigravity. Ambient `GEMINI_API_KEY` and `GOOGLE_*` values do not
silently change the selected method.

Changing the method stops that provider instance's sessions. Disconnect or
sign out before switching accounts.

## Runtime ownership and updates

Scient supports both app-managed and existing installations:

- With **Binary path** empty, Scient prefers its verified managed ACP runtime,
  then looks for the official ACP executable on the environment's `PATH`.
- An explicit ACP binary path takes priority. Its
  `localharness_external` helper must be beside it. Scient does not update or
  remove explicit or system installations.
- Existing legacy `agy` paths and conversations remain supported through the
  legacy transport. They are not reinterpreted as ACP sessions.

Managed ACP downloads are available on Apple Silicon macOS, x64 and ARM64
Linux, and x64 and ARM64 Windows. Google does not publish the ACP runtime for
Intel macOS; existing legacy `agy` installations remain usable there, or the
Mac can connect to a supported remote environment.

Scient's update catalog treats official ACP and legacy `agy` as separate
release families. When a newer ACP release has passed download, archive,
native-startup, activation, and removal qualification on its supported target,
**Update Antigravity** appears for managed ACP installations. An update keeps
the previous generation available while active sessions finish. It never
mutates a system or custom installation.

**Repair Antigravity** stages and validates a complete replacement before it
touches a damaged managed generation. A failed download or verification leaves
the existing copy and active pointer unchanged. Scient refuses to replace or
remove a runtime while it is in use.

## Models, files, and permissions

The official agent reports the models available to the selected account.
Scient keeps the thread's selected model when it resumes and asks for another
selection if that model disappears. Older model generations remain available
under **Legacy models** when the provider still offers them.

Use Antigravity's native `/plan` command to request a plan. Scient's separate
Plan mode control is unavailable when the protocol cannot support it.

Antigravity receives supported workspace files and message attachments through
the ACP protocol, including images, PDFs, text, and audio. Its file edits,
shell commands, and web actions use Scient's normal permission surfaces.
Provider questions with fixed choices remain interactive even in **Full
access**. See [Permission modes](./permission-modes.md).

Antigravity does not support conversation rewind. Reverting a thread or editing
and resubmitting an earlier turn is therefore unavailable; send a follow-up or
start a new thread instead.

## Accounts, disabling, and removal

Each official ACP provider instance has a private profile, so multiple
instances can use different accounts on one environment.

| Action                      | Result                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Disable Antigravity         | Stops that instance's sessions; keeps credentials, runtime, threads, and files.                                    |
| Sign out or disconnect      | Stops that instance's sessions and clears its official ACP profile credentials; keeps runtime, threads, and files. |
| Remove managed installation | Removes only Scient's shared ACP runtime; keeps account profiles, threads, files, and external installations.      |

Legacy `agy` credentials use the older provider-owned credential store and are
kept for legacy-session compatibility. Removing the ACP runtime does not erase
that external credential store.

Disconnect does not erase API keys saved in provider settings or Application
Default Credentials managed outside Scient. Remove those separately if you no
longer want that credential method available.

## Troubleshooting

- **Antigravity is missing:** install the managed runtime, use an official
  system installation, or set its absolute binary path.
- **Sign-in did not open:** retry from the explicit setup action. Passive
  refreshes intentionally do not launch a browser.
- **Remote sign-in stopped at localhost:** paste the full return URL through
  the collapsed remote-device control.
- **Credentials are incomplete:** return to provider configuration and supply
  the key, project, or location required by the selected method.
- **Connected but no models:** refresh provider status. Google controls account
  eligibility, models, subscriptions, and limits.
- **Managed runtime is damaged:** choose **Repair Antigravity**. If sessions are
  active, stop them first and retry.

The official ACP registry is available at
[agentclientprotocol/registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).
