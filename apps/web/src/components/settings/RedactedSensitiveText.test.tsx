import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RedactedSensitiveText } from "./RedactedSensitiveText";

const account = "person@example.com";

function renderAccount(defaultRevealed?: boolean): string {
  return renderToStaticMarkup(
    <RedactedSensitiveText
      value={account}
      ariaLabel="Toggle account visibility"
      revealTooltip="Reveal account"
      hideTooltip="Hide account"
      {...(defaultRevealed === undefined ? {} : { defaultRevealed })}
    />,
  );
}

describe("RedactedSensitiveText", () => {
  it("keeps sensitive text redacted by default", () => {
    const markup = renderAccount();

    expect(markup).not.toContain(account);
    expect(markup).toContain("blur-[2px]");
  });

  it("can show provider account emails initially", () => {
    const markup = renderAccount(true);

    expect(markup).toContain(account);
    expect(markup).not.toContain("blur-[2px]");
  });
});
