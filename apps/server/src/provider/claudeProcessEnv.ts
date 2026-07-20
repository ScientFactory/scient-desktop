// FILE: claudeProcessEnv.ts
// Purpose: Builds Claude subprocess environments for supported third-party authentication.
// Layer: Provider utility shared by Claude runtime sessions and provider health probes.
// Exports: Claude subprocess environment sanitization.

export function buildClaudeProcessEnv(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): NodeJS.ProcessEnv {
  const env = { ...(input?.env ?? process.env) };
  if (input?.homeDir) {
    env.HOME = input.homeDir;
  }
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  // Preserve Anthropic Console/API and supported cloud-provider credentials,
  // but never route Claude.ai subscription OAuth into Scient subprocesses.
  return env;
}
