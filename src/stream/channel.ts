import type { ChannelInfo, ProgramPosition } from '../../shared/contract';
import { routes } from '../../shared/routes';
import { fetchProgramPosition, HttpResponseError } from '../content/httpContentClient';

const STARTUP_RETRY_MS = 3_000;

// Startup requests share cancellation and a callback for the retry message.
interface StartupRequestOptions {
  signal: AbortSignal;
  onRetry: () => void;
  retryMs?: number;
}

// An abortable delay lets page teardown stop the retry loop immediately.
function waitForRetry(signal: AbortSignal, retryMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, retryMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function requestChannel(
  channelId: string | undefined,
  signal: AbortSignal,
): Promise<ChannelInfo> {
  const query = channelId ? `?channel=${encodeURIComponent(channelId)}` : '';
  const response = await fetch(`${routes.channel}${query}`, { signal });
  if (!response.ok) throw new HttpResponseError('channel request', response.status);
  return (await response.json()) as ChannelInfo;
}

// Fetch reports network failures as TypeError; HTTP responses carry their own status.
function isTransientError(error: unknown): boolean {
  if (error instanceof HttpResponseError) {
    return (
      error.status === 408 || error.status === 429 || (error.status >= 500 && error.status < 600)
    );
  }
  return (
    error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')
  );
}

// Retry temporary startup failures until the request succeeds or the page stops it.
async function waitForStartup<T>(
  request: () => Promise<T>,
  options: StartupRequestOptions,
): Promise<T> {
  const { signal, onRetry, retryMs = STARTUP_RETRY_MS } = options;
  for (;;) {
    signal.throwIfAborted();
    try {
      const result = await request();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted || !isTransientError(error)) throw error;
      onRetry();
      await waitForRetry(signal, retryMs);
    }
  }
}

// Load the channel definition before creating its players.
export function waitForChannel(
  channelId: string | undefined,
  options: StartupRequestOptions,
): Promise<ChannelInfo> {
  return waitForStartup(() => requestChannel(channelId, options.signal), options);
}

// Join the current position of a named server-timed channel.
export function waitForProgramPosition(
  channelId: string,
  options: StartupRequestOptions,
): Promise<ProgramPosition | null> {
  return waitForStartup(() => fetchProgramPosition(channelId, options.signal), options);
}
