// Exercise the public MCP/OAuth path against the built Electron app. Inference
// is intercepted in the isolated app: no provider credential leaves this test.
// Real FFmpeg, utility rendering, persistence and protected media delivery run.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  SizzleAsset,
  SizzleProject,
  SizzleSpeechTiming,
} from "@pwrsnap/shared";
import type { LocalAgentMcpServerAddress } from "../src/main/local-agents/mcp-server";
import {
  test,
  expect,
  launchPwrSnap,
  type LaunchedApp,
} from "./fixtures/electron-app";

const ffmpeg = [
  process.env.PWRSNAP_FFMPEG_PATH,
  path.resolve(import.meta.dirname, "../build/ffmpeg/ffmpeg"),
].find((candidate): candidate is string =>
  Boolean(candidate && existsSync(candidate)),
);
const capabilities = [
  "sizzle.compose",
  "sizzle.assets.import",
  "sizzle.preview.read",
  "sizzle.full.read",
];

type TestBridge = {
  startLocalAgentMcp: () => Promise<LocalAgentMcpServerAddress>;
  stopLocalAgentMcp: () => Promise<void>;
};
async function startMcp(app: LaunchedApp): Promise<LocalAgentMcpServerAddress> {
  return app.electronApp.evaluate(() =>
    (
      globalThis as unknown as { __PWRSNAP_TEST__: TestBridge }
    ).__PWRSNAP_TEST__.startLocalAgentMcp(),
  );
}

async function authorize(
  app: LaunchedApp,
  address: LocalAgentMcpServerAddress,
): Promise<Client> {
  const endpoint = (route: string) => new URL(route, address.url);
  const callback = "http://127.0.0.1:19191/callback";
  const verifier = "sizzle-mcp-e2e-pkce-verifier-with-at-least-43-characters";
  const registered = await fetch(endpoint("/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Sizzle MCP E2E",
      redirect_uris: [callback],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registered.status).toBe(201);
  const metadata = (await registered.json()) as { client_id: string };
  const authorization = new URL(address.authorizationUrl);
  for (const [key, value] of Object.entries({
    client_id: metadata.client_id,
    redirect_uri: callback,
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: address.url,
    scope: capabilities.join(" "),
    state: "sizzle-audit",
  }))
    authorization.searchParams.set(key, value);
  const started = await fetch(authorization, { redirect: "manual" });
  expect(started.status).toBe(200);
  const html = await started.text();
  const next = html.match(
    /<meta http-equiv="refresh" content="1;url=([^"]+)">/,
  );
  expect(next).not.toBeNull();
  const status = new URL(next![1]!.replaceAll("&amp;", "&"), address.url);
  // Consent comes from the actual native window, with its real IPC sender.
  await expect
    .poll(() =>
      app.electronApp
        .windows()
        .find((win) => win.url().includes("local-agent-consent"))
        ?.url(),
    )
    .toBeTruthy();
  const consent = app.electronApp
    .windows()
    .find((win) => win.url().includes("local-agent-consent"))!;
  await consent.getByRole("radio", { name: /Custom role/ }).check();
  await expect(consent.getByRole("checkbox")).toHaveCount(capabilities.length);
  for (const checkbox of await consent.getByRole("checkbox").all())
    await checkbox.check();
  await consent
    .getByRole("button", { name: "Allow access", exact: true })
    .click();
  let redirect: Response | null = null;
  await expect
    .poll(async () => {
      redirect = await fetch(status, { redirect: "manual" });
      return redirect.status;
    })
    .toBe(302);
  const location = new URL(
    (redirect as Response | null)!.headers.get("location")!,
  );
  expect(location.searchParams.get("state")).toBe("sizzle-audit");
  const exchanged = await fetch(endpoint("/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: metadata.client_id,
      code: location.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: callback,
      resource: address.url,
    }),
  });
  expect(exchanged.status).toBe(200);
  const tokens = (await exchanged.json()) as { access_token: string };
  const client = new Client({ name: "Sizzle MCP audit", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(address.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
    }) as unknown as Transport,
  );
  return client;
}
function value<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  if (result.isError) {
    const error = result.structuredContent as
      { error?: { code?: string } } | undefined;
    throw new Error(`MCP tool failed: ${error?.error?.code ?? "tool_error"}`);
  }
  return result.structuredContent as T;
}
async function media(
  result: Awaited<ReturnType<Client["callTool"]>>,
  mime: string,
): Promise<Buffer> {
  const link = (result as CallToolResult).content.find(
    (item) => item.type === "resource_link",
  );
  expect(link?.type).toBe("resource_link");
  if (link?.type !== "resource_link")
    throw new Error("Missing protected media");
  const delivered = await fetch(link.uri);
  expect(delivered.status).toBe(200);
  expect(delivered.headers.get("content-type")).toContain(mime);
  return Buffer.from(await delivered.arrayBuffer());
}

