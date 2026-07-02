// Determination spec: does `clipboard:copyLayerFragment`'s
// writeBuffer(private-UTI) → writeImage(PNG) sequence actually leave
// BOTH flavors on the macOS pasteboard, or does the trailing
// `writeImage` clobber the private UTI?
//
// Background: `clipboard:copyVideoFile` documents that each Electron
// `clipboard.write*` call wraps a ScopedClipboardWriter that calls
// `[pasteboard clearContents]` on construction — which is why
// `writeText` AFTER `writeBuffer` wipes the earlier write. If that
// generalizes to `writeImage`, then `copyLayerFragment`'s private
// layer-fragment UTI (written first) is silently clobbered by the PNG
// co-write (written second) — meaning PwrSnap→PwrSnap layer paste
// degrades to a flat PNG, and there's a latent bug.
//
// This spec determines the truth empirically against the real
// NSPasteboard. macOS-only — custom-UTI pasteboard semantics don't
// exist on the Linux/Windows clipboards we test elsewhere.

import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { CLIPBOARD_LAYER_FRAGMENT_UTI } from "@pwrsnap/shared";
import { launchPwrSnap } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

async function tinyPngBase64(): Promise<string> {
  const buf = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 12, g: 200, b: 90 } }
  })
    .png()
    .toBuffer();
  return buf.toString("base64");
}

test.describe("layer-fragment clipboard co-write", () => {
  test.skip(!isMac, "custom-UTI pasteboard co-write is macOS-only");

  // The decisive primitive: replicate copyLayerFragment's exact two
  // calls (writeBuffer the real UTI, then writeImage) directly in main
  // and read back whether both survive.
  test("writeBuffer(UTI) then writeImage leaves both flavors on the pasteboard", async () => {
    // KNOWN BUG #259 — confirmed clobbered: the trailing writeImage wipes
    // the UTI written just before it. Marked expected-to-fail so the suite
    // stays green while the bug exists and flips red (prompting removal of
    // this annotation) once the native single-batch write lands.
    test.fail(true, "known bug #259: writeImage clobbers the prior writeBuffer UTI on macOS");
    const app = await launchPwrSnap();
    try {
      const pngBase64 = await tinyPngBase64();
      const probe = await app.electronApp.evaluate(
        ({ clipboard, nativeImage }, payload) => {
          clipboard.clear();
          // Step 1 — private UTI buffer, exactly like copyLayerFragment.
          clipboard.writeBuffer(payload.uti, Buffer.from(payload.fragmentJson, "utf8"));
          const utiBytesAfterBuffer = clipboard.readBuffer(payload.uti).length;
          // Step 2 — co-write the standard PNG, exactly like
          // copyLayerFragment's fallback.
          clipboard.writeImage(
            nativeImage.createFromBuffer(Buffer.from(payload.pngBase64, "base64"))
          );
          return {
            utiBytesAfterBuffer,
            utiBytesAfterImage: clipboard.readBuffer(payload.uti).length,
            hasUti: clipboard.has(payload.uti),
            imageEmpty: clipboard.readImage().isEmpty(),
            formats: clipboard.availableFormats()
          };
        },
        { uti: CLIPBOARD_LAYER_FRAGMENT_UTI, fragmentJson: '{"format_version":1}', pngBase64 }
      );

      // Sanity: the UTI buffer landed after step 1.
      expect(
        probe.utiBytesAfterBuffer,
        `UTI buffer should be present after writeBuffer; probe=${JSON.stringify(probe)}`
      ).toBeGreaterThan(0);

      // Determination 1 — the PNG is on the pasteboard after step 2.
      expect(
        probe.imageEmpty,
        `image should be present after writeImage; probe=${JSON.stringify(probe)}`
      ).toBe(false);

      // Determination 2 — THE question: did the private UTI survive the
      // trailing writeImage, or did writeImage's clearContents wipe it?
      // 0 bytes here ⇒ clobbered ⇒ copyLayerFragment's co-write is a
      // latent bug (paste falls back to flat PNG).
      expect(
        probe.utiBytesAfterImage,
        `private UTI bytes after writeImage (0 = writeImage clobbered the UTI); probe=${JSON.stringify(
          probe
        )}`
      ).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  // The real handler, end-to-end: mint a v2 capture by pasting an image,
  // then copyLayerFragment and check both flavors are on the pasteboard.
  test("clipboard:copyLayerFragment advertises both the UTI and an image", async () => {
    // KNOWN BUG #259 — see note above. The real handler ends with only
    // image/png on the pasteboard; the layer-fragment UTI is clobbered.
    test.fail(true, "known bug #259: copyLayerFragment's PNG co-write clobbers its own UTI");
    const app = await launchPwrSnap();
    try {
      const pngBase64 = await tinyPngBase64();

      // Put a real image on the clipboard, then paste it into the
      // library to get a v2 (bundle-backed) capture copyLayerFragment
      // will accept.
      await app.electronApp.evaluate(({ clipboard, nativeImage }, b64) => {
        clipboard.clear();
        clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(b64, "base64")));
      }, pngBase64);

      const pasted = await app.dispatch("capture:pasteFromClipboard", {});
      expect(pasted.ok, `paste failed: ${JSON.stringify(pasted)}`).toBe(true);
      if (!pasted.ok) return;
      const captureId = pasted.value.id;

      // Clear, then copy the whole layer tree as a fragment.
      await app.electronApp.evaluate(({ clipboard }) => clipboard.clear());
      const copied = await app.dispatch("clipboard:copyLayerFragment", { captureId });
      expect(copied.ok, `copyLayerFragment failed: ${JSON.stringify(copied)}`).toBe(true);

      const probe = await app.electronApp.evaluate(({ clipboard }, uti) => {
        return {
          utiBytes: clipboard.readBuffer(uti).length,
          hasUti: clipboard.has(uti),
          imageEmpty: clipboard.readImage().isEmpty(),
          formats: clipboard.availableFormats()
        };
      }, CLIPBOARD_LAYER_FRAGMENT_UTI);

      expect(
        probe.imageEmpty,
        `image should be present after copyLayerFragment; probe=${JSON.stringify(probe)}`
      ).toBe(false);
      expect(
        probe.utiBytes,
        `layer-fragment UTI should survive the PNG co-write (0 = clobbered); probe=${JSON.stringify(
          probe
        )}`
      ).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
