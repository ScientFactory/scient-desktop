import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  AssistedSetupActions,
  AssistedSetupFrame,
  AssistedSetupStatus,
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
