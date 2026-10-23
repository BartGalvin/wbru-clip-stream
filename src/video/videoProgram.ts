import type { VideoSource } from '../../shared/contract';
import { attachHls, playWithAudioFallback, type MediaHandle } from '../media/playback';
import { createRecoveringHlsConnection } from '../media/recoveringHls';
import { createClipVideoProgram } from './clipVideoProgram';
import type { ClipVideoProgramContext, VideoProgram, VideoProgramOptions } from './types';

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

// Keep an HLS video attached through recoverable stream failures.
function createHlsVideoProgram(url: string, options: VideoProgramOptions): VideoProgram {
  const video = document.createElement('video');
  video.muted = options.muted;
  video.playsInline = true;
  video.preload = 'auto';
  options.stage.appendChild(video);

  let playback: MediaHandle | null = null;
  let started = false;
  let destroyed = false;

  const stopPlayback = (): void => {
    playback?.destroy();
    playback = null;
  };
  const connection = createRecoveringHlsConnection({
    attach: (onFatal) => attachHls(video, url, onFatal),
    onDisconnected: stopPlayback,
    onConnected: () => {
      options.onStatus(null);
      if (started) playback = playWithAudioFallback(video, options.playHooks);
    },
    onRetry: (error) => options.onStatus(`${asError(error).message}. Retrying...`),
    onRetryError: (error) => options.onStatus(asError(error).message),
  });

  return {
    async start() {
      if (started || destroyed) return;
      started = true;
      video.classList.add('on');
      await connection.start();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      connection.destroy();
      video.remove();
    },
  };
}

// Dispatch each configured video source to its focused playback implementation.
export function createVideoProgram(
  source: VideoSource,
  options: VideoProgramOptions & { clip?: ClipVideoProgramContext },
): VideoProgram {
  switch (source.kind) {
    case 'clips':
      if (!options.clip) throw new Error('Clip playback context is required');
      return createClipVideoProgram(options, options.clip);
    case 'hls':
      return createHlsVideoProgram(source.url, options);
    case 'youtube':
      throw new Error('YouTube playback is not implemented yet');
  }
}
