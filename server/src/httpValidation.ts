// Express JSON bodies must be plain objects before route-specific validation.
export function isRequestBody(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Distinguish an omitted query value from an invalid repeated or structured value.
export function parseScalarQuery(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

// Parse one integer query value and clamp accepted values to the endpoint's bounds.
export function parseBoundedIntegerQuery(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number,
): number | null {
  const scalar = parseScalarQuery(value);
  if (scalar === undefined) return defaultValue;
  if (scalar === null || scalar.trim() === '') return null;

  const parsed = Number(scalar);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

// Parse an optional integer cursor; afterId can start at zero for an empty log.
export function parseOptionalIntegerQuery(value: unknown, minimum = 1): number | undefined | null {
  const scalar = parseScalarQuery(value);
  if (scalar === undefined) return undefined;
  if (scalar === null || scalar.trim() === '') return null;

  const parsed = Number(scalar);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return null;
  return parsed;
}
