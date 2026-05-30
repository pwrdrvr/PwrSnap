import { nanoid } from "nanoid";
import type {
  AiEnrichmentTriggerSource,
  AiRunMediaInput,
  AiRunMediaTransform,
  AiRunSnapshot,
  AiRunStatus,
  AiRunUsageDetail,
  AiUsageCostEstimate,
  AiUsagePriceStatus,
  AiUsageRateSnapshot,
  AiUsageRunListItem,
  AiUsageRunsPage,
  AiUsageStatus,
  AiUsageSummary,
  AiUsageSummaryBucket,
  AiUsageThreadSurface,
  AiUsageSummaryWindow,
  AiUsageTokenBreakdown
} from "@pwrsnap/shared";
import { getDb } from "./db";

type AiRunJoinedRow = {
  id: string;
  capture_id: string | null;
  kind: "enrich" | "chat";
  task: string;
  trigger_source: AiEnrichmentTriggerSource;
  selected_model: string | null;
  status: AiRunStatus;
  error: string | null;
  latency_ms: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type AiRunUsageRow = {
  ai_run_id: string;
  thread_id: string | null;
  turn_id: string | null;
  model: string | null;
  model_provider: string | null;
  service_tier: string | null;
  usage_status: AiUsageStatus;
  usage_unavailable_reason: string | null;
  total_tokens: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  model_context_window: number | null;
  price_status: AiUsagePriceStatus;
  price_unavailable_reason: string | null;
  currency: "USD" | null;
  catalog_version: string | null;
  pricing_source_url: string | null;
  priced_at: string | null;
  rate_snapshot_json: string | null;
  uncached_input_tokens: number | null;
  estimated_uncached_input_cost_micros: number | null;
  estimated_cached_input_cost_micros: number | null;
  estimated_output_cost_micros: number | null;
  estimated_total_cost_micros: number | null;
};

type AiRunUsageListRow = AiRunJoinedRow & Partial<AiRunUsageRow>;

type AiThreadUsageRow = {
  thread_id: string;
  surface: AiUsageThreadSurface;
  anchor_id: string | null;
  name: string;
  task: string;
  trigger_source: AiEnrichmentTriggerSource;
  turn_count: number;
  usage_unavailable_count: number;
  price_unavailable_count: number;
  last_turn_id: string | null;
  model: string | null;
  model_provider: string | null;
  service_tier: string | null;
  total_tokens: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  model_context_window: number | null;
  currency: "USD" | null;
  catalog_version: string | null;
  pricing_source_url: string | null;
  priced_at: string | null;
  rate_snapshot_json: string | null;
  uncached_input_tokens: number;
  estimated_uncached_input_cost_micros: number;
  estimated_cached_input_cost_micros: number;
  estimated_output_cost_micros: number;
  estimated_total_cost_micros: number;
  created_at: string;
  updated_at: string;
};

type AiUsageActivityListRow = AiRunUsageListRow & {
  subject_kind: "run" | "thread";
  thread_id: string | null;
  thread_name: string | null;
  thread_surface: AiUsageThreadSurface | null;
  turn_count: number | null;
  activity_at: string;
};

export type AiRunUsagePriceRepairRow = {
  aiRunId: string;
  model: string | null;
  modelProvider: string | null;
  serviceTier: string | null;
  tokens: AiUsageTokenBreakdown | null;
};

type AiRunMediaInputRow = {
  id: string;
  ai_run_id: string;
  ordinal: number;
  role: string;
  transform: AiRunMediaTransform;
  source_mime_type: string | null;
  sent_mime_type: string;
  format: string;
  encoder: string | null;
  quality: number | null;
  source_width_px: number | null;
  source_height_px: number | null;
  sent_width_px: number;
  sent_height_px: number;
  sent_byte_size: number;
  max_edge_px: number | null;
  max_bytes: number | null;
  scale_ratio: number | null;
  video_position_pct: number | null;
  video_timestamp_sec: number | null;
  created_at: string;
};

export type SaveAiRunUsageInput = {
  aiRunId: string;
  threadId?: string | null;
  turnId?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  usageStatus: AiUsageStatus;
  usageUnavailableReason?: string | null;
  tokens?: AiUsageTokenBreakdown | null;
  cost: AiUsageCostEstimate;
};

export type SaveAiThreadUsageInput = {
  threadId: string;
  surface: AiUsageThreadSurface;
  anchorId?: string | null;
  name: string;
  turnId?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  usageStatus: AiUsageStatus;
  usageUnavailableReason?: string | null;
  tokens?: AiUsageTokenBreakdown | null;
  cost: AiUsageCostEstimate;
};

export type SaveAiRunMediaInput = {
  ordinal: number;
  role: string;
  transform: AiRunMediaTransform;
  sourceMimeType?: string | null;
  sentMimeType: string;
  format: string;
  encoder?: string | null;
  quality?: number | null;
  sourceWidthPx?: number | null;
  sourceHeightPx?: number | null;
  sentWidthPx: number;
  sentHeightPx: number;
  sentByteSize: number;
  maxEdgePx?: number | null;
  maxBytes?: number | null;
  scaleRatio?: number | null;
  videoPositionPct?: number | null;
  videoTimestampSec?: number | null;
};

function rowToRun(row: AiRunJoinedRow): AiRunSnapshot {
  return {
    id: row.id,
    captureId: row.capture_id,
    kind: row.kind,
    task: row.task,
    triggerSource: row.trigger_source,
    selectedModel: row.selected_model,
    status: row.status,
    error: row.error,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function rowToTokens(row: AiRunUsageRow): AiUsageTokenBreakdown | null {
  if (row.usage_status !== "available") return null;
  if (
    row.total_tokens === null ||
    row.input_tokens === null ||
    row.cached_input_tokens === null ||
    row.output_tokens === null ||
    row.reasoning_output_tokens === null
  ) {
    return null;
  }
  return {
    totalTokens: row.total_tokens,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    modelContextWindow: row.model_context_window
  };
}

function rowToCost(row: AiRunUsageRow): AiUsageCostEstimate {
  if (row.price_status !== "available") {
    return {
      status: "unavailable",
      reason: row.price_unavailable_reason ?? "price unavailable"
    };
  }
  const rateSnapshot = parseRateSnapshot(row.rate_snapshot_json);
  return {
    status: "available",
    currency: row.currency ?? "USD",
    catalogVersion: row.catalog_version ?? "",
    pricingSourceUrl: row.pricing_source_url ?? "",
    pricedAt: row.priced_at ?? "",
    rateSnapshot,
    uncachedInputTokens: row.uncached_input_tokens ?? 0,
    cachedInputTokens: row.cached_input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    uncachedInputCostMicros: row.estimated_uncached_input_cost_micros ?? 0,
    cachedInputCostMicros: row.estimated_cached_input_cost_micros ?? 0,
    outputCostMicros: row.estimated_output_cost_micros ?? 0,
    totalCostMicros: row.estimated_total_cost_micros ?? 0
  };
}

function parseRateSnapshot(value: string | null): AiUsageRateSnapshot {
  if (value === null) {
    return {
      model: "",
      serviceTier: null,
      contextClass: null,
      inputUsdPerMillion: 0,
      cachedInputUsdPerMillion: 0,
      outputUsdPerMillion: 0
    };
  }
  return JSON.parse(value) as AiUsageRateSnapshot;
}

function rowToMediaInput(row: AiRunMediaInputRow): AiRunMediaInput {
  return {
    id: row.id,
    aiRunId: row.ai_run_id,
    ordinal: row.ordinal,
    role: row.role,
    transform: row.transform,
    sourceMimeType: row.source_mime_type,
    sentMimeType: row.sent_mime_type,
    format: row.format,
    encoder: row.encoder,
    quality: row.quality,
    sourceWidthPx: row.source_width_px,
    sourceHeightPx: row.source_height_px,
    sentWidthPx: row.sent_width_px,
    sentHeightPx: row.sent_height_px,
    sentByteSize: row.sent_byte_size,
    maxEdgePx: row.max_edge_px,
    maxBytes: row.max_bytes,
    scaleRatio: row.scale_ratio,
    videoPositionPct: row.video_position_pct,
    videoTimestampSec: row.video_timestamp_sec,
    createdAt: row.created_at
  };
}

export function saveAiRunUsage(input: SaveAiRunUsageInput): void {
  const tokens = input.tokens ?? null;
  const cost = input.cost;
  getDb()
    .prepare(
      `INSERT INTO ai_run_usage (
        ai_run_id, thread_id, turn_id, model, model_provider, service_tier,
        usage_status, usage_unavailable_reason,
        total_tokens, input_tokens, cached_input_tokens, output_tokens,
        reasoning_output_tokens, model_context_window,
        price_status, price_unavailable_reason, currency, catalog_version,
        pricing_source_url, priced_at, rate_snapshot_json, uncached_input_tokens,
        estimated_uncached_input_cost_micros, estimated_cached_input_cost_micros,
        estimated_output_cost_micros, estimated_total_cost_micros
      ) VALUES (
        @aiRunId, @threadId, @turnId, @model, @modelProvider, @serviceTier,
        @usageStatus, @usageUnavailableReason,
        @totalTokens, @inputTokens, @cachedInputTokens, @outputTokens,
        @reasoningOutputTokens, @modelContextWindow,
        @priceStatus, @priceUnavailableReason, @currency, @catalogVersion,
        @pricingSourceUrl, @pricedAt, @rateSnapshotJson, @uncachedInputTokens,
        @estimatedUncachedInputCostMicros, @estimatedCachedInputCostMicros,
        @estimatedOutputCostMicros, @estimatedTotalCostMicros
      )
      ON CONFLICT(ai_run_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        model = excluded.model,
        model_provider = excluded.model_provider,
        service_tier = excluded.service_tier,
        usage_status = excluded.usage_status,
        usage_unavailable_reason = excluded.usage_unavailable_reason,
        total_tokens = excluded.total_tokens,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        model_context_window = excluded.model_context_window,
        price_status = excluded.price_status,
        price_unavailable_reason = excluded.price_unavailable_reason,
        currency = excluded.currency,
        catalog_version = excluded.catalog_version,
        pricing_source_url = excluded.pricing_source_url,
        priced_at = excluded.priced_at,
        rate_snapshot_json = excluded.rate_snapshot_json,
        uncached_input_tokens = excluded.uncached_input_tokens,
        estimated_uncached_input_cost_micros = excluded.estimated_uncached_input_cost_micros,
        estimated_cached_input_cost_micros = excluded.estimated_cached_input_cost_micros,
        estimated_output_cost_micros = excluded.estimated_output_cost_micros,
        estimated_total_cost_micros = excluded.estimated_total_cost_micros,
        updated_at = datetime('now')`
    )
    .run({
      aiRunId: input.aiRunId,
      threadId: input.threadId ?? null,
      turnId: input.turnId ?? null,
      model: input.model ?? null,
      modelProvider: input.modelProvider ?? null,
      serviceTier: input.serviceTier ?? null,
      usageStatus: input.usageStatus,
      usageUnavailableReason: input.usageUnavailableReason ?? null,
      totalTokens: tokens?.totalTokens ?? null,
      inputTokens: tokens?.inputTokens ?? null,
      cachedInputTokens: tokens?.cachedInputTokens ?? null,
      outputTokens: tokens?.outputTokens ?? null,
      reasoningOutputTokens: tokens?.reasoningOutputTokens ?? null,
      modelContextWindow: tokens?.modelContextWindow ?? null,
      priceStatus: cost.status,
      priceUnavailableReason: cost.status === "unavailable" ? cost.reason : null,
      currency: cost.status === "available" ? cost.currency : null,
      catalogVersion: cost.status === "available" ? cost.catalogVersion : null,
      pricingSourceUrl: cost.status === "available" ? cost.pricingSourceUrl : null,
      pricedAt: cost.status === "available" ? cost.pricedAt : null,
      rateSnapshotJson:
        cost.status === "available" ? JSON.stringify(cost.rateSnapshot) : null,
      uncachedInputTokens: cost.status === "available" ? cost.uncachedInputTokens : null,
      estimatedUncachedInputCostMicros:
        cost.status === "available" ? cost.uncachedInputCostMicros : null,
      estimatedCachedInputCostMicros:
        cost.status === "available" ? cost.cachedInputCostMicros : null,
      estimatedOutputCostMicros: cost.status === "available" ? cost.outputCostMicros : null,
      estimatedTotalCostMicros: cost.status === "available" ? cost.totalCostMicros : null
    });
}

export function saveAiThreadUsage(input: SaveAiThreadUsageInput): void {
  const tokens = input.tokens ?? null;
  const cost = input.cost;
  const triggerSource: AiEnrichmentTriggerSource =
    input.surface === "sizzle-chat" ? "sizzle-chat" : "library-chat";
  getDb()
    .prepare(
      `INSERT INTO ai_thread_usage (
        thread_id, surface, anchor_id, name, task, trigger_source,
        turn_count, usage_unavailable_count, price_unavailable_count,
        last_turn_id, model, model_provider, service_tier,
        total_tokens, input_tokens, cached_input_tokens, output_tokens,
        reasoning_output_tokens, model_context_window,
        currency, catalog_version, pricing_source_url, priced_at,
        rate_snapshot_json, uncached_input_tokens,
        estimated_uncached_input_cost_micros, estimated_cached_input_cost_micros,
        estimated_output_cost_micros, estimated_total_cost_micros
      ) VALUES (
        @threadId, @surface, @anchorId, @name, @task, @triggerSource,
        1, @usageUnavailableCount, @priceUnavailableCount,
        @turnId, @model, @modelProvider, @serviceTier,
        @totalTokens, @inputTokens, @cachedInputTokens, @outputTokens,
        @reasoningOutputTokens, @modelContextWindow,
        @currency, @catalogVersion, @pricingSourceUrl, @pricedAt,
        @rateSnapshotJson, @uncachedInputTokens,
        @estimatedUncachedInputCostMicros, @estimatedCachedInputCostMicros,
        @estimatedOutputCostMicros, @estimatedTotalCostMicros
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        surface = excluded.surface,
        anchor_id = excluded.anchor_id,
        name = excluded.name,
        task = excluded.task,
        trigger_source = excluded.trigger_source,
        turn_count = ai_thread_usage.turn_count + 1,
        usage_unavailable_count =
          ai_thread_usage.usage_unavailable_count + excluded.usage_unavailable_count,
        price_unavailable_count =
          ai_thread_usage.price_unavailable_count + excluded.price_unavailable_count,
        last_turn_id = excluded.last_turn_id,
        model = COALESCE(excluded.model, ai_thread_usage.model),
        model_provider = COALESCE(excluded.model_provider, ai_thread_usage.model_provider),
        service_tier = COALESCE(excluded.service_tier, ai_thread_usage.service_tier),
        total_tokens = ai_thread_usage.total_tokens + excluded.total_tokens,
        input_tokens = ai_thread_usage.input_tokens + excluded.input_tokens,
        cached_input_tokens =
          ai_thread_usage.cached_input_tokens + excluded.cached_input_tokens,
        output_tokens = ai_thread_usage.output_tokens + excluded.output_tokens,
        reasoning_output_tokens =
          ai_thread_usage.reasoning_output_tokens + excluded.reasoning_output_tokens,
        model_context_window = COALESCE(excluded.model_context_window, ai_thread_usage.model_context_window),
        currency = COALESCE(excluded.currency, ai_thread_usage.currency),
        catalog_version = COALESCE(excluded.catalog_version, ai_thread_usage.catalog_version),
        pricing_source_url = COALESCE(excluded.pricing_source_url, ai_thread_usage.pricing_source_url),
        priced_at = COALESCE(excluded.priced_at, ai_thread_usage.priced_at),
        rate_snapshot_json = COALESCE(excluded.rate_snapshot_json, ai_thread_usage.rate_snapshot_json),
        uncached_input_tokens =
          ai_thread_usage.uncached_input_tokens + excluded.uncached_input_tokens,
        estimated_uncached_input_cost_micros =
          ai_thread_usage.estimated_uncached_input_cost_micros + excluded.estimated_uncached_input_cost_micros,
        estimated_cached_input_cost_micros =
          ai_thread_usage.estimated_cached_input_cost_micros + excluded.estimated_cached_input_cost_micros,
        estimated_output_cost_micros =
          ai_thread_usage.estimated_output_cost_micros + excluded.estimated_output_cost_micros,
        estimated_total_cost_micros =
          ai_thread_usage.estimated_total_cost_micros + excluded.estimated_total_cost_micros,
        updated_at = datetime('now')`
    )
    .run({
      threadId: input.threadId,
      surface: input.surface,
      anchorId: input.anchorId ?? null,
      name: input.name,
      task: input.surface,
      triggerSource,
      usageUnavailableCount: input.usageStatus === "unavailable" ? 1 : 0,
      priceUnavailableCount: cost.status === "unavailable" ? 1 : 0,
      turnId: input.turnId ?? null,
      model: input.model ?? null,
      modelProvider: input.modelProvider ?? null,
      serviceTier: input.serviceTier ?? null,
      totalTokens: tokens?.totalTokens ?? 0,
      inputTokens: tokens?.inputTokens ?? 0,
      cachedInputTokens: tokens?.cachedInputTokens ?? 0,
      outputTokens: tokens?.outputTokens ?? 0,
      reasoningOutputTokens: tokens?.reasoningOutputTokens ?? 0,
      modelContextWindow: tokens?.modelContextWindow ?? null,
      currency: cost.status === "available" ? cost.currency : null,
      catalogVersion: cost.status === "available" ? cost.catalogVersion : null,
      pricingSourceUrl: cost.status === "available" ? cost.pricingSourceUrl : null,
      pricedAt: cost.status === "available" ? cost.pricedAt : null,
      rateSnapshotJson:
        cost.status === "available" ? JSON.stringify(cost.rateSnapshot) : null,
      uncachedInputTokens: cost.status === "available" ? cost.uncachedInputTokens : 0,
      estimatedUncachedInputCostMicros:
        cost.status === "available" ? cost.uncachedInputCostMicros : 0,
      estimatedCachedInputCostMicros:
        cost.status === "available" ? cost.cachedInputCostMicros : 0,
      estimatedOutputCostMicros: cost.status === "available" ? cost.outputCostMicros : 0,
      estimatedTotalCostMicros: cost.status === "available" ? cost.totalCostMicros : 0
    });
}

export function listAiRunUsageRowsMissingPrice(): AiRunUsagePriceRepairRow[] {
  return getDb()
    .prepare(
      `SELECT *
       FROM ai_run_usage
       WHERE usage_status = 'available'
         AND price_status = 'unavailable'
         AND model IS NOT NULL`
    )
    .all()
    .map((row) => {
      const usage = row as AiRunUsageRow;
      return {
        aiRunId: usage.ai_run_id,
        model: usage.model,
        modelProvider: usage.model_provider,
        serviceTier: usage.service_tier,
        tokens: rowToTokens(usage)
      };
    });
}

export function updateAiRunUsageCost(aiRunId: string, cost: AiUsageCostEstimate): void {
  getDb()
    .prepare(
      `UPDATE ai_run_usage
       SET price_status = @priceStatus,
           price_unavailable_reason = @priceUnavailableReason,
           currency = @currency,
           catalog_version = @catalogVersion,
           pricing_source_url = @pricingSourceUrl,
           priced_at = @pricedAt,
           rate_snapshot_json = @rateSnapshotJson,
           uncached_input_tokens = @uncachedInputTokens,
           estimated_uncached_input_cost_micros = @estimatedUncachedInputCostMicros,
           estimated_cached_input_cost_micros = @estimatedCachedInputCostMicros,
           estimated_output_cost_micros = @estimatedOutputCostMicros,
           estimated_total_cost_micros = @estimatedTotalCostMicros,
           updated_at = datetime('now')
       WHERE ai_run_id = @aiRunId`
    )
    .run({
      aiRunId,
      priceStatus: cost.status,
      priceUnavailableReason: cost.status === "unavailable" ? cost.reason : null,
      currency: cost.status === "available" ? cost.currency : null,
      catalogVersion: cost.status === "available" ? cost.catalogVersion : null,
      pricingSourceUrl: cost.status === "available" ? cost.pricingSourceUrl : null,
      pricedAt: cost.status === "available" ? cost.pricedAt : null,
      rateSnapshotJson:
        cost.status === "available" ? JSON.stringify(cost.rateSnapshot) : null,
      uncachedInputTokens: cost.status === "available" ? cost.uncachedInputTokens : null,
      estimatedUncachedInputCostMicros:
        cost.status === "available" ? cost.uncachedInputCostMicros : null,
      estimatedCachedInputCostMicros:
        cost.status === "available" ? cost.cachedInputCostMicros : null,
      estimatedOutputCostMicros: cost.status === "available" ? cost.outputCostMicros : null,
      estimatedTotalCostMicros: cost.status === "available" ? cost.totalCostMicros : null
    });
}

export function replaceAiRunMediaInputs(
  aiRunId: string,
  mediaInputs: readonly SaveAiRunMediaInput[]
): void {
  const db = getDb();
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM ai_run_media_inputs WHERE ai_run_id = ?").run(aiRunId);
    const insert = db.prepare(
      `INSERT INTO ai_run_media_inputs (
        id, ai_run_id, ordinal, role, transform,
        source_mime_type, sent_mime_type, format, encoder, quality,
        source_width_px, source_height_px, sent_width_px, sent_height_px,
        sent_byte_size, max_edge_px, max_bytes, scale_ratio,
        video_position_pct, video_timestamp_sec
      ) VALUES (
        @id, @aiRunId, @ordinal, @role, @transform,
        @sourceMimeType, @sentMimeType, @format, @encoder, @quality,
        @sourceWidthPx, @sourceHeightPx, @sentWidthPx, @sentHeightPx,
        @sentByteSize, @maxEdgePx, @maxBytes, @scaleRatio,
        @videoPositionPct, @videoTimestampSec
      )`
    );
    for (const input of mediaInputs) {
      insert.run({
        id: nanoid(),
        aiRunId,
        ordinal: input.ordinal,
        role: input.role,
        transform: input.transform,
        sourceMimeType: input.sourceMimeType ?? null,
        sentMimeType: input.sentMimeType,
        format: input.format,
        encoder: input.encoder ?? null,
        quality: input.quality ?? null,
        sourceWidthPx: input.sourceWidthPx ?? null,
        sourceHeightPx: input.sourceHeightPx ?? null,
        sentWidthPx: input.sentWidthPx,
        sentHeightPx: input.sentHeightPx,
        sentByteSize: input.sentByteSize,
        maxEdgePx: input.maxEdgePx ?? null,
        maxBytes: input.maxBytes ?? null,
        scaleRatio: input.scaleRatio ?? null,
        videoPositionPct: input.videoPositionPct ?? null,
        videoTimestampSec: input.videoTimestampSec ?? null
      });
    }
  });
  replace();
}

export function getAiRunUsageDetail(runId: string): AiRunUsageDetail | null {
  const db = getDb();
  const run = db.prepare("SELECT * FROM ai_runs WHERE id = ?").get(runId) as
    | AiRunJoinedRow
    | undefined;
  if (run === undefined) return null;

  const usage = db.prepare("SELECT * FROM ai_run_usage WHERE ai_run_id = ?").get(runId) as
    | AiRunUsageRow
    | undefined;
  const mediaInputs = db
    .prepare("SELECT * FROM ai_run_media_inputs WHERE ai_run_id = ? ORDER BY ordinal")
    .all(runId)
    .map((row) => rowToMediaInput(row as AiRunMediaInputRow));

  if (usage === undefined) {
    return {
      run: rowToRun(run),
      threadId: null,
      turnId: null,
      model: null,
      modelProvider: null,
      serviceTier: null,
      usageStatus: "unavailable",
      usageUnavailableReason: "usage has not been recorded for this run",
      tokens: null,
      cost: { status: "unavailable", reason: "usage unavailable" },
      mediaInputs
    };
  }

  return {
    run: rowToRun(run),
    threadId: usage.thread_id,
    turnId: usage.turn_id,
    model: usage.model,
    modelProvider: usage.model_provider,
    serviceTier: usage.service_tier,
    usageStatus: usage.usage_status,
    usageUnavailableReason: usage.usage_unavailable_reason,
    tokens: rowToTokens(usage),
    cost: rowToCost(usage),
    mediaInputs
  };
}

export function listAiUsageRuns(input: { limit?: number; offset?: number } = {}): AiUsageRunsPage {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const rows = getDb()
    .prepare(
      `SELECT
        'run' AS subject_kind,
        r.id,
        r.capture_id,
        r.kind,
        r.task,
        r.trigger_source,
        r.selected_model,
        r.status,
        r.error,
        r.latency_ms,
        r.created_at,
        r.started_at,
        r.completed_at,
        u.thread_id,
        NULL AS thread_name,
        NULL AS thread_surface,
        NULL AS turn_count,
        COALESCE(r.completed_at, r.created_at) AS activity_at,
        u.model, u.model_provider, u.service_tier,
        u.usage_status, u.usage_unavailable_reason,
        u.price_status, u.price_unavailable_reason,
        u.currency, u.total_tokens, u.input_tokens, u.cached_input_tokens,
        u.output_tokens, u.reasoning_output_tokens,
        u.estimated_total_cost_micros
      FROM ai_runs r
      LEFT JOIN ai_run_usage u ON u.ai_run_id = r.id
      UNION ALL
      SELECT
        'thread' AS subject_kind,
        t.thread_id AS id,
        t.anchor_id AS capture_id,
        'chat' AS kind,
        t.task,
        t.trigger_source,
        NULL AS selected_model,
        'completed' AS status,
        NULL AS error,
        NULL AS latency_ms,
        t.created_at,
        t.created_at AS started_at,
        t.updated_at AS completed_at,
        t.thread_id,
        t.name AS thread_name,
        t.surface AS thread_surface,
        t.turn_count,
        t.updated_at AS activity_at,
        t.model,
        t.model_provider,
        t.service_tier,
        CASE
          WHEN t.turn_count > 0 AND t.usage_unavailable_count >= t.turn_count THEN 'unavailable'
          ELSE 'available'
        END AS usage_status,
        CASE
          WHEN t.turn_count > 0 AND t.usage_unavailable_count >= t.turn_count THEN 'Codex did not report token usage'
          ELSE NULL
        END AS usage_unavailable_reason,
        CASE
          WHEN t.turn_count > 0 AND t.price_unavailable_count >= t.turn_count THEN 'unavailable'
          ELSE 'available'
        END AS price_status,
        CASE
          WHEN t.turn_count > 0 AND t.price_unavailable_count >= t.turn_count THEN 'price unavailable'
          ELSE NULL
        END AS price_unavailable_reason,
        t.currency,
        t.total_tokens,
        t.input_tokens,
        t.cached_input_tokens,
        t.output_tokens,
        t.reasoning_output_tokens,
        t.estimated_total_cost_micros
      FROM ai_thread_usage t
      ORDER BY activity_at DESC, id DESC
      LIMIT @limitPlusOne OFFSET @offset`
    )
    .all({ limitPlusOne: limit + 1, offset }) as AiUsageActivityListRow[];
  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map(rowToUsageRunListItem),
    nextOffset: rows.length > limit ? offset + limit : null
  };
}

