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
    if (!entry.isFile() || ![".ts", ".tsx"].includes(extname(entry.name))) continue;
    if (/\.(?:test|spec)\.tsx?$/.test(entry.name)) continue;
    out.push(path);
  }
  return out;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return node.text;
  }
  return null;
}

describe("renderer shortcut literals", () => {
  test("production UI contains no hard-coded macOS modifier labels", () => {
    const macModifierGlyphs = [0x2318, 0x2325, 0x21e7, 0x2303].map((codePoint) =>
      String.fromCodePoint(codePoint)
    );
    const forbiddenWord = ["C", "m", "d"].join("");
    const violations: string[] = [];

    for (const path of productionSources(RENDERER_ROOT)) {
      const sourceText = readFileSync(path, "utf8");
      const source = ts.createSourceFile(
        path,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      const visit = (node: ts.Node): void => {
        const text = literalText(node);
        if (
          text !== null &&
          (macModifierGlyphs.some((glyph) => text.includes(glyph)) ||
            text.includes(forbiddenWord))
        ) {
          const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(
            `${path.slice(RENDERER_ROOT.length + 1)}:${line + 1}:${character + 1} ${JSON.stringify(
              text.trim()
            )}`
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
