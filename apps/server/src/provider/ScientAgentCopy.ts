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
  // Scient offers no T3 Connect tunnel.
  [
    "No `webhookUrl`: T3 Connect remote access is off.",
    "No `webhookUrl`: this environment has no public URL; the user must make one reachable, such as with Tailscale or their own HTTPS proxy.",
  ],
  [
    "Absent: no T3 Connect tunnel. The user must enable T3 Connect remote access.",
    "Absent: this environment has no public URL; the user must make one reachable, such as with Tailscale or their own HTTPS proxy.",
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
  // Scient chat renders chart and diagram fences inline.
  [
    "show any visual the user asks for here: pass its HTML to `html_preview`, then `html_render`.",
    "show any visual the user asks for here: a fenced `mermaid`, `vega-lite` or `plotly` block when one fits, otherwise pass its HTML to `html_preview`, then `html_render`.",
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
