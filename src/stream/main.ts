import { createAudioProgram } from '../audio/audioProgram';
import { createPlaybackCheckpointStore } from '../content/playbackCheckpoint';
import { createVideoProgram } from '../video/videoProgram';
import { activeProgram, isStationAudio } from '../../shared/contract';
import { isEmptyTagFilter, parseTagFilter } from '../../shared/tagFilter';
import { renderTitleOverlay } from '../title/titleOverlay';
import { waitForChannel, waitForProgramPosition } from './channel';
import '../title/title.css';
import './stream.css';

// Read the requested program and display controls once for this page session.
const params = new URLSearchParams(location.search);
const channelId = params.get('channel') ?? undefined;
const filter = parseTagFilter((key) => params.get(key));
const stageElement = document.getElementById('stream');
const message = document.getElementById('message');
const audioHint = document.getElementById('audio-hint');
const titleOverlayElement = document.getElementById('title-overlay');
const videoTitleElement = document.getElementById('video-title');

if (!stageElement || !titleOverlayElement || !videoTitleElement) {
  throw new Error('missing stream elements');
}
const stage: HTMLElement = stageElement;
const titleOverlay: HTMLElement = titleOverlayElement;
const videoTitle: HTMLElement = videoTitleElement;
let stopCurrentStream: (() => void) | null = null;

function urlFlag(name: string): boolean {
  const value = params.get(name);
  return value !== null && !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
}

// Create a playback session that can be restarted after Back navigation.
function startStream(): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  let video: ReturnType<typeof createVideoProgram> | null = null;
  let audio: ReturnType<typeof createAudioProgram> | null = null;

  function showStatus(text: string | null): void {
    if (signal.aborted || !message) return;
    message.textContent = text ?? '';
    message.hidden = text === null;
  }

  function setAudioHintVisible(visible: boolean): void {
    if (!signal.aborted && audioHint) audioHint.hidden = !visible;
  }

  function stop(): void {
    if (signal.aborted) return;
    // Video teardown saves its final checkpoint before callbacks are disabled.
    video?.destroy();
    controller.abort();
    audio?.destroy();
    renderTitleOverlay(titleOverlay, videoTitle, null);
  }

  // Resolve the channel, join its timeline, then start video and optional station audio.
  async function start(): Promise<void> {
    try {
      const channel = await waitForChannel(channelId, {
        signal,
        onRetry: () => showStatus('Program server unavailable. Retrying...'),
      });
      if (signal.aborted) return;

      const program = activeProgram(channel);
      const embeddedAudio = program.audio.kind === 'embedded';
      const playHooks = {
        onBlocked: () => setAudioHintVisible(true),
        onResumed: () => setAudioHintVisible(false),
      };
      const followsServerTimeline =
        program.video.kind === 'clips' && channel.timeline === 'server' && isEmptyTagFilter(filter);
      // Unfiltered server-timed channels join once; other clip programs resume locally.
      const checkpointStore =
        program.video.kind === 'clips' && !followsServerTimeline
          ? createPlaybackCheckpointStore(channel.id, filter)
          : null;
      const resumeFrom = followsServerTimeline
        ? await waitForProgramPosition(channel.id, {
            signal,
            onRetry: () => showStatus('Program position unavailable. Retrying...'),
          })
        : checkpointStore?.load();
      if (signal.aborted) return;
      video = createVideoProgram(program.video, {
        stage,
        muted: !embeddedAudio,
        playHooks: embeddedAudio ? playHooks : undefined,
        onStatus: showStatus,
        clip: {
          channelId: channel.id,
          filter,
          resumeFrom,
          onClipStart:
            channel.titleOutputId && followsServerTimeline
              ? (clip) => {
                  if (!signal.aborted) renderTitleOverlay(titleOverlay, videoTitle, clip);
                }
              : undefined,
          onPlaybackUpdate: checkpointStore
            ? (checkpoint) => {
                if (!signal.aborted) checkpointStore.save(checkpoint);
              }
            : undefined,
        },
      });
      // Separate station audio is opt-in because browsers block unprompted sound.
      if (urlFlag('audio') && isStationAudio(program.audio)) {
        audio = createAudioProgram(program.audio);
        await audio.start(playHooks);
      }
      if (signal.aborted) return;
      await video.start();
    } catch (error) {
      if (signal.aborted) return;
      showStatus(error instanceof Error ? error.message : String(error));
      stop();
    }
  }

  showStatus(null);
  setAudioHintVisible(false);
  void start();
  return stop;
}

function stop(): void {
  stopCurrentStream?.();
  stopCurrentStream = null;
}

function onPageHide(event: PageTransitionEvent): void {
  if (event.persisted) stop();
  else dispose();
}

function onPageShow(event: PageTransitionEvent): void {
  if (event.persisted && !stopCurrentStream) stopCurrentStream = startStream();
}

function dispose(): void {
  window.removeEventListener('pagehide', onPageHide);
  window.removeEventListener('pageshow', onPageShow);
  stop();
}

window.addEventListener('pagehide', onPageHide);
window.addEventListener('pageshow', onPageShow);
import.meta.hot?.dispose(dispose);

stopCurrentStream = startStream();
