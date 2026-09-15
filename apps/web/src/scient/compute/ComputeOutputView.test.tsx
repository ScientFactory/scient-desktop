import { renderToStaticMarkup } from "react-dom/server";
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
vi.mock("./ComputeRichOutput", () => ({ ComputeRichOutput: () => null }));

import { ComputeOutputView } from "./ComputeOutputView";
import { COMPUTE_NATIVE_FIGURE_MEDIA_TYPE } from "./computeResultPresentation";

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