test("MCP authors, aligns, reviews, renders and revises a continuous narrated reel", async ({}, testInfo) => {
  test.setTimeout(120_000);
  if (process.env.PWRSNAP_E2E_REQUIRE_SIZZLE_MCP === "1") {
    expect(process.platform).toBe("darwin");
    expect(
      ffmpeg,
      "The required MCP movie audit must not silently skip",
    ).toBeTruthy();
  }
  test.skip(
    process.platform !== "darwin" || !ffmpeg,
    "Requires the vetted macOS encoder and native secure storage",
  );
  const app = await launchPwrSnap({ env: { PWRSNAP_FFMPEG_PATH: ffmpeg } });
  let client: Client | null = null;
  try {
    const imagePath = path.join(app.homeRoot, "logo.png");
    await writeFile(
      imagePath,
      await sharp({
        create: { width: 80, height: 80, channels: 3, background: "#ff8a1f" },
      })
        .png()
        .toBuffer(),
    );
    const videoPath = path.join(app.homeRoot, "motion.mov"),
      voicePath = path.join(app.homeRoot, "voice.wav");
    execFileSync(ffmpeg!, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=2.4",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ]);
    execFileSync(ffmpeg!, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=24000:duration=2.4",
      "-c:a",
      "pcm_s16le",
      voicePath,
    ]);
    const wav = [...(await readFile(voicePath))];
    await app.electronApp.evaluate((_electron, bytes) => {
      const original = globalThis.fetch.bind(globalThis);
      const state = {
        speech: 0,
        timedTranscripts: 0,
        transcripts: 0,
        inputs: [] as string[],
        latest: "",
      };
      (
        globalThis as unknown as { __SIZZLE_MCP_INFERENCE__: typeof state }
      ).__SIZZLE_MCP_INFERENCE__ = state;
      globalThis.fetch = async (input, options) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url === "https://api.openai.com/v1/audio/speech") {
          const body = JSON.parse(String(options?.body)) as {
            input: string;
            voice: string;
            instructions: string;
            speed: number;
          };
          if (
            body.voice !== "ash" ||
            body.speed !== 1.2 ||
            body.instructions !== "FAST launch delivery"
          )
            throw new Error("Speech controls lost at MCP boundary");
          state.speech++;
          state.latest = body.input;
          state.inputs.push(body.input);
          const audio = Buffer.from(bytes);
          const start = audio.indexOf(Buffer.from("data")) + 8;
          for (
            let i = start;
            i + 2 < Math.min(start + 4000, audio.length);
            i += 2
          )
            audio.writeInt16LE(
              Math.round(audio.readInt16LE(i) * (1 + state.speech / 100)),
              i,
            );
          return new Response(audio, {
            headers: { "content-type": "audio/wav" },
          });
        }
        if (url === "https://api.openai.com/v1/audio/transcriptions") {
          const form = options?.body as FormData;
          if (form.get("response_format") === "verbose_json") {
            state.timedTranscripts++;
            return Response.json({
              words: state.latest.split(/\s+/).map((word, i) => ({
                word,
                start: i * 0.2,
                end: (i + 1) * 0.2,
              })),
            });
          }
          state.transcripts++;
          return Response.json({ text: state.latest });
        }
        return original(input, options);
      };
    }, wav);
    const secret = await app.dispatch("settings:replaceSecret", {
      name: "openaiApiKey",
      value: "e2e-not-a-real-provider-key",
    });
    expect(secret.ok).toBe(true);
    expect(
      (await app.dispatch("settings:write", { localAgents: { enabled: true } }))
        .ok,
    ).toBe(true);
    const address = await startMcp(app);
    expect(address.port).not.toBe(51729);
    client = await authorize(app, address);
    const mcp = client;
    const call = (name: string, args: Record<string, unknown>) =>
      mcp.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      "create",
      "get",
      "import",
      "apply_launch_template",
      "update",
      "set_bindings",
      "align_narration",
      "prepare_narration",
      "inspect_frames",
      "render_preview",
      "render_full",
      "audio_qa",
    ])
      expect(names).toContain("pwrsnap_sizzle_" + name);
    for (const name of [
      "pwrsnap_video_inspect",
      "pwrsnap_video_edit",
      "pwrsnap_library_search",
      "pwrsnap_sizzle_import_capture",
    ])
      expect(names).toContain(name);
    const created = value<{ projectId: string }>(
      await call("pwrsnap_sizzle_create", { name: "MCP launch audit" }),
    );
    const projectId = created.projectId;
    const logo = value<SizzleAsset>(
      await call("pwrsnap_sizzle_import", { projectId, path: imagePath }),
    );
    const video = value<SizzleAsset>(
      await call("pwrsnap_sizzle_import", { projectId, path: videoPath }),
    );
    const voice = value<SizzleAsset>(
      await call("pwrsnap_sizzle_import", { projectId, path: voicePath }),
    );
    expect([logo.kind, video.kind, voice.kind]).toEqual([
      "image",
      "video",
      "audio",
    ]);
    const get = async () =>
      value<SizzleProject>(await call("pwrsnap_sizzle_get", { projectId }));
    let project = await get();
    project = value<SizzleProject>(
      await call("pwrsnap_sizzle_apply_launch_template", {
        projectId,
        expectedModifiedAt: project.modifiedAt,
        template: {
          productName: "PwrDisk",
          tagline: "Done",
          url: "example.test",
          logo: logo.id,
          overviewVideo: video.id,
          featuresVideo: video.id,
          workflowVideo: video.id,
          safetyVideo: video.id,
          resultVideo: video.id,
          intro: "Intro",
          context: "Context",
          handoff: "Handoff",
          features: ["Fast"],
          metricValue: 42,
          metricLabel: "files",
          metricResult: "Done",
          terminalLines: ["tool_run"],
          workflowCaption: "Review",
          safetyHeadline: "Protected",
          safetyLines: ["Protected"],
          confirmation: "I mean it",
          resultCaption: "Done",
          narrationText:
            "PwrDisk context handoff features {{metricValue}} workflow safety result end",
          pronunciation: { PwrDisk: "Power Disk" },
          delivery: "FAST launch delivery",
        },
      }),
    );
    const timeline = project.timeline!;
    expect(
      timeline.audio.filter((track) => track.role === "voice"),
    ).toHaveLength(1);
    const source = timeline.audio.find(
      (track) => track.role === "voice",
    )!.source;
    if (source.kind !== "speech")
      throw new Error("Expected generated narration");
    source.speed = 1.2;
    for (const scene of timeline.scenes)
      for (const layer of scene.layers)
        if (layer.kind === "video") layer.sourceStartSec = 0.1;
    project = value<SizzleProject>(
      await call("pwrsnap_sizzle_update", {
        projectId,
        timeline,
        expectedModifiedAt: project.modifiedAt,
      }),
    );
    const preparation = await call("pwrsnap_sizzle_prepare_narration", {
      projectId,
      expectedModifiedAt: project.modifiedAt,
    });
    const prepared = value<
      SizzleProject & {
        asset: SizzleAsset;
        timing: SizzleSpeechTiming;
        expectedText: string;
      }
    >(preparation);
    expect(prepared.asset.kind).toBe("audio");
    expect(prepared.timing.quality).toBe("precise");
    const audition = await media(preparation, "audio/wav");
    expect(audition.subarray(0, 4).toString()).toBe("RIFF");
    await writeFile(testInfo.outputPath("mcp-narration.wav"), audition);
    project = await get();
    expect(
      project.assets?.some((asset) => asset.id === prepared.asset.id),
    ).toBe(true);
    const cues = [
      "context",
      "handoff",
      "features",
      "benchmark",
      "workflow",
      "safety",
      "result",
      "end",
    ].map((sceneId) => ({
      sceneId,
      phrase: sceneId === "benchmark" ? "42" : sceneId,
    }));
    const aligned = value<
      SizzleProject & { narrationTiming: SizzleSpeechTiming }
    >(
      await call("pwrsnap_sizzle_align_narration", {
        projectId,
        cues,
        expectedModifiedAt: project.modifiedAt,
      }),
    );
    expect(aligned.narrationTiming.quality).toBe("precise");
    expect(
      aligned.narrationTiming.words.map((word) => word.word).join(" "),
    ).toBe("Power Disk context handoff features 42 workflow safety result end");
    expect(
      aligned.timeline!.audio.filter((track) => track.role === "voice"),
    ).toHaveLength(1);
    const last =
      aligned.timeline!.scenes.reduce(
        (sum, scene) => sum + scene.durationFrames,
        0,
      ) - 1;
    const frames = await call("pwrsnap_sizzle_inspect_frames", {
      projectId,
      frames: [0, 12, last],
    });
    const png = await media(frames, "image/png");
    expect((await sharp(png).metadata()).width).toBe(1920);
    await writeFile(testInfo.outputPath("mcp-contact.png"), png);
    const preview = await call("pwrsnap_sizzle_render_preview", { projectId });
    expect(value<{ renderedScenes: number }>(preview).renderedScenes).toBe(9);
    const full = await call("pwrsnap_sizzle_render_full", { projectId });
    const movie = await media(full, "video/mp4");
    expect(movie.length).toBeGreaterThan(1000);
    await writeFile(testInfo.outputPath("mcp-reel.mp4"), movie);
    const qa = value<{
      matches: boolean;
      integratedLufs: number;
      truePeakDb: number;
    }>(await call("pwrsnap_sizzle_audio_qa", { projectId }));
    expect(qa.matches).toBe(true);
    expect(qa.integratedLufs).toBeGreaterThan(-16);
    expect(qa.truePeakDb).toBeLessThan(0);
    project = await get();
    project = value<SizzleProject>(
      await call("pwrsnap_sizzle_set_bindings", {
        projectId,
        bindings: { metricValue: 43 },
        expectedModifiedAt: project.modifiedAt,
      }),
    );
    const revisedCues = cues.map((cue) =>
      cue.sceneId === "benchmark" ? { ...cue, phrase: "43" } : cue,
    );
    await call("pwrsnap_sizzle_align_narration", {
      projectId,
      cues: revisedCues,
      expectedModifiedAt: project.modifiedAt,
    });
    const revised = value<{ renderedScenes: number; cachedScenes: number }>(
      await call("pwrsnap_sizzle_render_preview", { projectId }),
    );
    expect(revised).toMatchObject({ renderedScenes: 1, cachedScenes: 8 });
    const requests = await app.electronApp.evaluate(
      () =>
        (
          globalThis as unknown as {
            __SIZZLE_MCP_INFERENCE__: {
              speech: number;
              timedTranscripts: number;
              inputs: string[];
            };
          }
        ).__SIZZLE_MCP_INFERENCE__,
    );
    expect(requests.speech).toBe(2);
    expect(requests.timedTranscripts).toBe(2);
    expect(requests.inputs).toEqual([
      "Power Disk context handoff features 42 workflow safety result end",
      "Power Disk context handoff features 43 workflow safety result end",
    ]);
    await writeFile(
      testInfo.outputPath("mcp-audit.json"),
      JSON.stringify(
        {
          tools: names,
          scenes: 9,
          continuousVoiceTracks: 1,
          originalDurationSec: value<{ durationSec: number }>(full).durationSec,
          revised,
          qa,
          inference: "intercepted in test; real media pipeline",
          requests,
        },
        null,
        2,
      ),
    );
  } finally {
    await client?.close();
    await app.electronApp
      .evaluate(async () =>
        (
          globalThis as unknown as { __PWRSNAP_TEST__: TestBridge }
        ).__PWRSNAP_TEST__.stopLocalAgentMcp(),
      )
      .catch(() => undefined);
    await app.close();
  }
});
