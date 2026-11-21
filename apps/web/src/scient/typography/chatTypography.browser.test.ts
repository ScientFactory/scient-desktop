import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

function mount(html: string, parent: HTMLElement = document.body) {
  const host = document.createElement(parent === document.head ? "style" : "div");
  if (parent === document.head) host.textContent = html;
  else host.innerHTML = html;
  parent.append(host);
  return Object.assign(host, { [Symbol.dispose]: () => host.remove() });
}

function px(element: Element, property: "fontSize" | "lineHeight"): number {
  return Number.parseFloat(getComputedStyle(element)[property]);
}

describe("chat typography", () => {
  it("tightens agent replies only, keeping inline code inside the line", () => {
    const rootSize = px(document.documentElement, "fontSize");
    using host = mount(`
      <div class="chat-markdown scient-reply-prose text-sm leading-relaxed" data-reply>
        <p>Reply <strong>bold</strong> <code>#efeff0</code></p>
      </div>
      <div class="chat-markdown text-sm leading-relaxed user-message-markdown" data-user><p>User</p></div>
      <div class="scient-markdown-document" data-document><p>Document</p></div>`);
    const reply = host.querySelector("[data-reply]")!;
    const code = reply.querySelector("code")!;

    expect(px(reply, "fontSize")).toBeCloseTo(rootSize, 1);
    expect(px(reply, "lineHeight")).toBeCloseTo(rootSize * 1.55, 1);
    expect(px(code, "lineHeight")).toBeCloseTo(px(code, "fontSize") * 1.2, 1);
    expect(getComputedStyle(reply.querySelector("strong")!).fontWeight).toBe("650");

    const user = host.querySelector("[data-user]")!;
    expect(px(user, "lineHeight")).toBeCloseTo(px(user, "fontSize") * 1.625, 1);
    expect(px(host.querySelector("[data-document]")!, "fontSize")).toBeCloseTo(rootSize * 0.905, 1);
  });

  it("keeps nested text-sm on its 1.25rem line", () => {
    const rootSize = px(document.documentElement, "fontSize");
    using host = mount(
      `<div class="chat-markdown scient-reply-prose"><span class="block text-sm" data-nested>x</span></div>`,
    );
    expect(px(host.querySelector("[data-nested]")!, "lineHeight")).toBeCloseTo(rootSize * 1.25, 1);
  });

  it("lets theme CSS override the reply and inline-code leading", () => {
    using _themeCss = mount(
      ".chat-markdown { line-height: 2; } .chat-markdown code { line-height: 3; }",
      document.head,
    );
    using host = mount(
      `<div class="chat-markdown scient-reply-prose text-sm leading-relaxed"><p>x <code>y</code></p></div>`,
    );
    const reply = host.firstElementChild!;
    const code = reply.querySelector("code")!;
    expect(px(reply, "lineHeight")).toBeCloseTo(px(reply, "fontSize") * 2, 1);
    expect(px(code, "lineHeight")).toBeCloseTo(px(code, "fontSize") * 3, 1);
  });
});