function rowToUsageRunListItem(row: AiUsageActivityListRow): AiUsageRunListItem {
  return {
    run: rowToRun(row),
    subjectKind: row.subject_kind ?? "run",
    threadId: row.thread_id ?? null,
    threadName: row.thread_name ?? null,
    threadSurface: row.thread_surface ?? null,
    turnCount: row.turn_count ?? null,
    model: row.model ?? null,
    modelProvider: row.model_provider ?? null,
    serviceTier: row.service_tier ?? null,
    usageStatus: row.usage_status ?? "unavailable",
    usageUnavailableReason: row.usage_unavailable_reason ?? "usage has not been recorded",
    priceStatus: row.price_status ?? "unavailable",
    priceUnavailableReason: row.price_unavailable_reason ?? "usage unavailable",
    totalTokens: row.total_tokens ?? null,
    inputTokens: row.input_tokens ?? null,
    cachedInputTokens: row.cached_input_tokens ?? null,
    outputTokens: row.output_tokens ?? null,
    reasoningOutputTokens: row.reasoning_output_tokens ?? null,
    estimatedTotalCostMicros: row.estimated_total_cost_micros ?? null,
    currency: row.currency ?? null
  };
}

export function getAiUsageSummary(window: AiUsageSummaryWindow): AiUsageSummary {
  const hours = window === "24h" ? 24 : window === "7d" ? 24 * 7 : 24 * 30;
  const generatedAt = new Date().toISOString();
  const sinceDate = new Date(Date.now() - hours * 60 * 60 * 1000);
  const since = sinceDate.toISOString();
  const sinceSql = sinceDate.toISOString().slice(0, 19).replace("T", " ");
  const db = getDb();
  const runRows = db
    .prepare(
      `SELECT
        r.task,
        r.trigger_source,
        u.model,
        COUNT(*) AS run_count,
        SUM(CASE WHEN COALESCE(u.usage_status, 'unavailable') = 'unavailable' THEN 1 ELSE 0 END)
          AS usage_unavailable_count,
        SUM(CASE WHEN COALESCE(u.price_status, 'unavailable') = 'unavailable' THEN 1 ELSE 0 END)
          AS price_unavailable_count,
        COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(u.cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(u.reasoning_output_tokens), 0) AS reasoning_output_tokens,
        COALESCE(SUM(u.estimated_total_cost_micros), 0) AS estimated_total_cost_micros
      FROM ai_runs r
      LEFT JOIN ai_run_usage u ON u.ai_run_id = r.id
      WHERE datetime(r.created_at) >= datetime(@since)
      GROUP BY r.task, r.trigger_source, u.model
      ORDER BY r.task, r.trigger_source, u.model`
    )
    .all({ since: sinceSql }) as Array<{
    task: string;
    trigger_source: AiEnrichmentTriggerSource;
    model: string | null;
    run_count: number;
    usage_unavailable_count: number;
    price_unavailable_count: number;
    total_tokens: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    estimated_total_cost_micros: number;
  }>;
  const threadRows = db
    .prepare(
      `SELECT
        t.task,
        t.trigger_source,
        t.model,
        SUM(t.turn_count) AS run_count,
        SUM(t.usage_unavailable_count) AS usage_unavailable_count,
        SUM(t.price_unavailable_count) AS price_unavailable_count,
        COALESCE(SUM(t.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(t.cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(t.reasoning_output_tokens), 0) AS reasoning_output_tokens,
        COALESCE(SUM(t.estimated_total_cost_micros), 0) AS estimated_total_cost_micros
      FROM ai_thread_usage t
      WHERE datetime(t.updated_at) >= datetime(@since)
      GROUP BY t.task, t.trigger_source, t.model
      ORDER BY t.task, t.trigger_source, t.model`
    )
    .all({ since: sinceSql }) as Array<{
    task: string;
    trigger_source: AiEnrichmentTriggerSource;
    model: string | null;
    run_count: number;
    usage_unavailable_count: number;
    price_unavailable_count: number;
    total_tokens: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    estimated_total_cost_micros: number;
  }>;
  const rows = [...runRows, ...threadRows];
  const buckets: AiUsageSummaryBucket[] = rows.map((row) => ({
    task: row.task,
    triggerSource: row.trigger_source,
    model: row.model,
    runCount: row.run_count,
    usageUnavailableCount: row.usage_unavailable_count,
    priceUnavailableCount: row.price_unavailable_count,
    totalTokens: row.total_tokens,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    estimatedTotalCostMicros: row.estimated_total_cost_micros
  }));

  return {
    window,
    since,
    generatedAt,
    runCount: sum(buckets, "runCount"),
    usageUnavailableCount: sum(buckets, "usageUnavailableCount"),
    priceUnavailableCount: sum(buckets, "priceUnavailableCount"),
    totalTokens: sum(buckets, "totalTokens"),
    inputTokens: sum(buckets, "inputTokens"),
    cachedInputTokens: sum(buckets, "cachedInputTokens"),
    outputTokens: sum(buckets, "outputTokens"),
    reasoningOutputTokens: sum(buckets, "reasoningOutputTokens"),
    estimatedTotalCostMicros: sum(buckets, "estimatedTotalCostMicros"),
    currency: "USD",
    buckets
  };
}

function sum<T extends keyof AiUsageSummaryBucket>(
  buckets: readonly AiUsageSummaryBucket[],
  key: T
): number {
  return buckets.reduce((total, bucket) => {
    const value = bucket[key];
    return typeof value === "number" ? total + value : total;
  }, 0);
}
