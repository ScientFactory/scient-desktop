import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  GettingStartedPreferencesStep,
  GettingStartedStartStep,
  ScientGettingStartedShell,
} from "./ScientGettingStartedView";

describe("ScientGettingStartedShell", () => {
  it("disables Back on the first step and offers Back and Skip later, outside a dialog", () => {
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

    expect(firstStepMarkup).toContain('aria-current="step"');
    expect(firstStepMarkup).toMatch(/<button[^>]*disabled=""[^>]*>.*Back<\/button>/);
    expect(laterStepMarkup).toContain(">Skip</button>");
    expect(laterStepMarkup).toMatch(/<button(?![^>]*disabled="")[^>]*>.*Back<\/button>/);
    expect(laterStepMarkup).not.toContain('role="dialog"');
  });
});

describe("GettingStartedPreferencesStep", () => {
  it("reveals the custom answer only for Other", () => {
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

    expect(withoutOther).not.toContain('placeholder="Tell us what you do"');
    expect(withOther).toContain('placeholder="Tell us what you do"');
    expect(withOther).toContain('maxLength="120"');
    expect(withOther).toContain('value="Lesson planning"');
  });
});

describe("GettingStartedStartStep", () => {
  it("requires a project before starting work", () => {
    const markup = renderToStaticMarkup(<GettingStartedStartStep onAddProject={() => undefined} />);

    expect(markup).toContain("Add project");
    expect(markup).not.toContain("quick chat");
    expect(markup).not.toContain(">Back</button>");
  });
});
