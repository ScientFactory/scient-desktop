import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  StageBackdropArt,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it("resolves stage artwork only when enabled", () => {
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant("Dev", false)).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Alpha")).toBeNull();
  });

  it("resolves supported environment pill labels", () => {
    expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
    expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBe("Nightly");
    expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel("Alpha")).toBeNull();
  });

  it("matches the focus-ring offset helper to each artwork palette", () => {
    expect(resolveSidebarStageFocusRingOffsetClass("nightly")).toBe(
      "focus-visible:ring-offset-(--stage-night-bottom)",
    );
    expect(resolveSidebarStageFocusRingOffsetClass("dev")).toBe(
      "focus-visible:ring-offset-(--stage-art-bottom)",
    );
  });

  it.each(["nightly", "dev"] as const)(
    "uses the minimal Scient treatment when %s artwork is rendered more than once",
    (variant) => {
      const markup = renderToStaticMarkup(
        <>
          <StageBackdropArt variant={variant} />
          <StageBackdropArt variant={variant} />
        </>,
      );

      expect(markup.match(new RegExp(`data-scient-stage="${variant}"`, "g"))?.length).toBe(2);
      expect(markup).toContain("scient-stage-watermark");
      expect(markup).toContain(
        variant === "nightly"
          ? "--scient-stage-top:var(--stage-night-top)"
          : "--scient-stage-top:var(--stage-art-top)",
      );
      expect(markup).toContain(
        variant === "nightly"
          ? "--scient-stage-bottom:var(--stage-night-bottom)"
          : "--scient-stage-bottom:var(--stage-art-bottom)",
      );
      expect(markup).not.toContain("stage-blueprint");
      expect(markup).not.toContain("T3");
    },
  );
});
