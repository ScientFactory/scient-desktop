import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AssistedSetupFrame, AssistedSetupStatus } from "./AssistedProviderSetup";

describe("AssistedProviderSetup", () => {
  it("centers compact picker content without changing dialog layout classes", () => {
    const markup = renderToStaticMarkup(
      <AssistedSetupFrame flow="codex">
        <AssistedSetupStatus
          body="Connected account"
          icon={<span>status</span>}
          title="Codex is ready"
          trailing={<button type="button">Repair</button>}
        />
      </AssistedSetupFrame>,
    );

    expect(markup).toContain("in-[[data-model-picker-content=true]]:justify-center");
    expect(markup).toContain("in-[[data-model-picker-content=true]]:text-center");
    expect(markup).toContain("in-[[data-model-picker-content=true]]:hidden");
    expect(markup).toContain("in-[[data-slot=dialog-panel]]:p-0");
    expect(markup).toContain(">Repair<");
  });
});
