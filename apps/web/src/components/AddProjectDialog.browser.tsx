// FILE: AddProjectDialog.browser.tsx
// Purpose: Browser-level coverage for the project source chooser and clone journey.

import "../index.css";

import type { NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { readNativeApi } from "~/nativeApi";
import { AddProjectDialog } from "./AddProjectDialog";

function installNativeApi(overrides: {
  statuses: NativeApi["projects"]["repositorySourceStatuses"];
  cloneSource?: NativeApi["projects"]["cloneSource"];
  browse?: NativeApi["filesystem"]["browse"];
}) {
  const previousNativeApi = window.nativeApi;
  const baseApi = readNativeApi();
  if (!baseApi) throw new Error("Expected browser native API fixture.");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      ...baseApi,
      projects: {
        ...baseApi.projects,
        repositorySourceStatuses: overrides.statuses,
        cloneSource: overrides.cloneSource ?? baseApi.projects.cloneSource,
      },
      filesystem: {
        ...baseApi.filesystem,
        browse:
          overrides.browse ??
          vi.fn().mockResolvedValue({ parentPath: "/Users/tester", entries: [] }),
      },
      dialogs: {
        ...baseApi.dialogs,
        pickFolder: vi.fn().mockResolvedValue(null),
      },
    } satisfies NativeApi,
  });
  return () => {
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: previousNativeApi,
    });
  };
}

function renderDialog(onAddProjectPath = vi.fn().mockResolvedValue(undefined)) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AddProjectDialog
        open
        onOpenChange={() => undefined}
        onAddProjectPath={onAddProjectPath}
        homeDir="/Users/tester"
        defaultCloneDirectory="/Users/tester"
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("AddProjectDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the four intentionally supported sources and setup state", async () => {
    const restore = installNativeApi({
      statuses: vi.fn().mockResolvedValue({
        sources: [
          { provider: "github", status: "available", message: "GitHub CLI is ready." },
          {
            provider: "gitlab",
            status: "setup-required",
            message: "Install GitLab CLI and sign in with `glab auth login`.",
          },
        ],
      }),
    });
    renderDialog();

    await expect.element(page.getByText("Local folder", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Git URL", { exact: true })).toBeVisible();
    await expect.element(page.getByText("GitHub repository", { exact: true })).toBeVisible();
    await expect.element(page.getByText("GitLab repository", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Setup Required", { exact: true })).toBeVisible();
    await page.getByText("GitLab repository", { exact: true }).click();
    await expect
      .element(page.getByText("Install GitLab CLI and sign in with `glab auth login`."))
      .toBeVisible();
    await page.getByText("GitHub repository", { exact: true }).click();
    await expect.element(page.getByPlaceholder("owner/repository")).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect.element(page.getByText("Local folder", { exact: true })).toBeVisible();
    restore();
  });

  it("opens the in-app local folder browser", async () => {
    const browse = vi.fn().mockResolvedValue({
      parentPath: "/Users/tester",
      entries: [{ name: "Documents", fullPath: "/Users/tester/Documents" }],
    });
    const restore = installNativeApi({
      statuses: vi.fn().mockResolvedValue({ sources: [] }),
      browse,
    });
    renderDialog();

    await page.getByText("Local folder", { exact: true }).click();
    await expect.element(page.getByText("Directories", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Documents", { exact: true })).toBeVisible();
    expect(browse).toHaveBeenCalledWith({ partialPath: "/Users/tester/" });
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect.element(page.getByText("Sources", { exact: true })).toBeVisible();
    restore();
  });

  it("clones an available GitHub repository and passes the result to Scient initialization", async () => {
    const cloneSource = vi.fn().mockResolvedValue({ path: "/Users/tester/scient" });
    const onAddProjectPath = vi.fn().mockResolvedValue(undefined);
    const restore = installNativeApi({
      statuses: vi.fn().mockResolvedValue({
        sources: [
          { provider: "github", status: "available", message: "GitHub CLI is ready." },
          { provider: "gitlab", status: "available", message: "GitLab CLI is ready." },
        ],
      }),
      cloneSource,
      browse: vi.fn().mockResolvedValue({ parentPath: "/Users/tester", entries: [] }),
    });
    renderDialog(onAddProjectPath);

    await page.getByText("GitHub repository", { exact: true }).click();
    const repositoryInput = page.getByPlaceholder("owner/repository");
    await repositoryInput.fill("ScientFactory/scient");
    await page.getByRole("button", { name: /Continue/ }).click();
    await expect.element(page.getByText("Select where to clone", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Clone/ }).click();

    expect(cloneSource).toHaveBeenCalledWith({
      source: "github",
      repository: "ScientFactory/scient",
      destinationPath: "/Users/tester/scient",
    });
    expect(onAddProjectPath).toHaveBeenCalledWith("/Users/tester/scient");
    restore();
  });
});
