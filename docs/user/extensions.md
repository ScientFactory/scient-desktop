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
matching API-key account is saved in **Settings → Accounts & secrets**. Updating that
account's key updates the service too. Account access set to **Off**, or the global
**Agent access** switch, prevents its use.

### GitHub

GitHub uses the account Source Control already has, so one sign-in serves both.

- When Source Control has a GitHub account, Scient adds GitHub on its own, for all
  projects. Remove it to stop that: it is not added again until you add it yourself.
- **Add GitHub** offers **Connect as** that account. When Source Control has several
  GitHub accounts, pick one; Source Control's own choice comes first.
- Without one, **Sign in with GitHub** shows a code to copy and opens GitHub's
  device page in Scient's browser. Enter the code there and approve Scient for
  GitHub. Source Control uses the same sign-in.
- Scient for GitHub reaches only the accounts and organizations it is installed
  on. **Install on an organization** adds one.
- **Use a token instead** adds GitHub with a personal access token.

The connector stays with the account it was connected as. If Source Control no
longer has that account, GitHub shows **Account missing** until you sign in as
that account again; it never switches to another account. Scient sends this
credential only to GitHub's own MCP server.

Scient holds the sign-in or key. Every agent that Scient runs can use the
service through Scient, and agents never receive your credentials: they are
not written into agent configuration, environment variables, or transcripts.

## Add a local connector

A local connector is an MCP server that runs as a program on the computer
running this environment, for example a connector for your university's
course site or for files on your disk. Scient starts it and every agent can
use its tools, exactly like a connected service.

Choose **Add your own** at the top of **Extensions** (on Discover or Installed,
or **Not here? Add your own** under search results), then:

- Drop a file or folder on the dialog, or use **Choose…** (a `.mcpb` bundle, the
  format Claude Desktop uses for its extensions, a `.zip`, or a folder). You can
  also paste its path.
  Scient works out how to run it and asks only what the connector needs, in plain
  words. A Scient plugin folder is installed as a plugin, and a pasted `https://`
  address adds a connected service that runs online.
- Or open **From your other apps**: servers you already set up in Claude
  Desktop, Claude Code, Codex or Cursor on that computer, or in a project's
  `.mcp.json`. One click adds it for every agent. Servers that only run inside
  their own app, such as an app's built-in helpers, are not listed.
- **Run a command…** (for developers) takes a command such as `uvx my-mcp-server` and
  environment variables. Tick **Key** on a variable that holds a key.

Servers in **Browse all MCP servers** that are published as npm or PyPI packages
can be added with **+** too. They run through `npx` (Node.js) or `uvx` (uv), which
must be installed on that computer.

After adding, Scient starts the connector once and shows **Ready** with its tools,
what it still needs, or the program's own error.

### Keys and settings

- Keys are saved in **Settings → Accounts & secrets** as API keys and linked to the
  connector. You can choose a key you already saved instead of pasting one, and a
  key saved under the same variable name is linked on its own. Turning a key off in
  Accounts stops the connector from using it. Removing the connector keeps its keys.
- You can leave anything empty. The connector is added anyway and its row says
  **Needs setup**. When an agent uses it, the agent asks you in the chat: plain
  settings in a message, keys in a private card. Or open its page and choose **Edit
  setup**.
- Keys reach the program only through environment variables. A connector that would
  pass a key on the command line is refused, because other programs on the computer
  can read command lines.

### How it runs

- Each chat that uses it gets its own copy of the program, started on the first
  request and stopped after 30 minutes without use.
- It runs in its own folder. Scient keeps that folder in its data folder (a folder
  you chose is used where it is); **Show in folder** on its page opens it. Changes
  to the folder apply after **Restart**.
- Node.js bundles run on Scient's own Node.js, so nothing else is needed. Python
  bundles bring their packages with them; bundles of type `uv` need uv.
