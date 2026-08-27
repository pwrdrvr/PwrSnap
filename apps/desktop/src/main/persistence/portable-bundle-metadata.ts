import type { BundleDocumentV2, BundleManifestV2 } from "@pwrsnap/shared";

const PORTABLE_KEY = /^portable_[A-Za-z0-9_]{1,64}$/u;
const PORTABLE_LAYER_ID = /^[A-Za-z0-9_-]{16}$/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const MAX_PORTABLE_BUNDLE_METADATA_BYTES = 512 * 1024;
const MAX_PORTABLE_VALUE_DEPTH = 16;
const MAX_PORTABLE_VALUE_NODES = 65_536;
const MAX_PORTABLE_STRING_BYTES = 64 * 1024;
const MAX_PORTABLE_ARRAY_ITEMS = 1_024;
const MAX_PORTABLE_OBJECT_KEYS = 256;
const MAX_PORTABLE_KEY_BYTES = 128;
const MAX_DESCRIPTOR_OBJECT_KEYS = 4_096;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type MetadataObject = { [key: string]: JsonValue };

export type PortableBundleMetadata = {
  version: 1;
  manifest: MetadataObject;
  document: MetadataObject;
  layers: Record<string, MetadataObject>;
  aiRuns: Record<string, MetadataObject>;
};

export class PortableBundleMetadataError extends Error {
  constructor(message = "Portable bundle metadata is invalid or exceeds its bounds.") {
    super(message);
    this.name = "PortableBundleMetadataError";
  }
}

export function emptyPortableBundleMetadata(): PortableBundleMetadata {
  return {
    version: 1,
    manifest: {},
    document: {},
    layers: metadataMap(),
    aiRuns: metadataMap()
  };
}

/**
 * Extract only explicitly portable unknown JSON fields from already bounded
 * manifest/document values. Known schema fields form traversal paths but are
 * never copied into the descriptor. Layer and AI metadata is keyed by stable
 * identity so reorder/insertion cannot attach it to another record.
 */
export function extractPortableBundleMetadata(
  rawManifest: unknown,
  manifest: BundleManifestV2,
  rawDocument: unknown,
  document: BundleDocumentV2
): PortableBundleMetadata {
  const rawManifestObject = requireObject(rawManifest);
  const rawDocumentObject = requireObject(rawDocument);
  const budget = { nodes: 0 };
  const metadata = emptyPortableBundleMetadata();

  metadata.manifest = extractObjectMetadata(rawManifestObject, manifest, budget);
  metadata.document = extractObjectMetadata(rawDocumentObject, document, budget, new Set([
    "layers",
    "ai_runs"
  ]));

  const rawLayers = requireObjectArray(rawDocumentObject.layers);
  const rawLayersById = objectsById(rawLayers);
  for (const layer of document.layers) {
    const rawLayer = rawLayersById.get(layer.id);
    if (rawLayer === undefined) throw new PortableBundleMetadataError();
    const descriptor = extractObjectMetadata(rawLayer, layer, budget);
    if (Object.keys(descriptor).length > 0) metadata.layers[layer.id] = descriptor;
  }

  const rawAiRuns = requireObjectArray(rawDocumentObject.ai_runs);
  const rawAiRunsById = objectsById(rawAiRuns);
  for (const run of document.ai_runs) {
    const rawRun = rawAiRunsById.get(run.id);
    if (rawRun === undefined) throw new PortableBundleMetadataError();
    const descriptor = extractObjectMetadata(rawRun, run, budget);
    if (Object.keys(descriptor).length > 0) {
      assertPortableAiRunId(run.id);
      metadata.aiRuns[run.id] = descriptor;
    }
  }

  assertSerializedBound(metadata);
  return metadata;
}

export function remapPortableBundleMetadata(
  metadata: PortableBundleMetadata,
  layerIds: ReadonlyMap<string, string>
): PortableBundleMetadata {
  const layers = metadataMap();
  for (const [oldId, descriptor] of Object.entries(metadata.layers)) {
    const newId = layerIds.get(oldId) ?? oldId;
    if (Object.hasOwn(layers, newId)) throw new PortableBundleMetadataError();
    layers[newId] = descriptor;
  }
  const remapped = { ...metadata, layers };
  assertSerializedBound(remapped);
  return remapped;
}

