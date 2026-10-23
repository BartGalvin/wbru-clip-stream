// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChannelInfo, ProgramPosition } from '../../shared/contract';
import { createAudioProgram } from '../audio/audioProgram';
import { createPlaybackCheckpointStore } from '../content/playbackCheckpoint';
import { mountTitleOverlay } from '../title/titleFeed';
import { createVideoProgram } from '../video/videoProgram';
import { waitForChannel, waitForProgramPosition } from './channel';

vi.mock('../audio/audioProgram', () => ({ createAudioProgram: vi.fn() }));
vi.mock('../content/playbackCheckpoint', () => ({ createPlaybackCheckpointStore: vi.fn() }));
vi.mock('../title/titleFeed', () => ({ mountTitleOverlay: vi.fn() }));
vi.mock('../video/videoProgram', () => ({ createVideoProgram: vi.fn() }));
vi.mock('./channel', () => ({ waitForChannel: vi.fn(), waitForProgramPosition: vi.fn() }));

const channel: ChannelInfo = {
  id: 'wbru-tv',
  name: 'WBRU TV',
  timeline: 'server',
  titleOutputId: 'tv',
  program: {
    video: {
      kind: 'clips',
      library: 'visualizer',
      filter: { includeTags: [], excludeTags: [], matchAll: false },
    },
    audio: { kind: 'icecast', url: '/test-audio' },
  },
};
const position: ProgramPosition = {
  clip: {
    clipId: 'clip-1',
    title: 'Studio Session',
    url: '/clips/session.mp4',
    durationSec: 60,
    cursor: 'cursor-1',
    tags: [],
  },
  timeSec: 18,
};

