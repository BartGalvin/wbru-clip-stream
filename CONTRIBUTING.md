# Contributing

Start with the [local setup](README.md#run-locally). Use a few local clips for development.

## Finding the code

- `src/tagger/`, `src/builder/`, and `src/playout/` contain the Svelte operator pages.
- `src/stream/`, `src/video/`, and `src/audio/` handle playback; `src/title/` supplies
  the WBRU TV overlay.
- `server/src/` contains the API, catalog, and playback ordering. Channel configuration
  lives in `server/src/config/`.
- `shared/` contains the API types and tag-filter rules used by the browser and server.
- `scripts/` contains indexing and download tools; `deploy/` contains server setup and
  release scripts.

The four root HTML files are Vite page entry points. For example, `playout.html` loads
`src/playout/main.ts`. Edit source files and rebuild to update `dist/`.
The [architecture guide](docs/architecture.md) explains the data flow.

## Making a change

Work on a branch and open a pull request explaining the change and how you tested it.
Include a screenshot for interface changes.

Follow nearby code conventions. Use specific names such as `ChannelInfo` rather than
`Info`, and `isUntagged` rather than `blank`. Write comments that explain non-obvious
rules and responsibilities.

Unit tests live beside their source files; server integration tests are in `server/test/`.
Before opening a pull request, run:

```bash
npm run lint
npm test
npm run build
```

The build includes TypeScript and Svelte checks. A pre-commit hook formats and lints staged
files. Keep clips, databases, and credentials out of Git.

Use the [deployment guide](deploy/README.md#deploy-code) when a change is ready to release.
