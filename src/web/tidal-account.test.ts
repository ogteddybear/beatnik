import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test(
  "Tidal account card escapes names and unlinks through the protected route",
  { timeout: 5000 },
  async () => {
    const view = path.join(process.cwd(), "src/web/views/tidal-account.ejs");
    const html = await ejs.renderFile(view, {
      account: { linked: true, displayName: "<script>private</script>" },
    });
    assert(!html.includes("<script>private</script>"));
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    try {
      const { document } = dom.window;
      assert.equal(
        document.getElementById("tidal-account-status")?.textContent,
        "Linked as <script>private</script>",
      );
      const button = document.getElementById("tidal-unlink") as HTMLButtonElement;
      assert.equal(button.hidden, false);
      const updated = new Promise<void>((resolve) => {
        const observer = new dom.window.MutationObserver(() => {
          if (button.hidden) {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(button, { attributes: true, attributeFilter: ["hidden"] });
      });
      dom.window.fetch = async (input, options) => {
        assert.equal(input, "/auth/tidal/unlink");
        assert.equal(options?.method, "POST");
        assert.equal(new Headers(options?.headers).get("X-Sashimi-Request"), "tidal");
        assert.equal(options?.credentials, "same-origin");
        return Response.json({ linked: false });
      };
      dom.window.eval(await readFile("src/web/public/tidal-account.js", "utf8"));
      button.click();
      await updated;
      assert.equal(button.hidden, true);
      assert.equal(document.getElementById("tidal-link")?.hidden, false);
      assert.match(document.getElementById("tidal-account-status")?.textContent || "", /unlinked/);
      const unlinked = await ejs.renderFile(view, {
        account: { linked: false, displayName: null },
      });
      assert.match(unlinked, />Link Tidal</);
      assert.match(unlinked, />Reconnect Tidal</);
    } finally {
      dom.window.close();
    }
  },
);