function player() {
  return { start: vi.fn<() => Promise<void>>().mockResolvedValue(), destroy: vi.fn() };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function navigate(type: 'pagehide' | 'pageshow', persisted: boolean): void {
  // Happy DOM aliases PageTransitionEvent to Event without its persisted property.
  const event = new Event(type);
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

async function openPage(): Promise<void> {
  await import('./main');
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected fetch')));
  window.history.replaceState({}, '', '/stream?channel=wbru-tv&audio=1');
  document.body.innerHTML = `
    <div id="stream"></div><div id="title-overlay"></div><div id="video-title"></div>
    <div id="message" hidden></div><div id="audio-hint" hidden></div>`;
  vi.mocked(waitForChannel).mockResolvedValue(channel);
  vi.mocked(waitForProgramPosition).mockResolvedValue(position);
  vi.mocked(createAudioProgram).mockImplementation(player);
  vi.mocked(createVideoProgram).mockImplementation((_source, options) => ({
    start: vi.fn(async () => options.onStatus(null)),
    destroy: vi.fn(),
  }));
  vi.mocked(mountTitleOverlay).mockImplementation(() => vi.fn());
});

afterEach(() => {
  navigate('pagehide', false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('rejoins the current position with fresh players and cancellation on each cached restoration', async () => {
  await openPage();
  navigate('pageshow', false);
  expect(waitForChannel).toHaveBeenCalledOnce();

  for (let run = 0; run < 2; run += 1) {
    const oldSignal = vi.mocked(waitForChannel).mock.calls[run][1].signal;
    const oldVideo = vi.mocked(createVideoProgram).mock.results[run].value;
    const oldAudio = vi.mocked(createAudioProgram).mock.results[run].value;
    const oldOverlay = vi.mocked(mountTitleOverlay).mock.results[run].value;
    navigate('pagehide', true);
    expect(oldSignal.aborted).toBe(true);
    expect(oldVideo.destroy).toHaveBeenCalledOnce();
    expect(oldAudio.destroy).toHaveBeenCalledOnce();
    expect(oldOverlay).toHaveBeenCalledOnce();

    const currentPosition = { ...position, timeSec: position.timeSec + run + 1 };
    vi.mocked(waitForProgramPosition).mockResolvedValue(currentPosition);
    navigate('pageshow', true);
    navigate('pageshow', true);
    await vi.advanceTimersByTimeAsync(0);

    expect(waitForChannel).toHaveBeenCalledTimes(run + 2);
    expect(waitForProgramPosition).toHaveBeenCalledTimes(run + 2);
    const newSignal = vi.mocked(waitForChannel).mock.calls[run + 1][1].signal;
    expect(newSignal).not.toBe(oldSignal);
    expect(newSignal.aborted).toBe(false);
    expect(vi.mocked(waitForProgramPosition).mock.calls[run + 1][1].signal).toBe(newSignal);
    expect(vi.mocked(createVideoProgram).mock.calls[run + 1][1].clip?.resumeFrom).toEqual(
      currentPosition,
    );
    expect(vi.mocked(createVideoProgram).mock.results[run + 1].value.start).toHaveBeenCalledOnce();
  }
});

it.each(['channel', 'position'] as const)('keeps permanent %s errors visible', async (phase) => {
  const request = phase === 'channel' ? waitForChannel : waitForProgramPosition;
  vi.mocked(request).mockRejectedValueOnce(new Error(`${phase} request failed: 404`));
  await openPage();

  expect(document.getElementById('message')?.textContent).toBe(`${phase} request failed: 404`);
  expect(document.getElementById('message')?.hidden).toBe(false);
  expect(createVideoProgram).not.toHaveBeenCalled();
});

it.each([
  ['channel', 'resolve'],
  ['channel', 'reject'],
  ['position', 'resolve'],
  ['position', 'reject'],
  ['audio', 'resolve'],
  ['audio', 'reject'],
  ['video', 'resolve'],
  ['video', 'reject'],
])('ignores an old %s startup that later %ss after restoration', async (phase, outcome) => {
  const pending = deferred();
  const oldAudio = player();
  const oldVideo = player();
  if (phase === 'channel') {
    vi.mocked(waitForChannel).mockImplementationOnce(async () => {
      await pending.promise;
      return channel;
    });
  } else if (phase === 'position') {
    vi.mocked(waitForProgramPosition).mockImplementationOnce(async () => {
      await pending.promise;
      return position;
    });
  } else {
    (phase === 'audio' ? oldAudio : oldVideo).start.mockReturnValueOnce(pending.promise);
    vi.mocked(createAudioProgram).mockReturnValueOnce(oldAudio);
    vi.mocked(createVideoProgram).mockReturnValueOnce(oldVideo);
  }
  await openPage();
  navigate('pagehide', true);
  navigate('pageshow', true);
  await vi.advanceTimersByTimeAsync(0);
  const currentVideo = vi.mocked(createVideoProgram).mock.results.at(-1)!.value;
  const currentAudio = vi.mocked(createAudioProgram).mock.results.at(-1)!.value;
  const videoCount = vi.mocked(createVideoProgram).mock.calls.length;
  const positionCount = vi.mocked(waitForProgramPosition).mock.calls.length;
  const currentOptions = vi.mocked(createVideoProgram).mock.calls.at(-1)![1];
  currentOptions.onStatus('Current stream');

  if (outcome === 'resolve') pending.resolve();
  else pending.reject(new Error('stale startup failed'));
  await vi.advanceTimersByTimeAsync(0);

  expect(createVideoProgram).toHaveBeenCalledTimes(videoCount);
  expect(waitForProgramPosition).toHaveBeenCalledTimes(positionCount);
  expect(currentVideo.start).toHaveBeenCalledOnce();
  expect(currentVideo.destroy).not.toHaveBeenCalled();
  expect(currentAudio.destroy).not.toHaveBeenCalled();
  expect(document.getElementById('message')?.textContent).toBe('Current stream');
  if (phase === 'audio' || phase === 'video') {
    expect(oldVideo.destroy).toHaveBeenCalledOnce();
    expect(oldAudio.destroy).toHaveBeenCalledOnce();
    if (phase === 'audio') expect(oldVideo.start).not.toHaveBeenCalled();
    vi.mocked(createVideoProgram).mock.calls[0][1].onStatus('Stale status');
    expect(document.getElementById('message')?.textContent).toBe('Current stream');
  }
});

it('saves the final checkpoint on teardown but ignores late callbacks after restoration', async () => {
  let savedPosition = position;
  const finalPosition = { ...position, timeSec: position.timeSec + 1 };
  const checkpoint = {
    load: vi.fn(() => savedPosition),
    save: vi.fn((next: ProgramPosition) => {
      savedPosition = next;
    }),
  };
  vi.mocked(createPlaybackCheckpointStore).mockReturnValue(checkpoint);
  vi.mocked(waitForChannel).mockResolvedValue({
    ...channel,
    timeline: undefined,
    program: { ...channel.program, audio: { kind: 'embedded' } },
  });
  vi.mocked(createVideoProgram).mockImplementationOnce((_source, options) => ({
    ...player(),
    destroy: vi.fn(() => options.clip?.onPlaybackUpdate?.(finalPosition)),
  }));
  await openPage();
  const oldOptions = vi.mocked(createVideoProgram).mock.calls[0][1];
  navigate('pagehide', true);
  expect(checkpoint.save).toHaveBeenCalledOnce();
  expect(checkpoint.save).toHaveBeenCalledWith(finalPosition);
  checkpoint.save.mockClear();
  navigate('pageshow', true);
  await vi.advanceTimersByTimeAsync(0);
  oldOptions.onStatus('Stale status');
  oldOptions.playHooks?.onBlocked?.();
  oldOptions.clip?.onPlaybackUpdate?.(position);

  expect(document.getElementById('message')?.hidden).toBe(true);
  expect(document.getElementById('audio-hint')?.hidden).toBe(true);
  expect(checkpoint.save).not.toHaveBeenCalled();
  expect(waitForProgramPosition).not.toHaveBeenCalled();
  const currentOptions = vi.mocked(createVideoProgram).mock.calls[1][1];
  expect(currentOptions.clip?.resumeFrom).toEqual(finalPosition);
  currentOptions.playHooks?.onBlocked?.();
  oldOptions.playHooks?.onResumed?.();
  currentOptions.clip?.onPlaybackUpdate?.(position);
  expect(document.getElementById('audio-hint')?.hidden).toBe(false);
  expect(checkpoint.save).toHaveBeenCalledWith(position);
});

it('releases listeners and players on a final navigation', async () => {
  await openPage();
  const video = vi.mocked(createVideoProgram).mock.results[0].value;
  navigate('pagehide', false);
  navigate('pageshow', true);
  await vi.advanceTimersByTimeAsync(0);
  expect(video.destroy).toHaveBeenCalledOnce();
  expect(waitForChannel).toHaveBeenCalledOnce();
});
