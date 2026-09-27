import { ProviderDriverKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  AssistedSetupActions,
  AssistedSetupFrame,
  AssistedSetupStatus,
  ProviderSetupIcon,
} from "./AssistedProviderSetup";

describe("AssistedProviderSetup", () => {
  it("centers compact picker content without changing dialog layout classes", () => {
    const markup = renderToStaticMarkup(
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body="Connected account"
          icon={<span>status</span>}
          title="Codex is ready"
          trailing={<button type="button">Repair</button>}
        />
        <AssistedSetupActions>
          <button type="button">Install</button>
        </AssistedSetupActions>
      </AssistedSetupFrame>,
    );

    expect(markup).toContain("in-[[data-model-picker-content=true]]:items-center");
    expect(markup).toContain("in-[[data-model-picker-content=true]]:justify-center");
    expect(markup).toContain("in-[[data-model-picker-content=true]]:w-full");
    expect(markup).toContain("in-[[data-model-picker-content=true]]:size-8");
    expect(markup).toContain(":size-7");
    expect(markup).toContain("in-[[data-model-picker-content=true]]:text-center");
    expect(markup).toContain("in-[[data-model-picker-content=true]]:hidden");
    expect(markup).toContain("in-[[data-slot=dialog-panel]]:p-0");
    expect(markup).toContain("items-center");
    expect(markup).toContain("self-center");
    expect(markup).not.toContain("self-end");
    expect(markup).toContain(">Repair<");
    const installButtonIndex = markup.indexOf(">Install<");
    const actionStart = markup.lastIndexOf("<div", installButtonIndex);
    const actionMarkup = markup.slice(actionStart, markup.indexOf("</div>", actionStart));
    expect(actionMarkup).toContain("in-[[data-model-picker-content=true]]:w-full");
    expect(actionMarkup).toContain("in-[[data-model-picker-content=true]]:justify-center");
    expect(actionMarkup).toContain("in-[[data-model-picker-content=true]]:pt-0");
  });

  it("uses one stable composer layout for every assisted provider", () => {
    const markup = renderToStaticMarkup(
      <AssistedSetupFrame>
        <span>Provider setup</span>
      </AssistedSetupFrame>,
    );

    expect(markup).toContain('data-provider-onboarding-view="assisted"');
    expect(markup).not.toContain("translate-x-2.5");
    expect(markup).not.toContain("translate-y-2.5");
  });
});

describe("ProviderSetupIcon", () => {
  it.each([
    ["pi", "Pi", "#F09082"],
    ["omp", "Oh My Pi", "#9b4dff"],
    ["codex", "Codex", "<svg"],
  ])("shows %s's own logo in the composer picker and a shield elsewhere", (driver, name, mark) => {
    const markup = renderToStaticMarkup(
      <ProviderSetupIcon displayName={name} driver={ProviderDriverKind.make(driver)} />,
    );
    // The shield hides inside the picker; the logo only shows there.
    expect(markup).toContain("lucide-shield-check");
    expect(markup).toContain("in-[[data-model-picker-content=true]]:hidden");
    expect(markup).toContain("in-[[data-model-picker-content=true]]:inline-flex");
    expect(markup).toContain(mark);
  });
});
