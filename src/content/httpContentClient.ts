import type { ClipRef, ProgramPosition } from '../../shared/contract';
import type { ContentClient } from './contentClient';
import { encodeTagFilter, type TagFilter } from '../../shared/tagFilter';
import { routes } from '../../shared/routes';

// Keep the HTTP status so the caller can distinguish temporary and permanent failures.
export class HttpResponseError extends Error {
  constructor(
    resource: string,
    readonly status: number,
  ) {
    super(`${resource} failed: ${status}`);
  }
}

// Read the current position of a named server-timed channel.
export async function fetchProgramPosition(
  channel: string,
  signal: AbortSignal,
): Promise<ProgramPosition | null> {
  const params = new URLSearchParams({ channel });
  const response = await fetch(`${routes.programPosition}?${params}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    throw new HttpResponseError('program position', response.status);
  }
  return (await response.json()) as ProgramPosition;
}

// Every request is bounded by a timeout and the lifetime of the client.
export function createHttpContentClient(
  opts: {
    channel?: string;
    filter?: TagFilter;
    timeoutMs?: number;
  } = {},
): ContentClient {
  const { channel, filter, timeoutMs = 10_000 } = opts;
  const controller = new AbortController();
  const requestSignal = (): AbortSignal =>
    AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  // Apply the selected channel and ad hoc filters to every program page.
  const query = (params: URLSearchParams): string => {
    if (channel) params.set('channel', channel);
    if (filter) for (const [k, v] of encodeTagFilter(filter)) params.set(k, v);
    return params.toString();
  };
  return {
    async upcoming(after, limit) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (after) params.set('after', after);
      const res = await fetch(`${routes.programUpcoming}?${query(params)}`, {
        signal: requestSignal(),
      });
      if (!res.ok) throw new Error(`upcoming failed: ${res.status}`);
      return (await res.json()) as ClipRef[];
    },
    destroy() {
      controller.abort();
    },
  };
}
