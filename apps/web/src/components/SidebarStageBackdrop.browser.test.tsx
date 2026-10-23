import { expect, it } from "vite-plus/test";

// SCIENT-FORK:START
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
} from "./SidebarStageBackdrop";
import { describe } from "vite-plus/test";
// SCIENT-FORK:END
import { render } from "../../test/render";
import { StageBackdropArt } from "./SidebarStageBackdrop";

// Gradients and patterns resolve url(#id) document-wide, so a repeated id would paint one
// backdrop with another's definitions.
// SCIENT-FORK:START — Scient's stage art is CSS and the Scient symbol, with no SVG definitions,
// so two backdrops on one page cannot share an id.
it.each(["nightly", "dev"] as const)(
  "gives every %s backdrop its own SVG definitions when two are on the page",
  async (variant) => {
    await using screen = await render(
      <>
        <StageBackdropArt variant={variant} />
        <StageBackdropArt variant={variant} />
      </>,
    );
    expect(screen.container.querySelectorAll("[data-scient-stage]")).toHaveLength(2);
    expect(screen.container.querySelectorAll("[id]")).toHaveLength(0);
  },
);
// SCIENT-FORK:END

// SCIENT-FORK:START
{
  async function renderMarkup(node: import("react").ReactNode) {
    await using screen = await render(node);
    return screen.container.innerHTML.replaceAll(": ", ":");
  }
  describe("SidebarStageBackdrop", () => {
    it("resolves stage artwork only when enabled", async () => {
      expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
      expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
      expect(resolveSidebarStageBackdropVariant("Beta")).toBe("nightly");
      expect(resolveSidebarStageBackdropVariant("Dev", false)).toBeNull();
      expect(resolveSidebarStageBackdropVariant("Alpha")).toBeNull();
    });

    it("resolves supported environment pill labels", async () => {
      expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
      expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBe("Nightly");
      expect(resolveEnvironmentIdentificationPillLabel("Beta")).toBe("Beta");
      expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
      expect(resolveEnvironmentIdentificationPillLabel("Alpha")).toBeNull();
    });

    it.each(["nightly", "dev"] as const)(
      "uses the minimal Scient treatment when %s artwork is rendered more than once",
      async (variant) => {
        const markup = await renderMarkup(
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
}
// SCIENT-FORK:END
