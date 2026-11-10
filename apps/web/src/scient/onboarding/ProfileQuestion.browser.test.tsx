import "../../index.css";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { GettingStartedPreferencesStep } from "./ScientGettingStartedView";
import { useScientOnboardingStorage } from "./storage";
import { SCIENT_PERSONALIZATION_STORAGE_KEY, type ScientField, type ScientRole } from "./model";

function ProfileQuestion() {
  const { profile, saveProfile, skipProfileQuestion } = useScientOnboardingStorage();
  const [field, setField] = useState<ScientField | undefined>(profile.field);
  const [role, setRole] = useState<ScientRole | undefined>(profile.role);
  if (profile.askedAt !== undefined) return <p>Question finished</p>;
  return (
    <>
      <GettingStartedPreferencesStep
        workKinds={profile.workKinds}
        otherSelected={false}
        otherWork=""
        field={field}
        role={role}
        onFieldChange={setField}
        onRoleChange={setRole}
        onToggleWorkKind={() => {}}
        onOtherSelectedChange={() => {}}
        onOtherWorkChange={() => {}}
        onContinue={() =>
          saveProfile({
            workKinds: profile.workKinds,
            fieldOrTopic: "",
            ...(field === undefined ? {} : { field }),
            ...(role === undefined ? {} : { role }),
          })
        }
      />
      <button onClick={skipProfileQuestion}>Skip question</button>
    </>
  );
}

function profileStorage() {
  const previous = localStorage.getItem(SCIENT_PERSONALIZATION_STORAGE_KEY);
  localStorage.setItem(
    SCIENT_PERSONALIZATION_STORAGE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      workKinds: ["scientific"],
      fieldOrTopic: "",
      updatedAt: "2026-10-01T00:00:00Z",
    }),
  );
  return {
    [Symbol.dispose]() {
      if (previous === null) localStorage.removeItem(SCIENT_PERSONALIZATION_STORAGE_KEY);
      else localStorage.setItem(SCIENT_PERSONALIZATION_STORAGE_KEY, previous);
    },
  };
}

it("saves optional field and role for an older profile and keeps the question finished after remount", async () => {
  using _storage = profileStorage();
  {
    await using screen = await render(<ProfileQuestion />);
    await screen.getByRole("combobox", { name: "Your field" }).click();
    await page.getByRole("option", { name: "Medicine & health" }).click();
    await screen.getByRole("combobox", { name: "Your role" }).click();
    await page.getByRole("option", { name: "Postdoc" }).click();
    const directory = import.meta.env.VITE_SCIENT_ONBOARDING_SCREENSHOTS;
    if (directory) {
      await page.viewport(390, 780);
      await page.screenshot({ path: `${directory}/profile-mobile.png`, element: screen.container });
      await page.viewport(1024, 768);
      await page.screenshot({
        path: `${directory}/profile-selected.png`,
        element: screen.container,
      });
    }
    await screen.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.element(screen.getByText("Question finished")).toBeVisible();
  }
  await using reloaded = await render(<ProfileQuestion />);
  await expect.element(reloaded.getByText("Question finished")).toBeVisible();
  expect(JSON.parse(localStorage.getItem(SCIENT_PERSONALIZATION_STORAGE_KEY)!)).toMatchObject({
    field: "medicine",
    role: "postdoc",
    workKinds: ["scientific"],
  });
});

it("remembers dismissal after remount without inventing field or role answers", async () => {
  using _storage = profileStorage();
  {
    await using screen = await render(<ProfileQuestion />);
    await screen.getByRole("button", { name: "Skip question" }).click();
    await expect.element(screen.getByText("Question finished")).toBeVisible();
  }
  await using reloaded = await render(<ProfileQuestion />);
  await expect.element(reloaded.getByText("Question finished")).toBeVisible();
  const saved = JSON.parse(localStorage.getItem(SCIENT_PERSONALIZATION_STORAGE_KEY)!);
  expect(saved).not.toHaveProperty("field");
  expect(saved).not.toHaveProperty("role");
});