export function applyPortableBundleMetadata(
  manifest: BundleManifestV2,
  document: BundleDocumentV2,
  metadata: PortableBundleMetadata
): { manifestJson: MetadataObject; documentJson: MetadataObject } {
  assertSerializedBound(metadata);
  const manifestJson = applyObjectMetadata(manifest, metadata.manifest);
  const layers = document.layers.map((layer) =>
    applyObjectMetadata(layer, metadata.layers[layer.id] ?? {})
  );
  const aiRuns = document.ai_runs.map((run) =>
    applyObjectMetadata(run, metadata.aiRuns[run.id] ?? {})
  );
  const documentJson = applyObjectMetadata(
    { ...document, layers, ai_runs: aiRuns },
    metadata.document
  );
  return { manifestJson, documentJson };
}

export function serializePortableBundleMetadata(
  metadata: PortableBundleMetadata
): string {
  validateStoredDescriptor(metadata);
  const serialized = JSON.stringify(metadata);
  if (Buffer.byteLength(serialized) > MAX_PORTABLE_BUNDLE_METADATA_BYTES) {
    throw new PortableBundleMetadataError();
  }
  return serialized;
}

export function parsePortableBundleMetadata(serialized: string): PortableBundleMetadata {
  if (Buffer.byteLength(serialized) > MAX_PORTABLE_BUNDLE_METADATA_BYTES) {
    throw new PortableBundleMetadataError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new PortableBundleMetadataError();
  }
  validateStoredDescriptor(parsed);
  return parsed as PortableBundleMetadata;
}

function extractObjectMetadata(
  raw: Record<string, unknown>,
  parsed: object,
  budget: { nodes: number },
  ignoredKeys: ReadonlySet<string> = new Set()
): MetadataObject {
  const descriptor: MetadataObject = {};
  const parsedObject = parsed as Record<string, unknown>;
  for (const [key, rawValue] of Object.entries(raw)) {
    if (ignoredKeys.has(key)) continue;
    if (Object.hasOwn(parsedObject, key)) {
      const nested = extractNestedMetadata(rawValue, parsedObject[key], budget);
      if (nested !== undefined) descriptor[key] = nested;
      continue;
    }
    if (!PORTABLE_KEY.test(key)) continue;
    validatePortableValue(rawValue, budget, 0);
    descriptor[key] = rawValue as JsonValue;
  }
  return descriptor;
}

function extractNestedMetadata(
  raw: unknown,
  parsed: unknown,
  budget: { nodes: number }
): JsonValue | undefined {
  if (Array.isArray(raw) && Array.isArray(parsed) && raw.length === parsed.length) {
    const sparse: JsonValue[] = [];
    let found = false;
    for (let index = 0; index < raw.length; index += 1) {
      const nested = extractNestedMetadata(raw[index], parsed[index], budget);
      sparse.push(nested ?? null);
      if (nested !== undefined) found = true;
    }
    return found ? sparse : undefined;
  }
  if (isObject(raw) && isObject(parsed)) {
    const nested = extractObjectMetadata(raw, parsed, budget);
    return Object.keys(nested).length > 0 ? nested : undefined;
  }
  return undefined;
}

function applyObjectMetadata(current: object, descriptor: MetadataObject): MetadataObject {
  return applyMetadata(current, descriptor) as MetadataObject;
}

function applyMetadata(current: unknown, descriptor: JsonValue): JsonValue {
  if (Array.isArray(current) && Array.isArray(descriptor)) {
    return current.map((value, index) => {
      const nested = descriptor[index];
      return nested === null || nested === undefined
        ? (value as JsonValue)
        : applyMetadata(value, nested);
    });
  }
  if (!isObject(current) || !isObject(descriptor)) return current as JsonValue;

  const result: MetadataObject = { ...(current as MetadataObject) };
  for (const [key, metadataValue] of Object.entries(descriptor)) {
    if (PORTABLE_KEY.test(key)) {
      if (!Object.hasOwn(result, key)) result[key] = cloneJson(metadataValue);
      continue;
    }
    if (Object.hasOwn(result, key)) {
      result[key] = applyMetadata(result[key], metadataValue);
    }
  }
  return result;
}

