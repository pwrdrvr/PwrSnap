// Source contract for the fast tooltip (lib/useFastTooltip.tsx).
//
// A control that opts into it with `data-tip` must not ALSO show the slow
// native tooltip, which is what `title` draws. That happens two ways: the
// element carries both, or it sits inside an element that carries `title`
// (or has a descendant that does). Either way the user gets two tooltips,
// one ~3s after the other. And the tooltip is a description, not the
// name, so an icon-only control that opts in must still be named.
//
// This reads JSX, so it sees what is written, not what renders: a `title`
// passed through a component prop or a spread is invisible to it. Those
// are the reviewer's.

import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const RENDERER_ROOT = join(process.cwd(), "apps/desktop/src/renderer/src");

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...productionSources(path));
      continue;
    }
    if (!entry.isFile() || extname(entry.name) !== ".tsx") continue;
    if (/\.(?:test|spec)\.tsx$/.test(entry.name)) continue;
    out.push(path);
  }
  return out;
}

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function isIntrinsic(node: Opening, source: ts.SourceFile): boolean {
  return /^[a-z]/.test(node.tagName.getText(source));
}

function attr(node: Opening, source: ts.SourceFile, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(source) === name
  );
}

/** `title={cond ? "x" : undefined}` still sets a title on some renders. */
function setsAttr(node: Opening, source: ts.SourceFile, name: string): boolean {
  const a = attr(node, source, name);
  if (a === undefined) return false;
  const init = a.initializer;
  if (init === undefined) return true;
  if (ts.isJsxExpression(init) && init.expression !== undefined) {
    const text = init.expression.getText(source);
    return text !== "undefined" && text !== "null";
  }
  return true;
}

function openingOf(node: ts.Node): Opening | null {
  if (ts.isJsxSelfClosingElement(node)) return node;
  if (ts.isJsxElement(node)) return node.openingElement;
  return null;
}

/** Could this subtree render text a screen reader would use as the name?
 *  Lenient: any `{expression}` counts, since it may be a string. */
function mayRenderText(node: ts.Node, source: ts.SourceFile): boolean {
  if (ts.isJsxText(node)) return node.text.trim() !== "";
  if (ts.isJsxExpression(node)) {
    const e = node.expression;
    if (e === undefined) return false;
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) {
      return mayRenderText(e, source);
    }
    return true;
  }
  const opening = openingOf(node);
  if (opening !== null) {
    if (opening.tagName.getText(source) === "svg") return false;
    if (attr(opening, source, "aria-hidden") !== undefined) return false;
    if (attr(opening, source, "aria-label") !== undefined) return true;
    const cls = attr(opening, source, "className")?.initializer?.getText(source) ?? "";
    if (cls.includes("sr-only")) return true;
  }
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
    return node.children.some((c) => mayRenderText(c, source));
  }
  return false;
}

type Finding = { readonly at: string; readonly what: string };

type Scan = { both: Finding[]; nested: Finding[]; unnamed: Finding[]; tipped: number };

