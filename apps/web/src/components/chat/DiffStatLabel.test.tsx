import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DiffStatLabel } from "./DiffStatLabel";

describe("DiffStatLabel", () => {
  it("exposes one useful semantic summary while keeping both visual counts", () => {
    const markup = renderToStaticMarkup(<DiffStatLabel additions={63} deletions={4} />);

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="63 additions, 4 deletions"');
    expect(markup.match(/aria-hidden="true"/g)).toHaveLength(2);
    expect(markup).toContain("+63");
    expect(markup).toContain("-4");
  });

  it("uses singular labels without changing the visual +/- format", () => {
    const markup = renderToStaticMarkup(<DiffStatLabel additions={1} deletions={1} />);

    expect(markup).toContain('aria-label="1 addition, 1 deletion"');
    expect(markup).toContain("+1");
    expect(markup).toContain("-1");
  });
});
