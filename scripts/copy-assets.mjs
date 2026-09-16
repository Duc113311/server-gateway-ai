// tsc only emits JavaScript, so the dashboard's HTML/CSS/JS would be missing
// from dist/ and every admin page would 404 in production. Copied here rather
// than with a shell command so the build works the same on Windows and Linux.
import { cpSync, existsSync } from 'node:fs';

const from = 'src/admin/public';
const to = 'dist/admin/public';

if (!existsSync(from)) {
  console.error(`copy-assets: ${from} is missing`);
  process.exit(1);
}

cpSync(from, to, { recursive: true });
console.log(`copy-assets: ${from} -> ${to}`);
