import type { ChannelInfo, TaggableClip } from '../../shared/contract';
import { routes } from '../../shared/routes';

// Data needed to open the stream builder.
interface BuilderData {
  vocab: string[];
  clips: TaggableClip[];
  channels: ChannelInfo[];
  defaultChannel: ChannelInfo;
}

async function getJson<T>(fetcher: typeof fetch, url: string): Promise<T> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return (await response.json()) as T;
}

// The playback default is resolved separately from the viewer-facing channel list.
export async function fetchBuilderData(fetcher: typeof fetch = fetch): Promise<BuilderData> {
  const [vocab, clips, channels, defaultChannel] = await Promise.all([
    getJson<string[]>(fetcher, routes.tagsVocab),
    getJson<TaggableClip[]>(fetcher, routes.tagsClips),
    getJson<ChannelInfo[]>(fetcher, routes.channels),
    getJson<ChannelInfo>(fetcher, routes.channel),
  ]);
  return { vocab, clips, channels, defaultChannel };
}
