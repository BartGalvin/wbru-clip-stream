import './tagger.css';
import { mount, unmount } from 'svelte';
import Tagger from './Tagger.svelte';
import { loadTaggerData, synchronizeCatalog } from './taggerActions';

const CATALOG_SYNC_INTERVAL_MS = 5000;
const mountTarget = document.getElementById('tagger');

if (!mountTarget) throw new Error('missing #tagger element');

const taggerComponent = mount(Tagger, { target: mountTarget });
let catalogSyncIntervalId: number | null = null;
let isStopped = false;

// Poll lightweight revisions after the initial catalog request settles.
const startCatalogSync = (): void => {
  if (isStopped) return;
  catalogSyncIntervalId = window.setInterval(() => {
    if (!isStopped) void synchronizeCatalog();
  }, CATALOG_SYNC_INTERVAL_MS);
};

// Start polling after the initial request, including a failed one, so the page can recover.
void loadTaggerData().then(startCatalogSync, startCatalogSync);

// Cached pages retain their component and poller; the browser freezes and resumes both.
function onPageHide(event: PageTransitionEvent): void {
  if (!event.persisted) teardownTagger();
}

// Stop polling and release Svelte state on a final navigation or hot replacement.
function teardownTagger(): void {
  if (isStopped) return;
  isStopped = true;
  window.removeEventListener('pagehide', onPageHide);
  if (catalogSyncIntervalId !== null) window.clearInterval(catalogSyncIntervalId);
  void unmount(taggerComponent);
}

window.addEventListener('pagehide', onPageHide);
import.meta.hot?.dispose(teardownTagger);
