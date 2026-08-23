import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  GettingStartedPreferencesStep,
  GettingStartedStartStep,
  ScientGettingStartedShell,
} from "./ScientGettingStartedView";

describe("ScientGettingStartedShell", () => {
  it("keeps navigation stable inside one restrained onboarding card", () => {
    const firstStepMarkup = renderToStaticMarkup(
      <ScientGettingStartedShell
        canGoBack={false}
        currentStep="agent"
        journey={["agent", "preferences", "start"]}
        onBack={() => undefined}
        onSkip={() => undefined}
      >
        <p>Current step</p>
      </ScientGettingStartedShell>,
    );
    const laterStepMarkup = renderToStaticMarkup(
      <ScientGettingStartedShell
        canGoBack
        currentStep="preferences"
        journey={["agent", "preferences", "start"]}
        onBack={() => undefined}
        onSkip={() => undefined}
      >
        <p>Current step</p>
      </ScientGettingStartedShell>,
    );

    expect(firstStepMarkup).toContain("Getting started with Scient");
    expect(firstStepMarkup).toContain('aria-label="Getting started steps"');
    expect(firstStepMarkup).toContain('aria-current="step"');
    expect(firstStepMarkup).toContain("1</span>Connect");
    expect(firstStepMarkup).toContain("2</span>Your work");
    expect(firstStepMarkup).toContain("3</span>Start");
    expect(firstStepMarkup).toContain('data-scient-getting-started-card="true"');
    expect(firstStepMarkup).toContain("max-w-2xl");
    expect(firstStepMarkup).toContain("min-h-full");
    expect(firstStepMarkup).toContain("justify-center");
    expect(firstStepMarkup).toContain("-translate-y-3");
    expect(firstStepMarkup).toContain("sm:-translate-x-3");
    expect(firstStepMarkup).toContain("rounded-xl border border-border/70 bg-card");
    expect(firstStepMarkup).toContain("sm:size-60");
    expect(firstStepMarkup).toContain("opacity-[0.045]");
    expect(firstStepMarkup).toContain("black_88%");
    expect(firstStepMarkup).not.toContain("data-scient-getting-started-surface");
    expect(firstStepMarkup).toMatch(/<button[^>]*disabled=""[^>]*>.*Back<\/button>/);
    expect(laterStepMarkup).toContain("Getting started with Scient");
    expect(laterStepMarkup).toContain(">Skip</button>");
    expect(laterStepMarkup).toMatch(/<button(?![^>]*disabled="")[^>]*>.*Back<\/button>/);
    expect(laterStepMarkup).not.toContain('role="dialog"');
    expect(laterStepMarkup).not.toContain('role="progressbar"');
  });
});

describe("GettingStartedPreferencesStep", () => {
  it("offers flat work choices and reveals the custom answer only for Other", () => {
    const withoutOther = renderToStaticMarkup(
      <GettingStartedPreferencesStep
        onContinue={() => undefined}
        onOtherSelectedChange={() => undefined}
        onOtherWorkChange={() => undefined}
        onToggleWorkKind={() => undefined}
        otherSelected={false}
        otherWork=""
        workKinds={["scientific"]}
      />,
    );
    const withOther = renderToStaticMarkup(
      <GettingStartedPreferencesStep
        onContinue={() => undefined}
        onOtherSelectedChange={() => undefined}
        onOtherWorkChange={() => undefined}
        onToggleWorkKind={() => undefined}
        otherSelected
        otherWork="Lesson planning"
        workKinds={["academic"]}
      />,
    );

    expect(withoutOther).toContain("How will you use Scient?");
    expect(withoutOther).toContain("Research &amp; science");
    expect(withoutOther).toContain("Coding &amp; development");
    expect(withoutOther).toContain("Academic work");
    expect(withoutOther.indexOf("Research &amp; science")).toBeLessThan(
      withoutOther.indexOf("Coding &amp; development"),
    );
    expect(withoutOther.indexOf("Coding &amp; development")).toBeLessThan(
      withoutOther.indexOf("Academic work"),
    );
    expect(withoutOther).toContain("Other");
    expect(withoutOther).not.toContain("Tell us what you do");
    expect(withoutOther).not.toContain("Field or topic");
    expect(withoutOther).not.toContain("rounded-full");
    expect(withoutOther).toContain("max-w-md");
    expect(withoutOther).toContain('class="mt-7 flex justify-end"');
    expect(withoutOther).not.toContain("mt-7 flex max-w-md");
    expect(withoutOther).toContain("min-h-11");
    expect(withoutOther).toContain("bg-primary/75");
    expect(withOther).toContain('placeholder="Tell us what you do"');
    expect(withOther).toContain('aria-label="Describe how you use Scient"');
    expect(withOther).toContain('autoCapitalize="sentences"');
    expect(withOther).toContain('maxLength="120"');
    expect(withOther).toContain('value="Lesson planning"');
  });
});

describe("GettingStartedStartStep", () => {
  it("requires a project before starting work", () => {
    const markup = renderToStaticMarkup(<GettingStartedStartStep onAddProject={() => undefined} />);

    expect(markup).toContain("Add project");
    expect(markup).toContain("give your tasks a workspace");
    expect(markup).not.toContain("quick chat");
    expect(markup).not.toContain(">Back</button>");
  });
});
