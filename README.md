# WBRU Stream

WBRU Stream plays a library of video clips continuously in a browser, with radio audio
or the video's own sound. It includes tools for organizing clips, choosing what plays,
and reviewing the playout history. Use the stream directly or as an OBS Browser Source.

## Using the app

- **Tagger (`/tag`)**: browse folders, preview clips, and edit tags and source labels.
  Check several clips to edit them together; **Undo** reverses recent tagging changes.
- **Stream builder (`/builder`)**: choose a channel, include or exclude tags, and copy
  the resulting stream URL.
- **Stream (`/stream` or `/`)**: watch the clip rotation. The default includes all
  eligible visualizer clips. Named channels are `indie`, `360`, and `wbru-tv`.
- **Playout log (`/playout`)**: search clip titles and filenames, jump to a date and
  time, and preview clips. Entries show the server's scheduled play times.

Untagged visualizer clips and clips tagged `inactive` do not play. Folder names organize
the library but do not assign tags. A clip's **Source** label identifies its original film,
session, or recording.

## Run locally

Install Node 26 (the version in [.nvmrc](.nvmrc)) and ffmpeg, including `ffprobe`.
Building the SQLite dependency from source also requires Python 3 and C/C++ build tools.
The commands below use nvm to select Node.

```bash
nvm use
npm ci
mkdir -p public/clips
```

Put a few browser-playable videos in `public/clips/`, then index them and start the API:

```bash
npm run index-clips
npm run dev:api
```

In a second terminal, from the same directory:

```bash
nvm use
npm run dev:web
```

Open the local address printed by Vite and navigate to `/tag`. Use **Manage** under
**Tags** to create a tag, select a clip, and assign the tag in its details pane.
Then open `/stream` to watch.

Use **Refresh** in the tagger after adding, moving, or deleting video files. Local tags
and source labels are stored in `server/program.db`; the video files stay in
`public/clips/`.

## Media endpoints

Set these optional values in an ignored `.env` file; `.env.example` lists the settings:

```dotenv
RADIO_INDIE_URL=
RADIO_360_URL=
YOUTUBE_CHANNEL_URL=
```

Use your station's URLs. A blank radio URL disables that channel's external audio;
WBRU TV still uses the video's sound. YouTube downloads require `YOUTUBE_CHANNEL_URL`.
The API and downloader npm commands load `.env`; restart the API after changing it.
For a hosted installation, set these values in the service's environment as well.

## Use with OBS

Add a **Browser Source**, set it to **1920x1080**, and use a stream URL from the builder.
Enable radio audio in the builder when needed. WBRU TV uses the video's own audio and
displays its title and publication year. If a browser blocks sound, click the page to start it.

## Further reading

- [Deployment](deploy/README.md): configuration and release tools.
- [Contributing](CONTRIBUTING.md): code layout and testing.
- [Architecture](docs/architecture.md): the catalog, playback, and scheduling.

## License

All rights reserved. See [LICENSE](LICENSE).
