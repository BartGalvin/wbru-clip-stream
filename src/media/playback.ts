import type { HlsConfig } from 'hls.js';

// Cleanup handle for listeners, retries, or media attachments started by a helper.
export interface MediaHandle {
  destroy: () => void;
}

// Indicates that neither native HLS nor hls.js can play the requested stream.
export class HlsNotSupportedError extends Error {}

const HLS_MIME = 'application/vnd.apple.mpegurl';

// Playback lifecycle callbacks used to show and clear browser autoplay guidance.
export interface PlayHooks {
  onBlocked?: () => void;
  onResumed?: () => void;
  onError?: (error: unknown) => void;
}

// Unmuted playback may be blocked until the user interacts. Keep retrying on
// pointer/key events until the browser accepts it.
export function playWithAudioFallback(media: HTMLMediaElement, hooks: PlayHooks = {}): MediaHandle {
  let active = true;
  let resuming = false;
  let listening = false;
  const destroy = (): void => {
    if (!active) return;
    active = false;
    if (!listening) return;
    listening = false;
    window.removeEventListener('pointerdown', resume);
    window.removeEventListener('keydown', resume);
  };
  const failed = (error: unknown): void => {
    if (!active) return;
    resuming = false;
    if (!(error instanceof DOMException && error.name === 'NotAllowedError')) {
      destroy();
      hooks.onError?.(error);
      return;
    }
    if (listening) return;
    listening = true;
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    hooks.onBlocked?.();
  };
  const resumed = (): void => {
    if (!active) return;
    destroy();
    hooks.onResumed?.();
  };
  const resume = (): void => {
    if (!active || resuming) return;
    resuming = true;
    void media.play().then(resumed, failed);
  };
  void media.play().then(resumed, failed);
  return { destroy };
}

// Safari handles HLS natively; other supported browsers use hls.js.
export async function attachHls(
  media: HTMLMediaElement,
  url: string,
  onFatal: (err: Error) => void,
  config?: Partial<HlsConfig>,
): Promise<MediaHandle> {
  if (media.canPlayType(HLS_MIME)) {
    const onError = () => onFatal(new Error('Native HLS playback error'));
    media.addEventListener('error', onError);
    media.src = url;
    let active = true;
    return {
      destroy: () => {
        if (!active) return;
        active = false;
        media.removeEventListener('error', onError);
        media.removeAttribute('src');
        // Reloading after removing src aborts the browser's active media fetch.
        media.load();
      },
    };
  }
  const { default: Hls } = await import('hls.js');
  if (!Hls.isSupported()) {
    throw new HlsNotSupportedError('HLS is not supported in this browser');
  }
  const hls = new Hls(config);
  try {
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) onFatal(new Error(`HLS stream error: ${data.type}`));
    });
    hls.loadSource(url);
    hls.attachMedia(media);
    let active = true;
    return {
      destroy: () => {
        if (!active) return;
        active = false;
        hls.destroy();
      },
    };
  } catch (error) {
    hls.destroy();
    throw error;
  }
}
