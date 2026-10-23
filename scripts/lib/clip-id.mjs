import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;

// Build a path-independent id from the file size and fixed content samples.
export function fingerprintId(absolutePath) {
  const { size } = statSync(absolutePath);
  const hash = createHash('sha256').update(String(size));
  const fileDescriptor = openSync(absolutePath, 'r');
  try {
    const headLength = Math.min(HEAD_BYTES, size);
    if (headLength) {
      const head = Buffer.alloc(headLength);
      readSync(fileDescriptor, head, 0, headLength, 0);
      hash.update(head);
    }
    if (size > HEAD_BYTES) {
      const tailLength = Math.min(TAIL_BYTES, size - HEAD_BYTES);
      const tail = Buffer.alloc(tailLength);
      readSync(fileDescriptor, tail, 0, tailLength, size - tailLength);
      hash.update(tail);
    }
  } finally {
    closeSync(fileDescriptor);
  }
  return `clp_${hash.digest('hex').slice(0, 16)}`;
}
