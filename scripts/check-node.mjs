import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const versionFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.nvmrc');
const requiredMajor = Number(readFileSync(versionFile, 'utf8').trim().split('.')[0]);
const currentMajor = Number(process.versions.node.split('.')[0]);
if (currentMajor !== requiredMajor) {
  console.error(
    `Node ${requiredMajor} is required; found ${process.versions.node}. Run nvm use and reinstall dependencies.`,
  );
  process.exit(1);
}
