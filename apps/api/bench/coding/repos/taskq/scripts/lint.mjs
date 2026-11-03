// Lint: no console.log left in src/.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../src/', import.meta.url);
let problems = 0;
for (const name of readdirSync(dir)) {
  const text = readFileSync(new URL(name, dir), 'utf8');
  text.split('\n').forEach((line, i) => {
    if (/console\.log\(/.test(line)) {
      console.error(join('src', name) + ':' + (i + 1) + ' console.log is not allowed');
      problems++;
    }
  });
}
if (problems > 0) process.exit(1);
console.log('lint: clean');
