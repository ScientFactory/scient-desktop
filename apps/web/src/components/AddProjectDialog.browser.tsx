// FILE: AddProjectDialog.browser.tsx
// Purpose: Browser-level coverage for the project source chooser and clone journey.

import "../index.css";

import type { NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { readNativeApi } from "~/nativeApi";
import { AddProjectDialog } from "./AddProjectDialog";

function installNativeApi(overrides: {
  statuses: NativeApi["projects"]["repositorySourceStatuses"];
  cloneSource?: NativeApi["projects"]["cloneSource"];
  browse?: NativeApi["filesystem"]["browse"];
  createDirectory?: NativeApi["filesystem"]["createDirectory"];
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
        createDirectory:
          overrides.createDirectory ?? vi.fn(async ({ path }: { path: string }) => ({ path })),
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

function renderDialog(
  onAddProjectPath = vi.fn().mockResolvedValue(true),
  options: { homeDir?: string; defaultCloneDirectory?: string } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AddProjectDialog
        open
        onOpenChange={() => undefined}
        onAddProjectPath={onAddProjectPath}
        homeDir={options.homeDir ?? "/Users/tester"}
        defaultCloneDirectory={options.defaultCloneDirectory ?? "/Users/tester"}
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

  it("browses through a whitespace-ended folder and selects its child", async () => {
    const browse = vi.fn(async ({ partialPath }: { partialPath: string }) => {
      if (partialPath === "/Users/tester/") {
        return {
          parentPath: "/Users/tester",
          entries: [
            { name: "Research ", fullPath: "/Users/tester/Research " },
            { name: "Sibling", fullPath: "/Users/tester/Sibling" },
          ],
        };
      }
      if (partialPath === "/Users/tester/Research /") {
        return {
          parentPath: "/Users/tester/Research ",
          entries: [{ name: "notes", fullPath: "/Users/tester/Research /notes" }],
        };
      }
      if (partialPath === "/Users/tester/Research /notes/") {
        return {
          parentPath: "/Users/tester/Research /notes",
          entries: [],
        };
      }
      throw new Error(`Unexpected browse path: ${partialPath}`);
    });
    const onAddProjectPath = vi.fn().mockResolvedValue(true);
    const restore = installNativeApi({
      statuses: vi.fn().mockResolvedValue({ sources: [] }),
      browse,
    });
    renderDialog(onAddProjectPath);

    await page.getByText("Local folder", { exact: true }).click();
    await page.getByText("Research", { exact: true }).click();
    await expect.element(page.getByText("notes", { exact: true })).toBeVisible();
    expect(browse).toHaveBeenCalledWith({ partialPath: "/Users/tester/Research /" });

    await page.getByText("notes", { exact: true }).click();
    await expect
      .element(page.getByPlaceholder("Type or browse a folder path"))
      .toHaveValue("/Users/tester/Research /notes/");
    await vi.waitFor(() =>
      expect(browse).toHaveBeenCalledWith({ partialPath: "/Users/tester/Research /notes/" }),
    );
    await page.getByRole("button", { name: "Open Enter", exact: true }).click();

    expect(onAddProjectPath).toHaveBeenCalledWith("/Users/tester/Research /notes", {
      createIfMissing: false,
    });
    restore();
  });

  it.each([
    {
      platform: "MacIntel",
      homeDir: "/Users/tester",
      rootQuery: "/Users/tester/",
      parentPath: "/Users/tester/Parent",
      parentQuery: "/Users/tester/Parent/",
      childPath: "/Users/tester/Parent/Child",
    },
    {
      platform: "Linux x86_64",
      homeDir: "/home/tester",
      rootQuery: "/home/tester/",
      parentPath: "/home/tester/Parent",
      parentQuery: "/home/tester/Parent/",
      childPath: "/home/tester/Parent/Child",
    },
    {
      platform: "Win32",
      homeDir: "C:\\Users\\tester",
      rootQuery: "C:\\Users\\tester\\",
      parentPath: "C:\\Users\\tester\\Parent",
      parentQuery: "C:\\Users\\tester\\Parent\\",
      childPath: "C:\\Users\\tester\\Parent\\Child",
    },
  ])(
    "opens the current non-leaf folder with Enter on $platform",
    async ({ platform, homeDir, rootQuery, parentPath, parentQuery, childPath }) => {
      vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
      const browse = vi.fn(async ({ partialPath }: { partialPath: string }) => {
        if (partialPath === rootQuery) {
          return {
            parentPath: homeDir,
            entries: [{ name: "Parent", fullPath: parentPath }],
          };
        }
        if (partialPath === parentQuery) {
          return {
            parentPath,
            entries: [{ name: "Child", fullPath: childPath }],
          };
        }
        throw new Error(`Unexpected browse path: ${partialPath}`);
      });
      const onAddProjectPath = vi.fn().mockResolvedValue(false);
      const restore = installNativeApi({
        statuses: vi.fn().mockResolvedValue({ sources: [] }),
        browse,
      });
      renderDialog(onAddProjectPath, { homeDir, defaultCloneDirectory: homeDir });

      await page.getByText("Local folder", { exact: true }).click();
      await page.getByText("Parent", { exact: true }).click();
      const pathInput = page.getByPlaceholder("Type or browse a folder path");
      await expect.element(pathInput).toHaveValue(parentQuery);
      await expect.element(page.getByText("Child", { exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Open Enter", exact: true }))
        .toBeVisible();

      await userEvent.keyboard("{Enter}");

      await vi.waitFor(() =>
        expect(onAddProjectPath).toHaveBeenCalledWith(parentPath, { createIfMissing: false }),
      );
      expect(onAddProjectPath).toHaveBeenCalledTimes(1);
      await expect.element(pathInput).toHaveValue(parentQuery);
      restore();
    },
  );

  it("uses ArrowRight to browse highlighted folders and parent entries", async () => {
    const browse = vi.fn(async ({ partialPath }: { partialPath: string }) => {
      if (partialPath === "/Users/tester/") {
        return {
          parentPath: "/Users/tester",
          entries: [{ name: "Parent", fullPath: "/Users/tester/Parent" }],
        };
      }
      if (partialPath === "/Users/tester/Parent/") {
        return {
          parentPath: "/Users/tester/Parent",
          entries: [{ name: "Child", fullPath: "/Users/tester/Parent/Child" }],
        };
      }
      throw new Error(`Unexpected browse path: ${partialPath}`);
    });
    const onAddProjectPath = vi.fn().mockResolvedValue(false);
    const restore = installNativeApi({
      statuses: vi.fn().mockResolvedValue({ sources: [] }),
      browse,
    });
    renderDialog(onAddProjectPath);

    await page.getByText("Local folder", { exact: true }).click();
    const pathInput = page.getByPlaceholder("Type or browse a folder path");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowRight}");
    await expect.element(pathInput).toHaveValue("/Users/tester/Parent/");

    await userEvent.keyboard("{ArrowDown}{ArrowRight}");
    await expect.element(pathInput).toHaveValue("/Users/tester/");
    expect(onAddProjectPath).not.toHaveBeenCalled();
    restore();
  });

  it("steps the back arrow through parent folders before returning to sources", async () => {
    const browse = vi.fn(async ({ partialPath }: { partialPath: string }) => {
      if (partialPath === "/Users/tester/") {
        return {
          parentPath: "/Users/tester",
          entries: [{ name: "Parent", fullPath: "/Users/tester/Parent" }],
        };
      }
      if (partialPath === "/Users/tester/Parent/") {
        return {
          parentPath: "/Users/tester/Parent",
          entries: [{ name: "Child", fullPath: "/Users/tester/Parent/Child" }],
        };
      }
      throw new Error(`Unexpected browse path: ${partialPath}`);
    });
    const restore = installNativeApi({
      statuses: vi.fn().mockResolvedValue({ sources: [] }),
      browse,
    });
    renderDialog();

    await page.getByText("Local folder", { exact: true }).click();
    await page.getByText("Parent", { exact: true }).click();
    const pathInput = page.getByPlaceholder("Type or browse a folder path");
    await expect.element(pathInput).toHaveValue("/Users/tester/Parent/");

    await page.getByRole("button", { name: "Parent folder", exact: true }).click();
    await expect.element(pathInput).toHaveValue("/Users/tester/");
    await expect.element(page.getByText("Parent", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect.element(page.getByText("Git URL", { exact: true })).toBeVisible();
    restore();
  });

  it("offers a neutral new-folder action and creates a collision-safe child", async () => {
    const browse = vi.fn().mockResolvedValue({
      parentPath: "/Users/tester",
      entries: [
        { name: "New folder", fullPath: "/Users/tester/New folder" },
        { name: "New folder 2", fullPath: "/Users/tester/New folder 2" },
      ],
    });
    const onAddProjectPath = vi.fn().mockResolvedValue(false);
    const createDirectory = vi.fn(async ({ path }: { path: string }) => ({ path }));
    const restore = installNativeApi({
      statuses: vi.fn().mockResolvedValue({ sources: [] }),
      browse,
      createDirectory,
    });
    renderDialog(onAddProjectPath);

    await page.getByText("Local folder", { exact: true }).click();
    await page.getByRole("button", { name: "New folder", exact: true }).click();

    const pathInput = page.getByPlaceholder("Type or browse a folder path");
    await expect.element(pathInput).toHaveValue("/Users/tester/New folder 3");
    await vi.waitFor(() => {
      const input = document.activeElement as HTMLInputElement | null;
      expect(input?.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)).toBe(
        "New folder 3",
      );
    });
    await expect
      .element(page.getByRole("button", { name: "Create & Open Enter", exact: true }))
      .toBeVisible();

    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(createDirectory).toHaveBeenCalledWith({
        path: "/Users/tester/New folder 3",
      }),
    );
    await vi.waitFor(() =>
      expect(onAddProjectPath).toHaveBeenCalledWith("/Users/tester/New folder 3", {
        createIfMissing: true,
      }),
    );
    expect(onAddProjectPath).toHaveBeenCalledTimes(1);
    restore();
  });

  it("clones an available GitHub repository and passes the result to Scient initialization", async () => {
    const cloneSource = vi.fn().mockResolvedValue({ path: "/Users/tester/scient" });
    const onAddProjectPath = vi.fn().mockResolvedValue(true);
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

  it("ignores a clone completion after the dialog is dismissed and reopened", async () => {
    let resolveClone!: (value: { path: string }) => void;
    const cloneSource = vi.fn(
      () =>
        new Promise<{ path: string }>((resolve) => {
          resolveClone = resolve;
        }),
    );
    const onAddProjectPath = vi.fn().mockResolvedValue(true);
    const onOpenChange = vi.fn();
    const restore = installNativeApi({
      statuses: vi.fn().mockResolvedValue({
        sources: [{ provider: "github", status: "available", message: "GitHub CLI is ready." }],
      }),
      cloneSource,
      browse: vi.fn().mockResolvedValue({ parentPath: "/Users/tester", entries: [] }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const dialog = (open: boolean) => (
      <QueryClientProvider client={queryClient}>
        <AddProjectDialog
          open={open}
          onOpenChange={onOpenChange}
          onAddProjectPath={onAddProjectPath}
          homeDir="/Users/tester"
          defaultCloneDirectory="/Users/tester"
        />
      </QueryClientProvider>
    );
    const screen = await render(dialog(true));

    try {
      await page.getByText("GitHub repository", { exact: true }).click();
      await page.getByPlaceholder("owner/repository").fill("ScientFactory/scient");
      await page.getByRole("button", { name: /Continue/ }).click();
      await page.getByRole("button", { name: /Clone/ }).click();
      expect(cloneSource).toHaveBeenCalledTimes(1);

      await screen.rerender(dialog(false));
      await screen.rerender(dialog(true));
      await expect.element(page.getByText("Sources", { exact: true })).toBeVisible();

      resolveClone({ path: "/Users/tester/scient" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onAddProjectPath).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
      await expect.element(page.getByText("Sources", { exact: true })).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restore();
    }
  });

  it("ignores a clone completion after navigating back from its destination", async () => {
    let resolveClone!: (value: { path: string }) => void;
    const cloneSource = vi.fn(
      () =>
        new Promise<{ path: string }>((resolve) => {
          resolveClone = resolve;
        }),
    );
    const onAddProjectPath = vi.fn().mockResolvedValue(true);
    const onOpenChange = vi.fn();
    const restore = installNativeApi({
      statuses: vi.fn().mockResolvedValue({
        sources: [{ provider: "github", status: "available", message: "GitHub CLI is ready." }],
      }),
      cloneSource,
      browse: vi.fn().mockResolvedValue({ parentPath: "/Users/tester", entries: [] }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <AddProjectDialog
          open
          onOpenChange={onOpenChange}
          onAddProjectPath={onAddProjectPath}
          homeDir="/Users/tester"
          defaultCloneDirectory="/Users/tester"
        />
      </QueryClientProvider>,
    );

    try {
      await page.getByText("GitHub repository", { exact: true }).click();
      await page.getByPlaceholder("owner/repository").fill("ScientFactory/scient");
      await page.getByRole("button", { name: /Continue/ }).click();
      await page.getByRole("button", { name: /Clone/ }).click();
      expect(cloneSource).toHaveBeenCalledTimes(1);

      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect.element(page.getByPlaceholder("owner/repository")).toBeVisible();

      resolveClone({ path: "/Users/tester/scient" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onAddProjectPath).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
      await expect.element(page.getByPlaceholder("owner/repository")).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restore();
    }
  });

  it("ignores project initialization completion after the dialog is dismissed and reopened", async () => {
    let resolveAdd!: (shouldClose: boolean) => void;
    const onAddProjectPath = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    const restore = installNativeApi({
      statuses: vi.fn().mockResolvedValue({
        sources: [{ provider: "github", status: "available", message: "GitHub CLI is ready." }],
      }),
      cloneSource: vi.fn().mockResolvedValue({ path: "/Users/tester/scient" }),
      browse: vi.fn().mockResolvedValue({ parentPath: "/Users/tester", entries: [] }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const dialog = (open: boolean) => (
      <QueryClientProvider client={queryClient}>
        <AddProjectDialog
          open={open}
          onOpenChange={onOpenChange}
          onAddProjectPath={onAddProjectPath}
          homeDir="/Users/tester"
          defaultCloneDirectory="/Users/tester"
        />
      </QueryClientProvider>
    );
    const screen = await render(dialog(true));

    try {
      await page.getByText("GitHub repository", { exact: true }).click();
      await page.getByPlaceholder("owner/repository").fill("ScientFactory/scient");
      await page.getByRole("button", { name: /Continue/ }).click();
      await page.getByRole("button", { name: /Clone/ }).click();
      await vi.waitFor(() => expect(onAddProjectPath).toHaveBeenCalledTimes(1));

      await screen.rerender(dialog(false));
      await screen.rerender(dialog(true));
      await expect.element(page.getByText("Sources", { exact: true })).toBeVisible();

      resolveAdd(true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onOpenChange).not.toHaveBeenCalled();
      await expect.element(page.getByText("Sources", { exact: true })).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restore();
    }
  });
});
