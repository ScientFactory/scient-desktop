/**
 * The one place where upstream agent copy becomes Scient copy. Instructions and
 * MCP tool text stay upstream's exact words; this module renames them and
 * applies the few deliberate differences below. Compatibility identifiers
 * (`t3-thread://`, `T3_ACP_MCP_*`) pass through unchanged.
 */
export const SCIENT_PRODUCT_NAME = "Scient";

/**
 * Upstream sentences that are false for Scient, replaced verbatim. A rule that
 * no longer matches upstream text fails the agent-copy test.
 */
export const SCIENT_AGENT_COPY_DIFFERENCES: ReadonlyArray<readonly [string, string]> = [
  // Scient offers no T3 Connect tunnel; a webhook needs the environment's own public URL.
  [
    "only creation returns it, with T3 Connect and run permission.",
    "only creation returns it, given run permission and a public URL for this environment, such as through Tailscale or the user's own HTTPS proxy.",
  ],
  [
    "Creation may omit it without T3 Connect remote access or run permission.",
    "Creation may omit it without run permission or a public URL for this environment.",
  ],
  // A thread credential reaches only its own project's threads.
  [
    "Read any thread by id.",
    "Read a thread in this project, or one the user attached as context, by id.",
  ],
  ["Send a message to any thread.", "Send a message to a thread in this project."],
  [
    "List threads newest first, in one project or with `allProjects`.",
    "List threads newest first: inside a thread, only yours; outside one, in one project or with `allProjects`.",
  ],
  [
    "`projectId`: one project, else yours, else all outside a thread.",
    "`projectId`: inside a thread, only yours; outside a thread, one project, else all.",
  ],
  // API keys and tokens go into Scient Accounts; request_secret stays for codes used once.
  [
    "only the user can give: call `request_secret`, not a chat ask or a handoff.",
    "only the user can give: use its account from `scient_accounts_list`; if none, `scient_account_add` for a key or token, `request_secret` for a one-time code, not a chat ask or a handoff.",
  ],
  ["Asked how: call now.", "Asked how: ask now; API keys: `scient_account_add`."],
  // Scient chat renders chart and diagram fences inline.
  [
    "show any visual the user asks for here: pass an HTML file path or inline HTML to `html_preview`, then `html_render`.",
    "show any visual the user asks for here: a fenced `mermaid`, `vega-lite` or `plotly` block when one fits, otherwise pass an HTML file path or inline HTML to `html_preview`, then `html_render`.",
  ],
];

/** Rename upstream agent copy and apply Scient's deliberate differences. */
export function scientAgentCopy(text: string): string {
  let result = text;
  for (const [upstream, scient] of SCIENT_AGENT_COPY_DIFFERENCES)
    result = result.replaceAll(upstream, scient);
  return (
    result
      // Scient names upstream's thread reader `scient_thread_inspect`.
      .replaceAll(/\bt3_thread_read\b/g, "scient_thread_inspect")
      .replaceAll(/\bmcp__t3[-_]code__/g, "mcp__scient__")
      .replaceAll(/\bt3_(?=[a-z])/g, "scient_")
      .replaceAll(/\bt3-code\b/g, "scient")
      .replaceAll(/\bT3 Code\b/g, SCIENT_PRODUCT_NAME)
      // "T3 Connect" stays, so the agent-copy test catches it until a rule above covers it.
      .replaceAll(/(?<![\w./@-])T3(?!\w)(?! Connect\b)/g, SCIENT_PRODUCT_NAME)
  );
}

/** Rewrite every `description` and `title` string of a listed MCP tool, including its schemas. */
export function scientAgentToolCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scientAgentToolCopy) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === "string"
        ? key === "description" || key === "title"
          ? scientAgentCopy(entry)
          : entry
        : scientAgentToolCopy(entry),
    ]),
  ) as T;
}