function scan(files: readonly { name: string; text: string }[]): Scan {
  const both: Finding[] = [];
  const nested: Finding[] = [];
  const unnamed: Finding[] = [];
  let tipped = 0;

  for (const { name, text } of files) {
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const where = (node: ts.Node): string => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      return `${name}:${line + 1}`;
    };

    // `tipAncestor` / `titleAncestor`: the nearest enclosing intrinsic
    // element in the same JSX tree that sets the attribute.
    const visit = (node: ts.Node, tipAncestor: ts.Node | null, titleAncestor: ts.Node | null): void => {
      const opening = openingOf(node);
      if (opening !== null && isIntrinsic(opening, source)) {
        const tag = opening.tagName.getText(source);
        const hasTip = setsAttr(opening, source, "data-tip");
        const hasTitle = setsAttr(opening, source, "title");
        if (hasTip) tipped += 1;
        if (hasTip && hasTitle) both.push({ at: where(opening), what: `<${tag}> has data-tip and title` });
        if (hasTitle && tipAncestor !== null) {
          nested.push({ at: where(opening), what: `<${tag} title> inside data-tip at ${where(tipAncestor)}` });
        }
        if (hasTip && titleAncestor !== null) {
          nested.push({ at: where(opening), what: `<${tag} data-tip> inside title at ${where(titleAncestor)}` });
        }
        const interactive =
          tag === "button" || tag === "a" || attr(opening, source, "role") !== undefined;
        if (
          hasTip &&
          interactive &&
          attr(opening, source, "aria-label") === undefined &&
          attr(opening, source, "aria-labelledby") === undefined &&
          !opening.attributes.properties.some(ts.isJsxSpreadAttribute) &&
          !(ts.isJsxElement(node) && node.children.some((c) => mayRenderText(c, source)))
        ) {
          unnamed.push({ at: where(opening), what: `<${tag} data-tip> has no aria-label or text` });
        }
        const nextTip = hasTip ? opening : tipAncestor;
        const nextTitle = hasTitle ? opening : titleAncestor;
        ts.forEachChild(node, (child) => visit(child, nextTip, nextTitle));
        return;
      }
      // A component boundary or a non-JSX node: a `{...}` callback inside
      // JSX still renders into the same element, so keep the ancestors
      // across expressions, and drop them only at a function body that is
      // not inline JSX (a separate component's return).
      if (ts.isFunctionDeclaration(node)) {
        ts.forEachChild(node, (child) => visit(child, null, null));
        return;
      }
      ts.forEachChild(node, (child) => visit(child, tipAncestor, titleAncestor));
    };
    visit(source, null, null);
  }
  return { both, nested, unnamed, tipped };
}

const result = scan(
  productionSources(RENDERER_ROOT).map((path) => ({
    name: path.slice(RENDERER_ROOT.length + 1),
    text: readFileSync(path, "utf8")
  }))
);
const show = (list: readonly Finding[]): string => list.map((f) => `${f.at}  ${f.what}`).join("\n");

describe("fast tooltip source contract", () => {
  test("finds the opted-in controls (the scan itself is working)", () => {
    expect(result.tipped).toBeGreaterThan(50);
  });

  test("each rule fires on a fixture that breaks it", () => {
    const fixture = scan([
      {
        name: "Fixture.tsx",
        text: `
          export function Fixture({ on }: { on: boolean }) {
            return (
              <div title={on ? "Row" : undefined}>
                <button data-tip="Both" title="Both" aria-label="Both" />
                <span data-tip="Inside a title">x</span>
                <button data-tip="Outer" aria-label="Outer">
                  <svg aria-hidden="true"><path d="M0 0" /></svg>
                  <img title="Inner" alt="" />
                </button>
                <button data-tip="Unnamed"><svg /></button>
                <button data-tip="Named by text">Save</button>
                <button data-tip="Named for readers"><span className="sr-only">Reveal</span></button>
              </div>
            );
          }
        `
      }
    ]);
    expect(fixture.both.map((f) => f.at)).toEqual(["Fixture.tsx:5"]);
    expect(fixture.nested.map((f) => f.at)).toEqual([
      "Fixture.tsx:5",
      "Fixture.tsx:6",
      "Fixture.tsx:7",
      "Fixture.tsx:9",
      "Fixture.tsx:11",
      "Fixture.tsx:12",
      "Fixture.tsx:13"
    ]);
    expect(fixture.unnamed.map((f) => f.at)).toEqual(["Fixture.tsx:11"]);
  });

  test("no element carries both data-tip and title", () => {
    expect(result.both, show(result.both)).toEqual([]);
  });

  test("no title is nested inside a data-tip control, or the other way round", () => {
    expect(result.nested, show(result.nested)).toEqual([]);
  });

  test("every opted-in control still has a name of its own", () => {
    expect(result.unnamed, show(result.unnamed)).toEqual([]);
  });
});
