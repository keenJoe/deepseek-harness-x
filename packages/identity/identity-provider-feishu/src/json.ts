/**
 * Narrow readers for Feishu JSON responses.
 *
 * Every value arrives from the network, so each reader narrows instead of trusting a declared type.
 * @module @deepseek-ai/dsh-identity-provider-feishu/src/json
 */

/**
 * Narrow a parsed JSON value to a plain object.
 * @param value - any parsed JSON value.
 * @returns true for a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one non-empty string member of a parsed JSON object.
 * @param record - parsed JSON object.
 * @param key - member name.
 * @returns the member when it is a non-empty string, otherwise undefined.
 */
export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}