function validatePortableValue(
  value: unknown,
  budget: { nodes: number },
  depth: number
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_PORTABLE_VALUE_NODES || depth > MAX_PORTABLE_VALUE_DEPTH) {
    throw new PortableBundleMetadataError();
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PortableBundleMetadataError();
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_PORTABLE_STRING_BYTES) {
      throw new PortableBundleMetadataError();
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PORTABLE_ARRAY_ITEMS) throw new PortableBundleMetadataError();
    for (const item of value) validatePortableValue(item, budget, depth + 1);
    return;
  }
  if (!isObject(value)) throw new PortableBundleMetadataError();
  const entries = Object.entries(value);
  if (entries.length > MAX_PORTABLE_OBJECT_KEYS) throw new PortableBundleMetadataError();
  for (const [key, item] of entries) {
    if (FORBIDDEN_KEYS.has(key) || Buffer.byteLength(key) > MAX_PORTABLE_KEY_BYTES) {
      throw new PortableBundleMetadataError();
    }
    validatePortableValue(item, budget, depth + 1);
  }
}

function validateStoredDescriptor(value: unknown): asserts value is PortableBundleMetadata {
  if (!isObject(value) || value.version !== 1) throw new PortableBundleMetadataError();
  for (const key of ["manifest", "document", "layers", "aiRuns"] as const) {
    if (!isObject(value[key])) throw new PortableBundleMetadataError();
  }
  for (const id of Object.keys(value.layers as Record<string, unknown>)) {
    if (!PORTABLE_LAYER_ID.test(id)) throw new PortableBundleMetadataError();
    if (!isObject((value.layers as Record<string, unknown>)[id])) {
      throw new PortableBundleMetadataError();
    }
  }
  for (const id of Object.keys(value.aiRuns as Record<string, unknown>)) {
    assertPortableAiRunId(id);
    if (!isObject((value.aiRuns as Record<string, unknown>)[id])) {
      throw new PortableBundleMetadataError();
    }
  }
  validateDescriptorValue(value, { nodes: 0 }, 0);
}

function assertSerializedBound(metadata: PortableBundleMetadata): void {
  serializePortableBundleMetadata(metadata);
}

function validateDescriptorValue(
  value: unknown,
  budget: { nodes: number },
  depth: number
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_PORTABLE_VALUE_NODES || depth > MAX_PORTABLE_VALUE_DEPTH) {
    throw new PortableBundleMetadataError();
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PortableBundleMetadataError();
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_PORTABLE_STRING_BYTES) {
      throw new PortableBundleMetadataError();
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PORTABLE_ARRAY_ITEMS) throw new PortableBundleMetadataError();
    for (const item of value) validateDescriptorValue(item, budget, depth + 1);
    return;
  }
  if (!isObject(value)) throw new PortableBundleMetadataError();
  const entries = Object.entries(value);
  if (entries.length > MAX_DESCRIPTOR_OBJECT_KEYS) throw new PortableBundleMetadataError();
  for (const [key, item] of entries) {
    if (FORBIDDEN_KEYS.has(key) || Buffer.byteLength(key) > MAX_PORTABLE_KEY_BYTES) {
      throw new PortableBundleMetadataError();
    }
    validateDescriptorValue(item, budget, depth + 1);
  }
}

function objectsById(values: readonly Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    if (typeof value.id !== "string" || result.has(value.id)) {
      throw new PortableBundleMetadataError();
    }
    result.set(value.id, value);
  }
  return result;
}

function requireObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isObject)) {
    throw new PortableBundleMetadataError();
  }
  return value;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new PortableBundleMetadataError();
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function metadataMap(): Record<string, MetadataObject> {
  return Object.create(null) as Record<string, MetadataObject>;
}

function assertPortableAiRunId(id: string): void {
  if (
    id.length < 1 ||
    id.length > 64 ||
    /[\u0000-\u001f]/u.test(id) ||
    FORBIDDEN_KEYS.has(id)
  ) {
    throw new PortableBundleMetadataError();
  }
}
