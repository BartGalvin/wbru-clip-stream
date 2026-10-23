import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// Usage: npm run fetch -- <url> [name]

const url = process.argv[2];
const name = process.argv[3] ?? 'sample';
const outputDir = 'public/clips';

if (!url) {
  console.error('Usage: npm run fetch -- <url> [name]');
  console.error('Saves to public/clips/<name>.mp4 (default: sample.mp4).');
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

// Prefer a browser-compatible MP4 while retaining a fallback for less common sources.
const downloadArgs = [
  '-f',
  'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best',
  '--merge-output-format',
  'mp4',
  '-o',
  `${outputDir}/${name}.%(ext)s`,
  url,
];

const downloadProcess = spawn('yt-dlp', downloadArgs, { stdio: 'inherit' });

downloadProcess.on('error', (error) => {
  console.error('Could not run yt-dlp. Install it with: brew install yt-dlp');
  console.error(error.message);
  process.exit(1);
});

downloadProcess.on('exit', (code) => {
  if (code === 0) {
    console.log(`\nSaved ${outputDir}/${name}.mp4 - refresh the clip catalog to include it.`);
  }
  process.exit(code ?? 1);
});
