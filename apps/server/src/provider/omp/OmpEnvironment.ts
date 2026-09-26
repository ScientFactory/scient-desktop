import { managedRuntimeSmokeEnvironment } from "@scientfactory/provider-runtime";

/**
 * Oh My Pi runs user code, shells out, opens browsers, and talks to model
 * providers. The managed-runtime smoke allowlist is deliberately minimal
 * (HOME/PATH/temp/locale) because it only has to run `binary --version`, so it
 * starves a real OMP session of proxies, corporate CAs, SSH agent access, XDG
 * directories, shell identity, and virtualenv/conda state.
 *
 * The allowlist below adds exactly those categories back. It never copies
 * arbitrary server variables, so unrelated Scient server secrets are still not
 * forwarded to a user-visible agent process. Anything a specific instance
 * needs beyond this list stays available through the provider instance
 * environment, which the user configures explicitly.
 */
const OMP_INHERITED_ENVIRONMENT = [
  // Shell and user identity: OMP runs shell commands through the user's shell.
  "SHELL",
  "USER",
  "LOGNAME",
  "TZ",
  // Terminal and editor behavior for spawned tools.
  "TERM",
  "COLORTERM",
  "EDITOR",
  "VISUAL",
  // XDG base directories (Linux, and macOS tools that honor them).
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  // SSH agent forwarding for repository and host access.
  "SSH_AUTH_SOCK",
  "SSH_CONNECTION",
  // Corporate and local proxies: model traffic and git both need these.
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  // Certificate authorities: enterprise TLS interception otherwise fails.
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  // Locale beyond LANG/LC_ALL.
  "LANGUAGE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  // Virtualenv, conda, pyenv, and Node toolchain state.
  "VIRTUAL_ENV",
  "VIRTUAL_ENV_PROMPT",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "CONDA_SHLVL",
  "CONDA_PROMPT_MODIFIER",
  "PYENV_ROOT",
  "PYENV_VERSION",
  "NVM_DIR",
  "NODE_OPTIONS",
  // Windows process and user-scoped runtime coordinates.
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_IDENTIFIER",
  "OS",
  "PROCESSOR_LEVEL",
  "PUBLIC",
  "SESSIONNAME",
] as const;

/**
 * Model-provider credentials an OMP session legitimately needs. This stays a
 * named list: a pattern such as `*_API_KEY` would forward unrelated server
 * credentials into a user-visible process.
 */
const OMP_PROVIDER_CREDENTIAL_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_ORGANIZATION_ID",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "PERPLEXITY_API_KEY",
  "CEREBRAS_API_KEY",
  "HUGGINGFACE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "NPS_API_KEY",
] as const;

const pick = (env: NodeJS.ProcessEnv, names: ReadonlyArray<string>): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {};
  for (const name of names) {
    // Windows environment names are case-insensitive, so resolve the real key.
    const key =
      env[name] !== undefined
        ? name
        : Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const value = key === undefined ? undefined : env[key];
    if (key !== undefined && value !== undefined) result[key] = value;
  }
  return result;
};

/** Environment for an OMP session or one-shot OMP RPC child process. */
export const ompSessionEnvironment = (
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({
  ...managedRuntimeSmokeEnvironment(baseEnv),
  ...pick(baseEnv, OMP_INHERITED_ENVIRONMENT),
  ...pick(baseEnv, OMP_PROVIDER_CREDENTIAL_ENVIRONMENT),
});

/**
 * Environment for `omp update` and release checks. It keeps the network and
 * certificate coordinates an update needs but never forwards model-provider
 * credentials to the updater.
 */
export const ompUpdaterEnvironment = (input: {
  readonly env: NodeJS.ProcessEnv;
  readonly extraKeys?: ReadonlyArray<string>;
}): NodeJS.ProcessEnv => ({
  ...managedRuntimeSmokeEnvironment(input.env),
  ...pick(input.env, OMP_INHERITED_ENVIRONMENT),
  ...pick(input.env, input.extraKeys ?? []),
});
