import { describe, expect, test } from "vitest";
import { findRemoteScript, isRendererHtmlEntry } from "./packaged-html-rules.mjs";

describe("packaged HTML rules", () => {
  test("scopes the scan to the app's own renderer HTML", () => {
    expect(isRendererHtmlEntry("/out/renderer/index.html")).toBe(true);
    expect(isRendererHtmlEntry("/out/renderer/index.htm")).toBe(true);
  });

  test("ignores dependency HTML the app never loads", () => {
    // electron-builder auto-includes the production node_modules tree. A
    // dependency's playground page pointing at a CDN is not a packaging
    // defect in this repository, and failing a release on it would tell the
    // operator to unset a flag that has nothing to do with the file.
    expect(isRendererHtmlEntry("/node_modules/some-dep/demo/playground.html")).toBe(
      false
    );
    expect(isRendererHtmlEntry("/out/renderer/assets/index.js")).toBe(false);
  });

  test("detects the DevTools bridge the gate exists to stop", () => {
    // The returned snippet is what the failure message prints, so it has to
    // carry enough of the tag for an operator to recognize the offender.
    const snippet = findRemoteScript('<script src="http://localhost:8097"></script>');
    expect(snippet).toContain("<script");
    expect(snippet).toContain("http://localhost:8097");
  });

  test("carries the whole URL into the snippet, not just the protocol", () => {
    // The rule is written against the shape, so the offender is often NOT the
    // DevTools bridge the remediation text names. A snippet that stopped at
    // `//` would leave the operator with a filename, a protocol, and advice
    // about a flag that has nothing to do with their file.
    expect(
      findRemoteScript('<script src="https://cdn.jsdelivr.net/npm/thing@1/x.js"></script>')
    ).toContain("cdn.jsdelivr.net/npm/thing@1/x.js");
    expect(findRemoteScript('<script src="//cdn.example.com/x.js"></script>')).toContain(
      "cdn.example.com/x.js"
    );
    // Stops at the quote — the closing tag is not part of the offender.
    expect(findRemoteScript('<script src="https://cdn.example.com/x.js"></script>')).not.toContain(
      "</script>"
    );
  });

  test("detects remote scripts across quoting and protocol forms", () => {
    for (const markup of [
      `<script src='https://cdn.example.com/x.js'></script>`,
      `<script src=https://cdn.example.com/x.js></script>`,
      `<script src="//cdn.example.com/x.js"></script>`,
      `<script\n  type="module"\n  src="https://cdn.example.com/x.js"\n></script>`,
      `<script defer SRC = "HTTP://cdn.example.com/x.js"></script>`
    ]) {
      expect(findRemoteScript(markup)).not.toBeNull();
    }
  });

  test("leaves local scripts alone", () => {
    for (const markup of [
      `<script type="module" src="/src/main.tsx"></script>`,
      `<script type="module" crossorigin src="./assets/index-CoI8uv1N.js"></script>`,
      `<script>console.info("http://localhost:8097")</script>`
    ]) {
      expect(findRemoteScript(markup)).toBeNull();
    }
  });

  test("does not mistake hyphenated attributes for a src", () => {
    // `\bsrc` would match after the hyphen, failing a release over a
    // lazy-loading placeholder that loads nothing.
    expect(
      findRemoteScript('<script data-src="https://cdn.example.com/x.js"></script>')
    ).toBeNull();
  });
});
