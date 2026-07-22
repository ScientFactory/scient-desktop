import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as ProcessRunner from "./processRunner";
import {
  cloneProjectSource,
  getRepositorySourceStatuses,
  normalizeRepositoryReference,
  resolveCloneDestination,
  validateGitRemoteUrl,
} from "./projectSources";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scient-project-source-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("project source validation", () => {
  it("normalizes provider repository names and URLs", () => {
    expect(
      normalizeRepositoryReference("github", "https://github.com/ScientFactory/scient.git"),
    ).toBe("ScientFactory/scient");
    expect(normalizeRepositoryReference("gitlab", "group/nested/project.git")).toBe(
      "group/nested/project",
    );
  });

  it("rejects mismatched providers and embedded credentials", () => {
    expect(() =>
      normalizeRepositoryReference("github", "https://gitlab.com/group/project"),
    ).toThrow("GitHub");
    expect(() => validateGitRemoteUrl("https://token@example.com/repo.git")).toThrow(
      "embedded credentials",
    );
    expect(() => normalizeRepositoryReference("github", "owner/..")).toThrow("owner/name");
  });

  it("accepts common Git transports and rejects local or relative paths", () => {
    expect(validateGitRemoteUrl("git@example.com:group/repo.git")).toBe(
      "git@example.com:group/repo.git",
    );
    expect(validateGitRemoteUrl("ssh://git@example.com/group/repo.git")).toBe(
      "ssh://git@example.com/group/repo.git",
    );
    expect(() => validateGitRemoteUrl("../repo")).toThrow("HTTPS, SSH, or Git");
    expect(() => validateGitRemoteUrl("file:///tmp/repo")).toThrow("HTTPS, SSH, or Git");
  });

  it("expands home paths and rejects relative or root destinations", () => {
    expect(resolveCloneDestination("~/projects/repo", "/Users/tester")).toBe(
      path.resolve("/Users/tester/projects/repo"),
    );
    expect(() => resolveCloneDestination("projects/repo", "/Users/tester")).toThrow(
      "absolute destination",
    );
    expect(() => resolveCloneDestination(path.parse(process.cwd()).root, os.homedir())).toThrow(
      "filesystem root",
    );
  });
});

describe("cloneProjectSource", () => {
  it("reserves the destination and clones inside it without a shell", async () => {
    const root = makeTempDir();
    const destinationPath = path.join(root, "repo");
    const runProcess = vi
      .spyOn(ProcessRunner, "runProcess")
      .mockImplementation(async (_command, _args, options) => {
        if (!options?.cwd) throw new Error("Expected clone working directory.");
        fs.writeFileSync(path.join(options.cwd, "README.md"), "cloned", "utf8");
        return { stdout: "", stderr: "", code: 0, signal: null, timedOut: false };
      });

    const result = await cloneProjectSource(
      {
        source: "github",
        repository: "ScientFactory/scient",
        destinationPath,
      },
      root,
    );

    expect(result.path).toBe(fs.realpathSync(destinationPath));
    expect(fs.readFileSync(path.join(destinationPath, "README.md"), "utf8")).toBe("cloned");
    expect(runProcess).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "ScientFactory/scient", "."],
      expect.objectContaining({ cwd: fs.realpathSync(destinationPath), timeoutMs: 600_000 }),
    );
  });

  it("removes only the newly reserved destination after clone failure", async () => {
    const root = makeTempDir();
    const destinationPath = path.join(root, "failed-repo");
    vi.spyOn(ProcessRunner, "runProcess").mockRejectedValue(new Error("private detail"));

    await expect(
      cloneProjectSource(
        { source: "git-url", remoteUrl: "https://example.com/repo.git", destinationPath },
        root,
      ),
    ).rejects.toThrow("Unable to clone the repository");
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });

  it("does not touch an existing destination", async () => {
    const root = makeTempDir();
    const destinationPath = path.join(root, "existing");
    fs.mkdirSync(destinationPath);
    fs.writeFileSync(path.join(destinationPath, "keep.txt"), "keep", "utf8");
    const runProcess = vi.spyOn(ProcessRunner, "runProcess");

    await expect(
      cloneProjectSource(
        { source: "git-url", remoteUrl: "https://example.com/repo.git", destinationPath },
        root,
      ),
    ).rejects.toThrow("already exists");
    expect(fs.readFileSync(path.join(destinationPath, "keep.txt"), "utf8")).toBe("keep");
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("does not create missing parent folders", async () => {
    const root = makeTempDir();
    const missingParent = path.join(root, "missing", "nested");
    const destinationPath = path.join(missingParent, "repo");
    const runProcess = vi.spyOn(ProcessRunner, "runProcess");

    await expect(
      cloneProjectSource(
        { source: "git-url", remoteUrl: "https://example.com/repo.git", destinationPath },
        root,
      ),
    ).rejects.toThrow("parent folder does not exist");
    expect(fs.existsSync(missingParent)).toBe(false);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("validates the source before reserving the destination", async () => {
    const root = makeTempDir();
    const destinationPath = path.join(root, "invalid-repository");
    const runProcess = vi.spyOn(ProcessRunner, "runProcess");

    await expect(
      cloneProjectSource(
        { source: "git-url", remoteUrl: "../local-repository", destinationPath },
        root,
      ),
    ).rejects.toThrow("HTTPS, SSH, or Git");
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("uses GitLab CLI without interpolating repository input into a shell command", async () => {
    const root = makeTempDir();
    const destinationPath = path.join(root, "project");
    const runProcess = vi.spyOn(ProcessRunner, "runProcess").mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });

    await cloneProjectSource(
      {
        source: "gitlab",
        repository: "research/nested/project",
        destinationPath,
      },
      root,
    );

    expect(runProcess).toHaveBeenCalledWith(
      "glab",
      ["repo", "clone", "research/nested/project", "."],
      expect.objectContaining({ cwd: fs.realpathSync(destinationPath), timeoutMs: 600_000 }),
    );
  });
});

describe("getRepositorySourceStatuses", () => {
  it("reports each provider independently when only one CLI is ready", async () => {
    const runProcess = vi.spyOn(ProcessRunner, "runProcess").mockImplementation(async (command) => {
      if (command === "glab") throw new Error("not installed");
      return { stdout: "", stderr: "", code: 0, signal: null, timedOut: false };
    });

    await expect(getRepositorySourceStatuses()).resolves.toEqual({
      sources: [
        { provider: "github", status: "available", message: "GitHub CLI is ready." },
        {
          provider: "gitlab",
          status: "setup-required",
          message: "Install GitLab CLI and sign in with `glab auth login`.",
        },
      ],
    });
    expect(runProcess).toHaveBeenCalledWith(
      "gh",
      ["auth", "status", "--hostname", "github.com"],
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(runProcess).toHaveBeenCalledWith(
      "glab",
      ["auth", "status"],
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });
});
