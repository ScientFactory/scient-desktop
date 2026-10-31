# Extensions

Extensions is where you see and manage everything that adds to what Scient and
its agents can do: services you connect, such as a literature database or an
issue tracker; Scient's own plugins; and the plugins and servers your agents
manage themselves.

Open **Settings → Extensions**. The picker at the top, **Tools on**, chooses
which Scient environment you are looking at. Each environment keeps its own
extensions.

- **Discover** lists services you can add. Curated sections such as Featured
  and Research come first, followed by the features built into Scient and
  the shared plugin shelf, the Codex store, and **Browse all MCP servers**, which lists the public MCP Registry. Select a
  section title to see the whole category. Search covers the catalog, the
  registry, and what you have already installed.
- **Installed** lists what this environment already has, grouped by who manages
  it.

Select any row to open its page.

## Add a connected service

A connected service is a remote MCP server: a service that offers tools to AI
agents over the internet.

1. In **Discover**, choose **+** on a service's row, or **Add** on its page.
2. If the service asks you to sign in, Scient opens its sign-in page in your
   browser. Complete it there, then return to Scient.

To add a service that is not listed, open **Installed** and choose **Add by
URL** beside **Connected services**. Enter the server's URL and, optionally, a
name. Under **Authentication**, keep **Sign in if the server asks**, or choose
**API key** when the service gives you a key instead of a sign-in page. With
sign-in, **Advanced** lets you use an OAuth client that you registered with the
service yourself.

With **API key**, choose **Use an existing account** in the key picker when a
matching API-key account is saved in **Settings → Accounts**. Updating that
account's key updates the service too. Account access set to **Off**, or the global
**Agent access** switch, prevents its use.

Scient holds the sign-in or key. Every agent that Scient runs can use the
service through Scient, and agents never receive your credentials: they are
not written into agent configuration, environment variables, or transcripts.

## Manage a connected service

A service's page has three cards.

**Connection** shows whether the service is ready, needs sign-in, or is missing
its key. **Sign in** or **Reconnect** appears when signing in is possible; use
**Reconnect** to switch accounts or after the service revoked access. The
**⋯** menu offers **Test**, which checks that the service answers.

- **Use with agents** turns the service on or off for every agent.
- **Available in** chooses **All projects** or **Selected projects**. With
  selected projects, turn each project on or off in the list below.

Turning a service off, or narrowing where it is available, applies to an
agent's next call. A service you add or turn on reaches an agent when its next
session starts.

**Tools** lists what the service offers. Choose **See tools** to ask the
service; Scient groups the answer into tools that change things, tools that
only read, and others. The list is cleared when the service's sign-in changes.

**About** shows where the service came from, its website, its URL, the name
agents see, and **Works with**. Use **Remove** at the top of the page to delete
the service and its stored sign-in or key. A key from Accounts stays in Accounts.

## Works with

The line on each row says who can use it: **Works with all your agents**,
**Works with Claude and Scient Agent**, **Codex only**, or **Claude only**.
Hover over it or select it to see the agents and any limits. Account apps use
their owning agent's account. A standalone server configured in Claude stays
with Claude.

On **Installed**, the **Works with** filter shows only what a chosen agent can
use.

## Scient plugins and agents' own items

**Scient plugins** on **Installed** lists the features built into Scient, such
as Sources and Documents, and any plugin bundles you
have installed. A built-in plugin's page describes what it adds and links to
its settings.

To install a plugin bundle, choose **Install from folder** and enter the path
of the bundle's folder on the computer running the environment. A bundle
contains only skills and connected-service definitions; nothing in it runs as a
program. Its skills appear in **Settings → Skills**, turned off until you turn
them on, and its services appear under **Connected services**, waiting for you
to sign in. A bundle's page has an On/Off switch and **Uninstall**.

Sections named **From Codex**, **From Claude**, and so on show plugins and MCP
servers that each agent manages in its own configuration. Scient lists them so
you can see everything in one place, but the agent remains in charge. Project-scoped
items include all known projects in the selected environment, even projects you have
not opened recently. The list reports when inventory is still being checked or could
not be fully read.
**Uninstall** and **Sign in** appear only where that agent allows Scient to do
them. A section shows six items at first; use **Show all** in its header to see
the rest.

## Plugins for Claude and Scient Agent

Discover lists plugins from Claude Code's locally available stores and stores
configured in Scient Agent. Select the heading to search and browse the full
list. A plugin's page shows its contents when available and the store's review
state, such as **Reviewed by Anthropic** or **Reviewed by a partner**.

Choose **Install in Claude Code** when Claude is available. Scient uses Claude
Code's own installer; if the store was configured only in Scient Agent,
Scient asks Claude Code to add that store first. With no Claude instance,
choose **Install in Scient Agent**. **Add Claude Code's store** adds the official
store to Scient Agent only when you choose it.

Shared plugins can include hooks, local MCP servers, and extension modules,
as well as skills and commands. They follow the installing agent's own
lifecycle. Follow that agent's reload or restart instructions when new parts
do not appear in an existing session.

Scient Agent 0.1.3 or newer uses your Claude Code plugins automatically. It
reads that server's `CLAUDE_CONFIG_DIR` or default Claude home; it does not
combine separate Claude profiles. Plugins you turn off in Claude Code stay off,
and Scient Agent's own disabled-source settings still apply.

## Codex apps and Claude connectors

**From the Codex store** needs a Codex instance signed in with ChatGPT.
Discover shows featured and installed apps; search finds others, and the
heading opens the full searchable store. Apps that duplicate Scient's curated
services appear through the wider Scient version in Discover.

On an app's page, choose **Install in Codex**, then **Connect <app>** when
sign-in is required. Complete sign-in on ChatGPT and return to Scient. The
connection status updates after Codex confirms it. Some apps **connect the
first time Codex uses them**. Plan and administrator restrictions appear beside
a disabled action.

**From Claude** can list claude.ai connectors without starting a conversation.
Choose **Connect on claude.ai**, then return after signing in. **Add more on
claude.ai** opens the account's connector settings. These connectors are
**Claude only**. Google's account apps remain available through Codex or
Claude; Scient does not add Google's official MCP servers itself.

## See what a conversation received

When a conversation's agent has received connected services, a small plug
indicator appears in the thread header with the number delivered. Select it to
see which services the current agent session received and which were skipped,
with the reason, such as **Needs sign-in**, **Off for this project**, or **Not
supported by this agent**. **Manage connected services** opens the Installed
page.

## Remote environments

When **Tools on** names a remote environment, services are added to and used
from that environment. Signing in still happens in the browser on your
computer, and the sign-in page returns to that environment when you finish.

## Current limits

- Only remote servers can be added. Registry entries that run locally on your
  computer (stdio servers), need extra configuration, or use an unsupported
  connection type are listed with the reason and cannot be added yet.
- Each service can be connected once per environment. To use a different
  account, use **Reconnect** instead of adding it again.
- Plugin bundles cannot contain code, local servers, or interface panels.
