// FILE: claudeProcessEnv.ts
// Purpose: Builds Claude subprocess environments that match the user's normal Claude CLI session.
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
  // Claude owns these credentials. Preserve every provider-supported auth source
  // so health probes, sign-in, and real turns observe the same terminal session.
  return env;
}
