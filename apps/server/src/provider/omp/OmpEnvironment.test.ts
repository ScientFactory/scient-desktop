// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";

import { ompSessionEnvironment, ompUpdaterEnvironment } from "./OmpEnvironment.ts";

describe("Oh My Pi child environment", () => {
  it("restores proxy, certificate, XDG, shell, SSH, and virtualenv coordinates", () => {
    const environment = ompSessionEnvironment({
      HOME: "/home/u",
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.internal:3128",
      NO_PROXY: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      SSL_CERT_FILE: "/etc/ssl/corp.pem",
      XDG_CONFIG_HOME: "/home/u/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
      SHELL: "/bin/zsh",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      VIRTUAL_ENV: "/home/u/.venv",
      CONDA_PREFIX: "/opt/conda",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
    });

    expect(environment).toMatchObject({
      HOME: "/home/u",
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.internal:3128",
      NO_PROXY: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      SSL_CERT_FILE: "/etc/ssl/corp.pem",
      XDG_CONFIG_HOME: "/home/u/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
      SHELL: "/bin/zsh",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      VIRTUAL_ENV: "/home/u/.venv",
      CONDA_PREFIX: "/opt/conda",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
    });
  });

  it("forwards intended model-provider credentials", () => {
    expect(
      ompSessionEnvironment({
        ANTHROPIC_API_KEY: "anthropic-secret",
        OPENAI_API_KEY: "openai-secret",
        OPENROUTER_API_KEY: "openrouter-secret",
        GROQ_API_KEY: "groq-secret",
      }),
    ).toMatchObject({
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENAI_API_KEY: "openai-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      GROQ_API_KEY: "groq-secret",
    });
  });

  it("never forwards unrelated server secrets", () => {
    const environment = ompSessionEnvironment({
      HOME: "/home/u",
      SCIENT_SERVER_TOKEN: "server-secret",
      SCIENT_ADMIN_API_KEY: "admin-secret",
      GITHUB_TOKEN: "github-secret",
      NPM_TOKEN: "npm-secret",
      DATABASE_URL: "postgres://user:password@localhost/db",
      // An arbitrary secret-shaped name is still not on the allowlist.
      SOME_OTHER_SERVICE_API_KEY: "other-secret",
    });
    expect(environment).toEqual({ HOME: "/home/u" });
  });

  it("keeps the updater on host coordinates without provider credentials", () => {
    const environment = ompUpdaterEnvironment({
      env: {
        HOME: "/home/u",
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.internal:3128",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
        ANTHROPIC_API_KEY: "anthropic-secret",
        SCIENT_SERVER_TOKEN: "server-secret",
        PI_CODING_AGENT_DIR: "/home/u/.omp",
      },
      extraKeys: ["PI_CODING_AGENT_DIR"],
    });
    expect(environment).toMatchObject({
      HOME: "/home/u",
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.internal:3128",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      PI_CODING_AGENT_DIR: "/home/u/.omp",
    });
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.SCIENT_SERVER_TOKEN).toBeUndefined();
  });

  it("resolves Windows environment names case-insensitively", () => {
    expect(ompSessionEnvironment({ Path: "C:\\Windows", SystemRoot: "C:\\Windows" })).toMatchObject(
      {
        Path: "C:\\Windows",
        SystemRoot: "C:\\Windows",
      },
    );
  });
});
