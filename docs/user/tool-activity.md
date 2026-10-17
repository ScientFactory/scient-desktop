# Tool activity

Open a tool-group summary in the conversation to see its individual calls. Each row has an icon;
select a row to inspect its details. Select the group summary again to collapse it.

Long groups scroll inside a bounded area without expanding the whole conversation. Faded edges
indicate more calls above or below. Short groups use only the space they need.
Collapsing and reopening a group preserves your reading position and any open call details.

Recognized Scient tools use descriptive labels in both the running summary and individual rows.
The latest live activity stays in the present tense while the turn continues, such as
"Running vp" or "Clicking in the preview browser", even after that call has completed.
Expanded rows follow the call's own state, such as "Clicked" after success.
When a call has not reported a state yet, the label stays in the present tense.
Failed, declined, and stopped calls say what happened without implying success.
Failed calls keep their tool icon with a muted red tint, so a failed command still
looks like a command. App logos and other multicolor icons keep their artwork and
show a small muted red failure mark beside the row. Expand the call to inspect its
output. Runtime errors and warnings keep their stronger styling.
Preview browser actions use a pointer-in-a-square icon. Web searches and commands that fetch
from the web, such as `curl` or `wget`, use a globe. Commands and tools that list files use a
folder, image views an image icon, approvals a shield, and Scient skills a stack of layers.
Other Scient tools keep the Scient mark.
Group summaries count browser actions separately, such as "Used browser 18 times" or
"Ran 4 commands and used browser 15 times". Browser-only groups use the browser icon too.

File paths in rows show their last two parts, such as `Layers/ProviderCommandReactor.ts`.
Hover over a shortened path to see the full path.

When a turn finishes, its final answer stays in view, and so do earlier messages that read as
real answers: ones with a heading, a list, a table, code, display math or an image, or that are
at least 400 characters long. Short progress notes and the tool activity fold behind
"Worked for…"; select it to see them again.

Command summaries show the program inside a shell wrapper, such as "Running vp" for
`/bin/zsh -lc 'vp test run'`. Expanded rows keep the full command.
