import { expect, it } from "vite-plus/test";
import { latexReadingViewWeight } from "./latexReadingViewWeight";
import { observeMathFieldReadiness } from "./mathFieldReadiness";

it("charges shadow formula markup, text, attributes and retained source", () => {
  const host = document.createElement("span");
  const root = host.attachShadow({ mode: "open" });
  const ink = document.createElement("span");
  root.append(ink);
  const empty = latexReadingViewWeight(host, 0);
  ink.textContent = "x".repeat(10000);
  ink.setAttribute("aria-label", "y".repeat(20000));
  const loaded = latexReadingViewWeight(host, 20000);
  expect(loaded - empty).toBeGreaterThan(80000);
  expect(latexReadingViewWeight(host, 20000)).toBe(loaded);
});

it("publishes readiness only after connected rendered ink is stable, and cancels cleanly", async () => {
  const host = document.createElement("span");
  const ink = document.createElement("span");
  ink.className = "ML__latex";
  ink.textContent = "Formula";
  ink.style.display = "none";
  host.attachShadow({ mode: "open" }).append(ink);
  document.body.append(host);
  const cancel = observeMathFieldReadiness(host, host, false);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.dataset.scientMathReady).toBeUndefined();
    ink.style.display = "inline-block";
    await expect.poll(() => host.dataset.scientMathReady).toBe("true");
    cancel();
    expect(host.dataset.scientMathReady).toBeUndefined();
  } finally {
    cancel();
    host.remove();
  }
});

it("terminates stalled readiness and accepts a rendered empty input", async () => {
  const host = document.createElement("span");
  host.attachShadow({ mode: "open" });
  document.body.append(host);
  let cancel = observeMathFieldReadiness(host, host, false, 40);
  try {
    await expect.poll(() => host.dataset.scientMathReady).toBe("failed");
    cancel();
    const ink = document.createElement("span");
    ink.className = "ML__latex";
    host.shadowRoot!.append(ink);
    cancel = observeMathFieldReadiness(host, host, true);
    await expect.poll(() => host.dataset.scientMathReady).toBe("true");
  } finally {
    cancel();
    host.remove();
  }
});
