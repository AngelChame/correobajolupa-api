import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocument } from './document.js';

export const CONTRACT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../contract/openapi.json');

export function render(): string {
  return JSON.stringify(buildDocument(), null, 2) + '\n';
}

// Solo se ejecuta al llamarlo directamente (npm run contract:generate).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(dirname(CONTRACT_PATH), { recursive: true });
  writeFileSync(CONTRACT_PATH, render());
  console.log(`Contrato escrito en ${CONTRACT_PATH}`);
}
