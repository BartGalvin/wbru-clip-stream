import type { StationAudio } from '../../shared/contract';
import {
  attachHls,
  playWithAudioFallback,
  type MediaHandle,
  type PlayHooks,
} from '../media/playback';
import { createRecoveringHlsConnection } from '../media/recoveringHls';

// Start and teardown contract shared by station-audio implementations.
interface AudioProgram {
  start: (hooks?: PlayHooks) => Promise<void>;
  destroy: () => void;
}

const STALL_RECONNECT_MS = 4000;
const DEBUG =
  typeof window !== 'undefined' && new URLSearchParams(location.search).has('debugAudio');

// Create a station-audio player with recovery behavior suited to its source type.
export function createAudioProgram(stream: StationAudio): AudioProgram {
  const audioElement = document.createElement('audio');
  audioElement.preload = 'auto';
  if (DEBUG) logAudioEvents(audioElement);

  return stream.kind === 'hls'
    ? createHlsAudioProgram(stream.url, audioElement)
    : createIcecastAudioProgram(stream.url, audioElement);
}

// Reattach HLS after fatal stream errors while preserving browser playback hooks.
function createHlsAudioProgram(url: string, audioElement: HTMLAudioElement): AudioProgram {
  let playback: MediaHandle | null = null;
  let started = false;
  let destroyed = false;
  let playHooks: PlayHooks | undefined;

  const stopPlayback = (): void => {
    playback?.destroy();
    playback = null;
  };
  const connection = createRecoveringHlsConnection({
    attach: (onFatal) => attachHls(audioElement, url, onFatal),
    onDisconnected: stopPlayback,
    onConnected: () => {
      playback = playWithAudioFallback(audioElement, playHooks);
    },
    onRetry: (error) => console.warn('audio error:', error),
    onRetryError: (error) => {
      console.warn('audio error:', error);
      playHooks?.onError?.(error);
    },
  });

  return {
    start: async (hooks) => {
      if (destroyed || started) return;
      started = true;
      playHooks = hooks;
      try {
        await connection.start();
      } catch (error) {
        started = false;
        throw error;
      }
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      connection.destroy();
      stopAudioElement(audioElement);
    },
  };
}

// Rejoin the Icecast live edge when the element errors or stops advancing.
function createIcecastAudioProgram(url: string, audioElement: HTMLAudioElement): AudioProgram {
  let lastReconnect = 0;
  let playback: MediaHandle | null = null;
  let playHooks: PlayHooks | undefined;
  let started = false;
  let destroyed = false;

  const play = (): void => {
    playback?.destroy();
    playback = playWithAudioFallback(audioElement, playHooks);
  };

  // Reconnecting with a fresh URL rejoins the live edge instead of cached audio.
  const reconnect = (why: string): void => {
    if (destroyed || !started) return;
    const now = Date.now();
    if (now - lastReconnect < STALL_RECONNECT_MS) return;
    lastReconnect = now;
    if (DEBUG) console.log('[audio] reconnect:', why);
    const liveUrl = new URL(url);
    liveUrl.searchParams.set('t', String(now));
    audioElement.src = liveUrl.toString();
    audioElement.load();
    play();
  };

  audioElement.src = url;
  const onAudioError = (): void => reconnect('error');
  audioElement.addEventListener('error', onAudioError);
  const watchdog = startStallWatchdog(audioElement, () => reconnect('stall'));

  return {
    start: async (hooks) => {
      if (destroyed) return;
      started = true;
      playHooks = hooks;
      play();
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      clearInterval(watchdog);
      audioElement.removeEventListener('error', onAudioError);
      playback?.destroy();
      playback = null;
      stopAudioElement(audioElement);
    },
  };
}

function stopAudioElement(audioElement: HTMLAudioElement): void {
  audioElement.pause();
  audioElement.removeAttribute('src');
  audioElement.load();
}

// A live stream is stalled when its clock stops advancing while playback remains active.
function startStallWatchdog(audioElement: HTMLAudioElement, onStall: () => void): number {
  let lastTime = -1;
  let stuckSince = 0;
  return window.setInterval(() => {
    if (audioElement.paused) {
      stuckSince = 0;
      return;
    }
    if (audioElement.currentTime !== lastTime) {
      lastTime = audioElement.currentTime;
      stuckSince = 0;
      return;
    }
    stuckSince ||= performance.now();
    if (performance.now() - stuckSince > STALL_RECONNECT_MS) {
      onStall();
      stuckSince = 0;
    }
  }, 1000);
}

function logAudioEvents(audioElement: HTMLAudioElement): void {
  // Opt-in diagnostics expose the browser events behind audible stalls.
  for (const eventName of ['playing', 'waiting', 'stalled', 'error', 'ended', 'pause']) {
    audioElement.addEventListener(eventName, () =>
      console.log('[audio]', eventName, 'at', audioElement.currentTime.toFixed(1)),
    );
  }
}