- If the program fails, its row shows **Stopped with an error** and its page shows
  the program's last error line. **Restart** stops every running copy; the next
  request starts a fresh one. Turning it off stops them too.

A local connector runs with your user account's permissions, like any program you
start yourself. Add only programs you trust.

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

## Your skills

A skill is guidance an agent follows for one kind of work: how your lab writes
methods, how to review a draft, how to run a protocol. Skills you add are yours:
they work in every project and with every agent.

**Add a skill.** Choose **Add your own** (on the **Skills** tab it also lists
skills you already have in Claude Code, Codex, Cursor or other agents, one click
each). Give it any of these:

- a skill folder, a `.zip` or `.skill` file, or a folder or archive with several
  skills;
- a `SKILL.md`, or a Markdown or text file;
- a web address, such as a GitHub repository or folder with skills;
- text you paste into the same box as a path or web address.

Scient adds a complete skill at once and fixes small things itself, such as a
missing name. When what you gave is not a complete skill yet, for example notes
or a document, choose **Finish with an agent**: a new chat opens with a first
message ready for you, with your material attached. Read it, add anything you
want, and send it. The agent writes the skill and saves it for you.

You can also ask any agent, in any chat, to make or improve a skill for you; it
saves it the same way.

**Use and change them.** A skill you add is on at once, from your next message.
Under **Your skills** on **Installed** (Skills), each skill can be turned off or
set to **$name only**. Its menu has **Improve with an agent**, **Show in
folder**, **Export as .zip** (to share with classmates), **Undo last change**
and **Remove**. When an agent changed a skill, **Undo** appears on its row.
Removing a skill can be undone from the notice that follows. If you edit a
skill's folder and it no longer loads, Scient lists it with what is wrong and
offers **Fix with an agent**.

## Scient plugins and agents' own items

**Scient plugins** on **Installed** lists the features built into Scient, such
as Sources and Documents, and any plugin bundles you
have installed. A built-in plugin's page describes what it adds and links to
its settings.

To install a plugin bundle, choose **Add your own** and pick the bundle's folder
on the computer running the environment, or paste its path. A bundle
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

**Gmail, Google Calendar and Google Drive** each appear once, in Discover and,
when any agent has them, in Installed → Connected services. Your agents reach
them through the ChatGPT or Claude account they use, so Scient never holds your
Google sign-in. **Connect** opens ChatGPT's page for the app in your browser;
one connection there serves both Codex and Scient Agent. If Claude still needs
it, Connect then opens claude.ai's connector settings. "Works with" shows which
agents have it and what the others still need.

**From Scient Agent** lists the ChatGPT apps you connected in ChatGPT, such as
Gmail, Google Drive or Google Calendar, when Scient Agent is signed in to
ChatGPT. Every Scient Agent conversation can use them through that sign-in.
**Add more on ChatGPT** opens ChatGPT's apps page; **Open in ChatGPT** on an
app opens its page there, to connect it again or remove it. Return to Scient
afterwards and the list updates.

**From Claude** can list claude.ai connectors without starting a conversation.
Choose **Connect on claude.ai**, then return after signing in. **Add more on
claude.ai** opens the account's connector settings. These connectors are
**Claude only**. Google's account apps remain available through Codex, Scient
Agent or Claude; Scient does not add Google's official MCP servers itself.

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

- Registry entries that run locally as anything other than an npm or PyPI
  package (for example a Docker image), need command-line arguments, or need
  extra configuration are listed with the reason and cannot be added yet.
- Double-clicking a `.mcpb` file does not open Scient yet; use **Add your own**.
- Each service can be connected once per environment. To use a different
  account, use **Reconnect** instead of adding it again.
- Scient plugin bundles cannot contain code, local servers, or interface
  panels; add local servers with **Add your own** instead.
- Signing in with Scient for GitHub does not let `git clone` reach private
  repositories; cloning still uses your git credential helper, such as
  `gh auth setup-git`.
