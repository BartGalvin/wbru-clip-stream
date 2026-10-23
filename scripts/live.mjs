import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// Usage: npm run live -- [clip.mp4]

const input = process.argv[2];
mkdirSync('public/live', { recursive: true });

const inputArgs = input
  ? ['-stream_loop', '-1', '-i', input, '-c:a', 'aac', '-ar', '44100']
  : ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-an'];

// Produce a short sliding HLS window suitable for local live-playback testing.
const ffmpegArgs = [
  '-hide_banner',
  '-loglevel',
  'warning',
  '-re',
  ...inputArgs,
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-tune',
  'zerolatency',
  '-g',
  '60', // 2-second keyframe interval at 30 fps
  '-pix_fmt',
  'yuv420p',
  '-f',
  'hls',
  '-hls_time',
  '2',
  '-hls_list_size',
  '6',
  '-hls_flags',
  'delete_segments+omit_endlist+independent_segments',
  '-hls_segment_filename',
  'public/live/seg_%05d.ts',
  'public/live/stream.m3u8',
];

console.log('Live HLS at /live/stream.m3u8. Press Ctrl+C to stop.');
const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: 'inherit' });
ffmpeg.on('error', (error) => {
  console.error('Could not run ffmpeg. Install it with `brew install ffmpeg`.');
  console.error(error.message);
  process.exit(1);
});
ffmpeg.on('exit', (code) => process.exit(code ?? 0));
