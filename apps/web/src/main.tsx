import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import "@fontsource-variable/jetbrains-mono";
import "./index.css";

import { appHistory } from "./appNavigation";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { isElectron } from "./env";

const router = getRouter(appHistory);

function PackagedStartupReadyMarker() {
  React.useEffect(() => {
    document.documentElement.dataset.scientRendererReady = "true";
    return () => {
      delete document.documentElement.dataset.scientRendererReady;
    };
  }, []);

  return null;
}

document.title = APP_DISPLAY_NAME;

if (isElectron) {
  document.documentElement.dataset.runtime = "electron";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PackagedStartupReadyMarker />
    <RouterProvider router={router} />
  </React.StrictMode>,
);
