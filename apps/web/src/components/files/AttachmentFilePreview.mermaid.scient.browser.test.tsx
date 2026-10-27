import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import "~/index.css";
import { MermaidFilePreview } from "./MermaidFilePreview";

const renderer = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("~/components/chat/MermaidDiagram", () => ({ renderMermaidSvg: renderer.render }));

describe("standalone Mermaid readiness", () => {
  it.each(["diagram", "error"] as const)(
    "waits past toolbar chrome for a settled %s",
    async (outcome) => {
      const pending = Promise.withResolvers<{ svg: string; diagramType: string }>();
      renderer.render.mockReset().mockReturnValue(pending.promise);
      using _release = {
        [Symbol.dispose]: () => pending.resolve({ svg: "<svg/>", diagramType: "flowchart" }),
      };
      const source = `flowchart LR\nA --> B\n%% deferred ${outcome}`;
      using imageSource = vi
        .spyOn(HTMLImageElement.prototype, "src", "set")
        .mockImplementation(() => {});
      await using screen = await render(<MermaidFilePreview text={source} />);
      await vi.waitFor(() => expect(renderer.render).toHaveBeenCalledWith(source));
      expect(
        screen.container.querySelector('[aria-label="More diagram actions"] svg'),
      ).not.toBeNull();

      const settled = () =>
        screen.container.querySelector(".scient-mermaid-inline svg") ??
        screen.container.querySelector('[aria-label="Diagram error"][aria-busy="false"]');
      const assertSettled = () => expect(settled()).not.toBeNull();
      // The same readiness predicate as the resource tests must reject the still-pending render.
      expect(assertSettled).toThrow();
      await act(() => {
        if (outcome === "error") pending.reject(new Error("Controlled diagram failure"));
        else
          pending.resolve({
            svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Settled A to B</text><image href="https://mermaid-privacy.invalid/pixel.png" /></svg>',
            diagramType: "flowchart",
          });
      });
      await vi.waitFor(assertSettled);
      if (outcome === "diagram") {
        expect(settled()?.textContent).toContain("Settled A to B");
        expect(settled()?.querySelector("image, foreignObject img")).toBeNull();
      } else {
        expect(settled()?.textContent).toContain("Controlled diagram failure");
        await vi.waitFor(() =>
          expect(screen.container.querySelector("pre code")?.textContent).toBe(source),
        );
      }
      expect(imageSource).not.toHaveBeenCalled();
    },
  );
});
