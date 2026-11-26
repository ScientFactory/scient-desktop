/**
 * The server settings the user guide documents, by the part after `T3CODE_`. Each can also be set
 * as `SCIENT_<name>`, and that value wins: the server still reads the `T3CODE_` names. `HOST` and
 * `LAN` are left out: `scient up` and `scient service` write them to service.env as `T3CODE_`, and
 * a `SCIENT_` value there would override what those commands just set.
 */
const SCIENT_ENVIRONMENT_SETTINGS = [
  "ACP_REGISTRY_PROBE_TIMEOUT_MS",
  "ANTIGRAVITY_PROBE_TIMEOUT_MS",
  "BITBUCKET_ACCESS_TOKEN",
  "BITBUCKET_API_TOKEN",
  "BITBUCKET_EMAIL",
  "CLAUDE_PROBE_TIMEOUT_MS",
  "CODEX_PROBE_TIMEOUT_MS",
  "CONTEXT_HANDOFF_TOKEN_CAP",
  "CURSOR_PROBE_TIMEOUT_MS",
  "FEATURE_FLAGS",
  "FX_PROBE_TIMEOUT_MS",
  "GROK_PROBE_TIMEOUT_MS",
  "HOST_ID",
  "KIRO_PROBE_TIMEOUT_MS",
  "MCP_WEBHOOK_ALLOWED_HOSTS",
  "MUSE_PROBE_TIMEOUT_MS",
  "OPENCODE_PROBE_TIMEOUT_MS",
  "PI_PROBE_TIMEOUT_MS",
  "SERVER_BROWSER_SANDBOX",
  "TERMINAL_SHELL",
  "WORKFLOWS",
] as const;

/** Copies each `SCIENT_<name>` setting onto its `T3CODE_<name>`, before anything reads them. */
export function applyScientEnvironmentAliases(env: NodeJS.ProcessEnv): void {
  for (const name of SCIENT_ENVIRONMENT_SETTINGS) {
    const value = env[`SCIENT_${name}`];
    if (value !== undefined) env[`T3CODE_${name}`] = value;
  }
}
