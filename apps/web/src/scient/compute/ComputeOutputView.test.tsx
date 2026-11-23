import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeProjectId,
  ComputeSessionId,
  EnvironmentId,
  INITIAL_COMPUTE_SESSION_GENERATION,
  type ComputeOutput,
  type ComputeSessionRecord,
  type ScopedThreadRef,
} from "@t3tools/contracts";

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: () => ({
    _tag: "Success",
    url: "https://synthetic.invalid/resource",
    expiresAt: Date.now() + 60_000,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/rightPanelStore", () => ({ useRightPanelStore: {} }));
vi.mock("gt-react", async (importOriginal) =>
  (await import("~/scient/testing/englishGTReact")).englishGTReact(await importOriginal()),
);
vi.mock("./ComputeRichOutput", () => ({ ComputeRichOutput: () => null }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, search }: { children: ReactNode; search: { environmentId: string } }) => (
    <a href="/settings/scientific-computing" data-environment={search.environmentId}>
      {children}
    </a>
  ),
}));

import { ComputeOutputView } from "./ComputeOutputView";
import { COMPUTE_NATIVE_FIGURE_MEDIA_TYPE } from "./computeResultPresentation";

describe("dependency recovery presentation", () => {
  const renderDiagnostic = (languageId: string, message: string) =>
    renderToStaticMarkup(
      <ComputeOutputView
        cwd="/synthetic"
        environmentId={EnvironmentId.make("remote-scient-host")}
        executionId={ComputeExecutionId.make("failed-execution")}
        session={
          { languageId: ComputeLanguageId.make(languageId), runtime: null } as ComputeSessionRecord
        }
        outputs={[
          {
            _tag: "diagnostic",
            sequence: 1,
            observedAt: "2026-09-17T00:00:00Z",
            diagnostic: {
              errorName: "ModuleNotFoundError",
              message,
              traceback: ["Original traceback retained"],
              frames: [],
            },
          },
        ]}
        threadRef={{} as ScopedThreadRef}
      />,
    );
  it("keeps the actual error and links to the execution host's settings without running anything", () => {
    const markup = renderDiagnostic("python", "No module named 'pandas'");
    expect(markup).toContain("ModuleNotFoundError");
    expect(markup).toContain("Original traceback retained");
    expect(markup).toContain('<summary class="cursor-pointer">Details</summary>');
    expect(markup).toContain("Python settings");
    expect(markup).toContain('data-environment="remote-scient-host"');
    expect(markup).not.toContain("reports pandas installed");
  });
  it.each([
    // The guessing rules are computeDependencyRecovery.test.ts's; one row
    // proves this view shows nothing when that model declines.
    ["python", "No module named 'project_utils'"],
  ])("does not suggest an environment change for %s / %s", (language, message) => {
    const markup = renderDiagnostic(language, message);
    expect(markup).not.toContain("Python settings");
    expect(markup).toContain("Original traceback retained");
  });
});

it("labels notebook cell lines without turning them into file links", () => {
  const markup = renderToStaticMarkup(
    <ComputeOutputView
      cwd="/synthetic"
      environmentId={EnvironmentId.make("synthetic")}
      executionId={ComputeExecutionId.make("failed-execution")}
      session={
        { languageId: ComputeLanguageId.make("python"), runtime: null } as ComputeSessionRecord
      }
      outputs={[
        {
          _tag: "diagnostic",
          sequence: 1,
          observedAt: "2026-11-23T00:00:00Z",
          diagnostic: {
            errorName: "NameError",
            message: "name 'run_date' is not defined",
            traceback: [],
            frames: [
              { relativePath: "analysis.ipynb", line: 3, column: null, functionName: null },
              { relativePath: "setup.py", line: 6, column: null, functionName: null },
            ],
          },
        },
      ]}
      threadRef={{} as ScopedThreadRef}
      notebook={{ path: "analysis.ipynb" }}
    />,
  );
  expect(markup).toContain("Line 3 in a notebook cell");
  expect(markup).not.toContain("analysis.ipynb:3");
  expect(markup).toContain("setup.py:6</button>");
});

it("offers a jump to a failed defining cell when live notebook evidence identifies it", () => {
  const markup = renderToStaticMarkup(
    <ComputeOutputView
      cwd="/synthetic"
      environmentId={EnvironmentId.make("synthetic")}
      executionId={ComputeExecutionId.make("failed-execution")}
      session={
        { languageId: ComputeLanguageId.make("python"), runtime: null } as ComputeSessionRecord
      }
      outputs={[
        {
          _tag: "diagnostic",
          sequence: 1,
          observedAt: "2026-11-23T00:00:00Z",
          diagnostic: {
            errorName: "NameError",
            message: "name 'run_date' is not defined",
            traceback: ["line 1 in cell"],
            frames: [],
          },
        },
      ]}
      threadRef={{} as ScopedThreadRef}
      notebook={{
        path: "analysis.ipynb",
        onReplay: () => undefined,
        onJumpToCell: () => undefined,
        definingCell: () => ({
          name: "run_date",
          cellId: "setup",
          cellNumber: 1,
          status: "failed",
        }),
      }}
    />,
  );
  expect(markup).toContain("Cell 1 defines run_date and failed.");
  expect(markup).toContain("Jump to cell 1");
  expect(markup).toContain('<summary class="cursor-pointer">Details</summary>');
});

describe("figure result projection", () => {
  it.each([true, false])(
    "renders the shared figure controls with or without a retained FIG: %s",
    (hasNative) => {
      const output: ComputeOutput = {
        _tag: "display-update",
        sequence: 1,
        observedAt: "2026-09-10T00:00:00Z",
        displayId: "matlab-figure:2",
        bundle: {
          metadataJson: null,
          representations: [
            {
              mediaType: "image/png",
              data: { _tag: "resource", contentHash: "sha256:png", byteLength: 3 },
            },
            ...(hasNative
              ? [
                  {
                    mediaType: COMPUTE_NATIVE_FIGURE_MEDIA_TYPE,
                    data: { _tag: "resource" as const, contentHash: "sha256:fig", byteLength: 4 },
                  },
                ]
              : []),
          ],
        },
      };
      const markup = renderToStaticMarkup(
        <ComputeOutputView
          allowFigureFollowing
          cwd="/synthetic"
          environmentId={EnvironmentId.make("synthetic")}
          executionId={ComputeExecutionId.make("execution")}
          session={
            {
              projectId: ComputeProjectId.make("project"),
              sessionId: ComputeSessionId.make("session"),
              languageId: ComputeLanguageId.make("matlab"),
              generation: INITIAL_COMPUTE_SESSION_GENERATION,
              label: "MATLAB",
            } as ComputeSessionRecord
          }
          outputs={[output]}
          threadRef={{} as ScopedThreadRef}
          source={{
            _tag: "document",
            origin: "file",
            path: "figures.m",
            bufferState: "saved",
            revision: null,
            range: null,
          }}
        />,
      );
      expect(markup).toContain("<img");
      expect(markup).toContain("Figure actions");
      expect(markup).toContain("More image actions");
      expect(markup).toContain("Loading figure");
    },
  );
});
