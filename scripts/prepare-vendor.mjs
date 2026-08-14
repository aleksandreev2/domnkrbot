import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js');
const destination = path.join(root, 'public', 'vendor', 'lucide.min.js');

if (!fs.existsSync(source)) {
  throw new Error('Missing lucide@1.27.0. Run npm install before build/deploy.');
}

const content = fs.readFileSync(source, 'utf8');
if (!content.includes('@license lucide v1.27.0') || !content.includes('ISC')) {
  throw new Error('Unexpected Lucide vendor payload; expected lucide v1.27.0 ISC build.');
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
const current = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : null;
if (current !== content) fs.writeFileSync(destination, content);

console.log(`Prepared ${path.relative(root, destination)} from pinned lucide@1.27.0.`);
