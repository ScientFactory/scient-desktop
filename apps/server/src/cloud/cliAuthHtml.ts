export type LoopbackAuthorizationStage = "dev" | "nightly" | "latest";

declare const __T3CODE_BUILD_CHANNEL__: "nightly" | "latest" | undefined;

export function resolveLoopbackAuthorizationStage(): LoopbackAuthorizationStage {
  return typeof __T3CODE_BUILD_CHANNEL__ === "undefined" ? "dev" : __T3CODE_BUILD_CHANNEL__;
}

const stageBrands = {
  dev: "Scient (Dev)",
  nightly: "Scient (Nightly)",
  latest: "Scient",
} as const satisfies Record<LoopbackAuthorizationStage, string>;

export function renderLoopbackAuthorizationCompleteHtml(
  stage: LoopbackAuthorizationStage = resolveLoopbackAuthorizationStage(),
): string {
  const stageBrand = stageBrands[stage];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>T3 Connect authorization complete</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f7f9;
        color: #17191f;
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 32px 16px;
        background:
          radial-gradient(48rem 22rem at 50% -8rem, rgba(70, 88, 126, 0.13), transparent),
          #faf9f6;
      }
      main {
        width: min(100%, 576px);
        overflow: hidden;
        border: 1px solid rgba(23, 25, 31, 0.1);
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 24px 64px rgba(16, 24, 40, 0.16);
      }
      .stage {
        position: relative;
        height: 96px;
        overflow: hidden;
        padding: 22px 24px;
        color: #471a1a;
      }
      .stage-latest {
        background:
          radial-gradient(18rem 7rem at 82% -30%, rgba(70, 88, 126, 0.2), transparent 72%),
          radial-gradient(14rem 6rem at 14% 10%, rgba(71, 26, 26, 0.1), transparent 76%),
          #faf9f6;
      }
      .stage-dev {
        background:
          radial-gradient(18rem 7rem at 82% -30%, rgba(70, 88, 126, 0.2), transparent 72%),
          radial-gradient(14rem 6rem at 14% 10%, rgba(71, 26, 26, 0.1), transparent 76%),
          #faf9f6;
      }
      .stage-nightly {
        background:
          radial-gradient(18rem 7rem at 82% -30%, rgba(71, 26, 26, 0.2), transparent 72%),
          radial-gradient(14rem 6rem at 14% 10%, rgba(70, 88, 126, 0.12), transparent 76%),
          #faf9f6;
      }
      .stage-content {
        position: relative;
        z-index: 1;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .brand {
        margin: 0;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.2em;
        text-transform: uppercase;
      }
      .brand { color: #471a1a; }
      .content { padding: 30px 32px 34px; }
      .eyebrow {
        margin: 0 0 8px;
        color: #46587e;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }
      h1 { margin: 0; font-size: clamp(26px, 5vw, 34px); line-height: 1.12; letter-spacing: -0.035em; }
      .description { margin: 12px 0 0; color: #646975; font-size: 15px; line-height: 1.6; }
      @media (prefers-color-scheme: dark) {
        :root { background: #101115; color: #f1f3f7; }
        body { background: radial-gradient(48rem 22rem at 50% -8rem, rgba(70, 88, 126, 0.24), transparent), #101115; }
        main { border-color: rgba(255, 255, 255, 0.1); background: rgba(25, 27, 33, 0.96); }
        .stage-latest, .stage-dev, .stage-nightly {
          color: #faf9f6;
          background:
            radial-gradient(18rem 7rem at 82% -30%, rgba(70, 88, 126, 0.28), transparent 72%),
            radial-gradient(14rem 6rem at 14% 10%, rgba(71, 26, 26, 0.34), transparent 76%),
            #1b1819;
        }
        .brand { color: #faf9f6; }
        .eyebrow { color: #9ca8c1; }
        .description { color: #a8adb8; }
      }
    </style>
  </head>
  <body>
    <main>
      <header class="stage stage-${stage}" data-stage="${stage}">
        <div class="stage-content">
          <p class="brand">${stageBrand}</p>
        </div>
      </header>
      <section class="content">
        <p class="eyebrow">Browser authorization complete</p>
        <h1>You're connected</h1>
        <p class="description">Return to your terminal to finish setting up T3 Connect. You can close this window.</p>
      </section>
    </main>
  </body>
</html>`;
}
