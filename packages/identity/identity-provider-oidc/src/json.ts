/**
 * JSON and base64url decoding shared by the id_token and HTTP paths.
 *
 * Every value here arrives from the network, so each reader narrows instead of
 * trusting a declared type.
 *
 * @module @deepseek-ai/dsh-identity-provider-oidc/src/json
 */

import { Buffer } from 'node:buffer'
import { INVALID_ID_TOKEN, OidcProviderError } from './errors.ts'

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

/**
 * Decode one base64url segment of a compact JWS.
 * @param segment - base64url text without padding.
 * @returns the decoded bytes.
 */
export function decodeBase64Url(segment: string): Buffer {
  return Buffer.from(segment, 'base64url')
}

/**
 * Decode one base64url JWS segment that carries a JSON object.
 * @param segment - base64url text without padding.
 * @param label - segment name used in the failure report.
 * @returns the decoded object.
 * @throws {OidcProviderError} code `INVALID_ID_TOKEN` when the segment is not base64url JSON.
 */
export function decodeJsonObject(segment: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeBase64Url(segment).toString('utf8'))
  } catch (error) {
    throw new OidcProviderError('id_token ' + label + ' is not base64url-encoded JSON', INVALID_ID_TOKEN, { cause: error })
  }
  if (!isRecord(parsed)) {
    throw new OidcProviderError('id_token ' + label + ' is not a JSON object', INVALID_ID_TOKEN)
  }
  return parsed
}
