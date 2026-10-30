import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComputeSessionGeneration } from "@t3tools/contracts";
import { ComputeVariablesView } from "./ComputeVariablesView";

describe("Compute variable presentation", () => {
  it("keeps every value column available through the shared scroll area", async () => {
    await using screen = await render(
      <ComputeVariablesView
        snapshot={{
          generation: ComputeSessionGeneration.make(1),
          variables: [
            { name: "measurement", typeName: "float", shape: null, size: 1, preview: "42.5" },
          ],
          truncated: false,
        }}
        loading={false}
        error={null}
        available
        hasLiveSession
        selectedIsLive
        busy={false}
        onShowLive={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    const container = screen.container;
    expect(
      [...container.querySelectorAll('th[scope="col"]')].map((node) => node.textContent),
    ).toEqual(["Name", "Type", "Shape / size", "Preview"]);
    expect(container.querySelector("tbody")?.textContent).toContain("42.5");
    expect(container.querySelector("tbody .hidden")).toBeNull();
    expect(
      container.querySelector("table")?.closest('[data-slot="scroll-area-viewport"]'),
    ).not.toBeNull();
  });
});
