-- 0026_reprice_gpt56_usage — repair GPT-5.6 usage captured before the
-- 2026-07-30 catalog was installed. Historical GPT-5.4 and older snapshots
-- are intentionally untouched.

UPDATE ai_run_usage
SET price_status = 'available',
    price_unavailable_reason = NULL,
    currency = 'USD',
    catalog_version = '2026-07-30-gpt-5.6',
    pricing_source_url = 'https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/',
    priced_at = '2026-07-30T00:00:00.000Z',
    uncached_input_tokens = MAX(0, COALESCE(uncached_input_tokens, COALESCE(input_tokens, 0) - COALESCE(cached_input_tokens, 0))),
    estimated_uncached_input_cost_micros = MAX(0, COALESCE(uncached_input_tokens, COALESCE(input_tokens, 0) - COALESCE(cached_input_tokens, 0))) *
      CASE WHEN model = 'gpt-5.6-luna' AND service_tier = 'fast' THEN 0.4
           WHEN model = 'gpt-5.6-luna' THEN 0.2
           WHEN model = 'gpt-5.6-terra' AND service_tier = 'fast' THEN 4.0
           ELSE 2.0 END,
    estimated_cached_input_cost_micros = COALESCE(cached_input_tokens, 0) *
      CASE WHEN model = 'gpt-5.6-luna' AND service_tier = 'fast' THEN 0.04
           WHEN model = 'gpt-5.6-luna' THEN 0.02
           WHEN model = 'gpt-5.6-terra' AND service_tier = 'fast' THEN 0.4
           ELSE 0.2 END,
    estimated_output_cost_micros = COALESCE(output_tokens, 0) *
      CASE WHEN model = 'gpt-5.6-luna' AND service_tier = 'fast' THEN 2.4
           WHEN model = 'gpt-5.6-luna' THEN 1.2
           WHEN model = 'gpt-5.6-terra' AND service_tier = 'fast' THEN 24.0
           ELSE 12.0 END,
    rate_snapshot_json = json_object(
      'model', model,
      'serviceTier', CASE WHEN service_tier = 'fast' THEN 'fast' ELSE NULL END,
      'contextClass', 'standard',
      'inputUsdPerMillion', CASE WHEN model = 'gpt-5.6-luna' AND service_tier = 'fast' THEN 0.4 WHEN model = 'gpt-5.6-luna' THEN 0.2 WHEN model = 'gpt-5.6-terra' AND service_tier = 'fast' THEN 4.0 ELSE 2.0 END,
      'cachedInputUsdPerMillion', CASE WHEN model = 'gpt-5.6-luna' AND service_tier = 'fast' THEN 0.04 WHEN model = 'gpt-5.6-luna' THEN 0.02 WHEN model = 'gpt-5.6-terra' AND service_tier = 'fast' THEN 0.4 ELSE 0.2 END,
      'outputUsdPerMillion', CASE WHEN model = 'gpt-5.6-luna' AND service_tier = 'fast' THEN 2.4 WHEN model = 'gpt-5.6-luna' THEN 1.2 WHEN model = 'gpt-5.6-terra' AND service_tier = 'fast' THEN 24.0 ELSE 12.0 END
    )
WHERE model IN ('gpt-5.6-luna', 'gpt-5.6-terra')
  AND model_provider IN ('openai', 'codex')
  AND usage_status = 'available'
  AND created_at >= '2026-07-30';

UPDATE ai_run_usage
SET estimated_total_cost_micros = estimated_uncached_input_cost_micros + estimated_cached_input_cost_micros + estimated_output_cost_micros
WHERE model IN ('gpt-5.6-luna', 'gpt-5.6-terra')
  AND model_provider IN ('openai', 'codex')
  AND created_at >= '2026-07-30';

-- Thread rows aggregate turns. Reprice aggregates whose latest persisted turn
-- is on/after the effective date; older rows retain their historical snapshot.
UPDATE ai_thread_usage
SET currency = 'USD',
    catalog_version = '2026-07-30-gpt-5.6',
    pricing_source_url = 'https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/',
    priced_at = '2026-07-30T00:00:00.000Z',
    estimated_uncached_input_cost_micros = uncached_input_tokens * CASE WHEN model = 'gpt-5.6-luna' AND service_tier = 'fast' THEN 0.4 WHEN model = 'gpt-5.6-luna' THEN 0.2 WHEN model = 'gpt-5.6-terra' AND service_tier = 'fast' THEN 4.0 ELSE 2.0 END,
    estimated_cached_input_cost_micros = cached_input_tokens * CASE WHEN model = 'gpt-5.6-luna' AND service_tier = 'fast' THEN 0.04 WHEN model = 'gpt-5.6-luna' THEN 0.02 WHEN model = 'gpt-5.6-terra' AND service_tier = 'fast' THEN 0.4 ELSE 0.2 END,
    estimated_output_cost_micros = output_tokens * CASE WHEN model = 'gpt-5.6-luna' AND service_tier = 'fast' THEN 2.4 WHEN model = 'gpt-5.6-luna' THEN 1.2 WHEN model = 'gpt-5.6-terra' AND service_tier = 'fast' THEN 24.0 ELSE 12.0 END,
    rate_snapshot_json = json_object(
      'model', model,
      'serviceTier', CASE WHEN service_tier = 'fast' THEN 'fast' ELSE NULL END,
      'contextClass', 'standard',
      'inputUsdPerMillion', CASE WHEN model = 'gpt-5.6-luna' AND service_tier = 'fast' THEN 0.4 WHEN model = 'gpt-5.6-luna' THEN 0.2 WHEN model = 'gpt-5.6-terra' AND service_tier = 'fast' THEN 4.0 ELSE 2.0 END,
      'cachedInputUsdPerMillion', CASE WHEN model = 'gpt-5.6-luna' AND service_tier = 'fast' THEN 0.04 WHEN model = 'gpt-5.6-luna' THEN 0.02 WHEN model = 'gpt-5.6-terra' AND service_tier = 'fast' THEN 0.4 ELSE 0.2 END,
      'outputUsdPerMillion', CASE WHEN model = 'gpt-5.6-luna' AND service_tier = 'fast' THEN 2.4 WHEN model = 'gpt-5.6-luna' THEN 1.2 WHEN model = 'gpt-5.6-terra' AND service_tier = 'fast' THEN 24.0 ELSE 12.0 END
    )
WHERE model IN ('gpt-5.6-luna', 'gpt-5.6-terra')
  AND model_provider IN ('openai', 'codex')
  AND updated_at >= '2026-07-30';

UPDATE ai_thread_usage
SET estimated_total_cost_micros = estimated_uncached_input_cost_micros + estimated_cached_input_cost_micros + estimated_output_cost_micros
WHERE model IN ('gpt-5.6-luna', 'gpt-5.6-terra')
  AND model_provider IN ('openai', 'codex')
  AND updated_at >= '2026-07-30';
