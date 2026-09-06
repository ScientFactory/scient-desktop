import { createFileRoute } from "@tanstack/react-router";
import { CustomModelsPanel } from "~/components/settings/CustomModelsPanel";

export const Route = createFileRoute("/settings/custom-models")({
  component: CustomModelsPanel,
});
