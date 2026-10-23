import { HlsNotSupportedError, type MediaHandle } from './playback';

const HLS_RETRY_MS = 3_000;

// Attachment and lifecycle callbacks supplied by an HLS audio or video player.
interface RecoveringHlsConnectionOptions {
  attach: (onFatal: (error: Error) => void) => Promise<MediaHandle>;
  onConnected: () => void;
  onDisconnected: () => void;
  onRetry: (error: unknown) => void;
  onRetryError: (error: unknown) => void;
}

// Controllable lifetime of one self-recovering HLS attachment.
interface RecoveringHlsConnection {
  start: () => Promise<void>;
  destroy: () => void;
}

// Own one HLS attachment and replace it after recoverable fatal errors.
export function createRecoveringHlsConnection(
  options: RecoveringHlsConnectionOptions,
): RecoveringHlsConnection {
  let connection: MediaHandle | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Attempt numbers invalidate late attaches and errors from connections we already replaced.
  let attemptId = 0;
  let destroyed = false;

  const disconnect = (): void => {
    options.onDisconnected();
    connection?.destroy();
    connection = null;
  };

  // Collapse repeated failures into one delayed reconnect attempt.
  const retry = (error: unknown): void => {
    if (destroyed) return;
    attemptId++;
    disconnect();
    options.onRetry(error);
    if (retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect().catch((nextError: unknown) => {
        if (!destroyed) options.onRetryError(nextError);
      });
    }, HLS_RETRY_MS);
  };

  // Ignore attachments that finish after a newer attempt has already started.
  const connect = async (): Promise<void> => {
    if (destroyed) return;
    const id = ++attemptId;
    try {
      const nextConnection = await options.attach((error) => {
        if (id === attemptId) retry(error);
      });
      if (destroyed || id !== attemptId) {
        nextConnection.destroy();
        return;
      }
      disconnect();
      connection = nextConnection;
      options.onConnected();
    } catch (error) {
      if (destroyed || id !== attemptId) return;
      if (error instanceof HlsNotSupportedError) throw error;
      retry(error);
    }
  };

  return {
    start: connect,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      attemptId++;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      disconnect();
    },
  };
}
