/**
 * Boundary decoding for JSON I/O.
 *
 * Everything this extension reads from disk, from the Herdr CLI, or from a child
 * process arrives as JSON text. `JsonValue` names exactly the shape `JSON.parse`
 * can produce, and the accessors below turn that representation into domain
 * values at the boundary so callers never branch on `typeof`.
 *
 * The `typeof` checks required to classify a decoded value live here, confined to
 * type guards, and nowhere else in the codebase.
 */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

/** Decode JSON text into the only shape `JSON.parse` can produce. */
export function parseJsonText(text: string): JsonValue {
  // SAFETY: JSON.parse only ever yields string, number, boolean, null, array, or
  // plain object values, which is precisely what JsonValue enumerates.
  return JSON.parse(text) as JsonValue;
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === "boolean";
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function jsonString(value: JsonValue | undefined): string | undefined {
  return isJsonString(value) ? value : undefined;
}

/** Read a finite number, or `undefined` when the value is absent or another JSON type. */
export function jsonNumber(value: JsonValue | undefined): number | undefined {
  return isJsonNumber(value) ? value : undefined;
}

export function jsonBoolean(value: JsonValue | undefined): boolean | undefined {
  return isJsonBoolean(value) ? value : undefined;
}

export function jsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

export function jsonArray(value: JsonValue | undefined): readonly JsonValue[] | undefined {
  return isJsonArray(value) ? value : undefined;
}

/** Describe an arbitrary thrown value without asserting anything about its type. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
