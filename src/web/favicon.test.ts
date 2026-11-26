import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("favicon is self-contained, shares its alias, and is wired through the shared head and manifest", async () => {
  const svg = await readFile("src/web/public/icon.svg", "utf8");
  assert.equal(svg, await readFile("src/web/public/favicon.svg", "utf8"));
  const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
  const root = dom.window.document.documentElement;
  assert.equal(root.getAttribute("width"), "512");
  assert.equal(root.getAttribute("height"), "512");
  assert.equal(root.getAttribute("viewBox"), "0 0 512 512");
  assert.equal(root.querySelector("rect")?.getAttribute("rx"), "96");
  assert.equal(root.querySelector("rect")?.getAttribute("fill"), "#101827");
  assert.equal(root.querySelector("g")?.getAttribute("fill"), "#a9bded");
  assert.equal(root.querySelector("image,text,foreignObject,use"), null);
  assert.doesNotMatch(svg, /(?:href=|url\(|gradient)/i);
  assert.match(svg, /prefers-color-scheme: light/);
  dom.window.close();
  const head = await ejs.renderFile("src/web/views/head.ejs", { title: "Test", live: false });
  const page = new JSDOM(`<head>${head}</head>`);
  assert(page.window.document.querySelector('link[rel="icon"][href="/static/icon.svg"]'));
  assert(
    page.window.document.querySelector('link[rel="icon"][sizes="any"][href="/static/favicon.svg"]'),
  );
  assert(
    page.window.document.querySelector('link[rel="apple-touch-icon"][href="/static/icon.svg"]'),
  );
  assert.equal(
    page.window.document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    "#101827",
  );
  page.window.close();
  const manifest = JSON.parse(await readFile("src/web/public/manifest.json", "utf8"));
  assert(
    manifest.icons.some(
      (icon: { src: string; sizes: string; type: string }) =>
        icon.src === "/static/icon.svg" && icon.sizes === "any" && icon.type === "image/svg+xml",
    ),
  );
});
