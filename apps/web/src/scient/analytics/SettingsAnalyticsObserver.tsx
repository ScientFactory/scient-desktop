import { useLocation } from "@tanstack/react-router";
import { useScientAnalyticsView } from "./client";
import { settingsCategory } from "./viewCategories";

export function SettingsAnalyticsObserver() {
  const section = settingsCategory(useLocation().pathname);
  useScientAnalyticsView(
    section === null ? null : { name: "settings.viewed", properties: { section } },
  );
  return null;
}
