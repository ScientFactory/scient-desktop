import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  SidebarThreadFamilyDisclosureButton,
  SidebarThreadFamilyDisclosureRegion,
  sidebarThreadFamilyRegionId,
} from "./SidebarThreadFamilyDisclosure";

describe("SidebarThreadFamilyDisclosure", () => {
  it("connects an identifiable control to its expanded family region", () => {
    const id = sidebarThreadFamilyRegionId("pinned", "thread-root");
    const markup = renderToStaticMarkup(
      <>
        <SidebarThreadFamilyDisclosureButton
          childCount={2}
          controls={id}
          open
          threadTitle="Main analysis"
          onToggle={vi.fn()}
        />
        <SidebarThreadFamilyDisclosureRegion id={id} open threadTitle="Main analysis">
          <div>Child</div>
        </SidebarThreadFamilyDisclosureRegion>
      </>,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain(`aria-controls="${id}"`);
    expect(markup).toContain('aria-label="Collapse 2 subagents under “Main analysis”"');
    expect(markup).toContain(`id="${id}"`);
    expect(markup).toContain('role="region"');
    expect(markup).toContain("duration-220");
    expect(markup).toContain("motion-reduce:transition-none");
  });

  it("keeps a closed region owned without rendering a large hidden family initially", () => {
    const id = sidebarThreadFamilyRegionId("project", "thread-root");
    const markup = renderToStaticMarkup(
      <SidebarThreadFamilyDisclosureRegion id={id} open={false} threadTitle="Main analysis">
        <div>Hidden child</div>
      </SidebarThreadFamilyDisclosureRegion>,
    );

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("inert");
    expect(markup).toContain(`id="${id}"`);
    expect(markup).not.toContain("Hidden child");
  });
});
