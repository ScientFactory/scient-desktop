# OpenCode

Scient uses the OpenCode setup on the connected environment. With a remote environment, its
OpenCode login and configuration apply, not the setup on your desktop or phone.

Scient requires OpenCode 1.14.19 or newer. It checks the server version before it loads models or
starts work. If the check fails, update OpenCode or fix the server URL and password, then refresh
the provider status. Reconnecting the client also runs the check again.

## OpenCode 2

Scient supports OpenCode 2.0.18 and newer. It detects the version on its own, so
the same provider settings work for OpenCode 1.x and 2.x. OpenCode 1.x shows
**Limited support** in its provider settings.

OpenCode 2 is a separate package, `@opencode/cli`. To move from 1.x, install it
yourself, for example `npm install -g @opencode/cli`. Then refresh provider status.
Scient's update button updates whichever package you have installed. It never
switches a 1.x install to 2.x.

OpenCode 2 converts the shared OpenCode database to its own format the first time it
runs. Don't run OpenCode 1.x and 2.x side by side on the same machine. Threads you
started on 1.x continue on 2.x.

Plan mode uses OpenCode's `plan` agent.

## Server authentication

Without a server URL, Scient starts a local OpenCode server. The process inherits
`OPENCODE_SERVER_PASSWORD` from the environment. A password in the provider settings overrides
that environment value for both the local process and Scient.

With a server URL, Scient connects to that external server and uses only the password in the
provider settings. It does not send a local `OPENCODE_SERVER_PASSWORD` to an external server.
OpenCode uses this password for HTTP Basic authentication.

## Stop a turn

When you select **Stop**, Scient stops the main OpenCode session and all nested child sessions.
Scient waits for this cleanup before it marks the turn as stopped or sends the next prompt. It
does not stop unrelated OpenCode sessions.

Stop reports an error if OpenCode cannot list or stop a child session. When Scient closes an
OpenCode session, it also tries to stop the child sessions, but this teardown is best effort.

## Refresh the model list

Scient loads the model list when an enabled OpenCode provider starts and keeps the list in its
cache. Reconnecting a client or using a refresh control asks OpenCode for the list again. The
periodic provider health setting does not refresh OpenCode's catalog.

After changing an OpenCode login or configuration outside Scient, open **Settings > Providers**,
select the environment, and choose **Refresh provider status**. Changing the provider's
configuration in Scient also replaces that provider connection.

On mobile, open the thread settings and select **Refresh models**. The control stays disabled while
the refresh runs and shows an error if the refresh fails.

OpenCode reads credential changes on each model-list request. Native OpenCode configuration files
can stay cached while the local helper is running. The helper closes after 30 seconds with no
model-list or text-generation work. Refresh after that idle period to start a new helper and read
the file changes. Repeated refreshes or active helper work can extend this wait.

Scient does not own an external OpenCode server. Native configuration changes on that server can
require its own reload or restart before a refresh returns the new list.

If a refresh fails, Scient keeps the last known models, slash commands, and skills. Fix the
connection, then refresh again. A successful refresh can remove entries that OpenCode no longer
offers.

## Continue an existing thread

An existing thread keeps its selected model and options when that model is temporarily absent
from the catalog. The web picker shows an **Unavailable** row and keeps saved option values visible
until the model metadata returns. Scient does not switch the thread to the first model in the
list.

The stored selection does not guarantee that OpenCode can still run the model. If the provider
rejects it, select an available model before trying again.
