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
      <AssistedSetupFrame flow="codex">
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

  it("nudges only the Grok composer surface slightly left and up", () => {
    const grokMarkup = renderToStaticMarkup(
      <AssistedSetupFrame flow="grok">
        <span>Grok setup</span>
      </AssistedSetupFrame>,
    );
    const codexMarkup = renderToStaticMarkup(
      <AssistedSetupFrame flow="codex">
        <span>Codex setup</span>
      </AssistedSetupFrame>,
    );

    expect(grokMarkup).toContain("in-[[data-model-picker-content=true]]:-translate-x-2.5");
    expect(grokMarkup).toContain("in-[[data-model-picker-content=true]]:-translate-y-2.5");
    expect(grokMarkup).toContain("[data-assisted-setup-icon=true]]:-translate-y-1");
    expect(grokMarkup).toContain("[data-assisted-setup-title=true]]:-translate-y-1");
    expect(codexMarkup).not.toContain("translate-x-2.5");
    expect(codexMarkup).not.toContain("translate-y-2.5");
  });
});
