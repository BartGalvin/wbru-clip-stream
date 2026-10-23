import type { CurrentPlayout } from '../../shared/contract';
import { routes } from '../../shared/routes';

// Abortable title-refresh callback invoked by the non-overlapping poller.
type Poll = (signal: AbortSignal) => Promise<void>;

// Fetch the current clip for one scheduled output.
export async function fetchCurrentPlayout(
  outputId: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<CurrentPlayout | null> {
  const params = new URLSearchParams({ output: outputId });
  const response = await fetcher(`${routes.programCurrent}?${params}`, {
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`current playout failed: ${response.status}`);
  return (await response.json()) as CurrentPlayout;
}

// Run at most one title refresh at a time.
export function startPolling(poll: Poll, intervalMs: number): () => void {
  let activeController: AbortController | null = null;
  let stopped = false;

  const run = (): void => {
    if (stopped || activeController) return;

    const controller = new AbortController();
    activeController = controller;
    void poll(controller.signal)
      .catch(() => {})
      .finally(() => {
        if (activeController === controller) activeController = null;
      });
  };

  run();
  const timer = globalThis.setInterval(run, intervalMs);

  return () => {
    if (stopped) return;
    stopped = true;
    globalThis.clearInterval(timer);
    activeController?.abort();
  };
}

// Keep one title element synchronized with a scheduled output.
export function mountTitleOverlay(
  outputId: string,
  overlay: HTMLElement,
  title: HTMLElement,
): () => void {
  function hide(): void {
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function show(playout: CurrentPlayout): void {
    title.textContent = playout.publishedYear
      ? `${playout.title} (${playout.publishedYear})`
      : playout.title;
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
  }

  // Show the current title and retain it through brief request failures.
  async function refresh(signal: AbortSignal): Promise<void> {
    try {
      const playout = await fetchCurrentPlayout(outputId, signal);
      if (signal.aborted) return;
      if (playout) show(playout);
      else hide();
    } catch {
      // The next successful poll will update the current title.
    }
  }

  const stopPolling = startPolling(refresh, 1_000);
  return () => {
    stopPolling();
    hide();
  };
}
