import * as NodeURL from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

import pkg from "../package.json" with { type: "json" };
import { scientCjkFonts } from "../scripts/scientCjkFonts";
import { tailwindPlugins } from "./tailwind";

const repoRoot = NodeURL.fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The public share page (`infra/scient-cloud/share`), built from the app's sources under
 * `/s/_app/`. Connection and sign-in settings are compiled empty: the page talks only to the
 * cloud's public share API.
 */
export function sharePageConfig(root: string) {
  return defineConfig({
    root,
    base: "/s/_app/",
    plugins: [react({ compiler: true }), tailwindPlugins(false), scientCjkFonts()],
    define: {
      "import.meta.env.VITE_WS_URL": '""',
      "import.meta.env.VITE_HTTP_URL": '""',
      "import.meta.env.VITE_T3CODE_RELAY_URL": '""',
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": '""',
      "import.meta.env.VITE_CLERK_JWT_TEMPLATE": '""',
      "import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID": '""',
      "import.meta.env.VITE_RELAY_OTLP_TRACES_URL": '""',
      "import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET": '""',
      "import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN": '""',
      "import.meta.env.VITE_HOSTED_APP_URL": '""',
      "import.meta.env.VITE_HOSTED_APP_CHANNEL": '""',
      "import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY": '""',
      "import.meta.env.VITE_RELEASE_CHANNEL": '""',
      "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
    },
    resolve: {
      tsconfigPaths: true,
      dedupe: ["react", "react-dom"],
    },
    server: { fs: { allow: [repoRoot] } },
    build: {
      outDir: `${root}/dist`,
      emptyOutDir: true,
      sourcemap: false,
    },
    worker: { format: "es", plugins: () => [scientCjkFonts()] },
  });
}
