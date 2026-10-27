#!/usr/bin/env node
// Publishes a web plugin into the catalogue: copies <dir>/plugin.js to
// catalog/bundles/<id>-<version>.js, pins its SHA-256 and adds/updates the entry in
// catalog/plugins.json from <dir>/plugin.json (the entry without bundleUrl/sha256).
//   node tools/build-plugin.mjs examples/plugins/hello-shelf
// A published version is immutable: building the same version with different code fails; bump it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const dir = resolve(process.argv[2] || '');
const meta = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
const code = readFileSync(join(dir, 'plugin.js'), 'utf8');
if (meta.kind !== 'web') throw new Error('Only web plugins are built here (service plugins: see docs/PLUGINS.md)');
if (!new RegExp(`id:\\s*'${meta.id.replace(/\./g, '\\.')}'`).test(code)) throw new Error(`plugin.js does not register id ${meta.id}`);
if (!code.includes(`version: '${meta.version}'`)) throw new Error(`plugin.js version differs from plugin.json (${meta.version})`);

const sha256 = createHash('sha256').update(code, 'utf8').digest('hex');
const name = `${meta.id}-${meta.version}.js`;
const bundle = join(APP, 'catalog/bundles', name);
mkdirSync(join(APP, 'catalog/bundles'), { recursive: true });
if (existsSync(bundle) && readFileSync(bundle, 'utf8') !== code) {
  throw new Error(`${name} is already published with different code; bump the version`);
}
writeFileSync(bundle, code);

const catPath = join(APP, 'catalog/plugins.json');
const cat = JSON.parse(readFileSync(catPath, 'utf8'));
const entry = { ...meta, bundleUrl: `bundles/${name}`, sha256 };
const i = cat.plugins.findIndex((p) => p.id === meta.id);
if (i === -1) cat.plugins.push(entry); else cat.plugins[i] = entry;
cat.updated = new Date().toISOString().slice(0, 10);
writeFileSync(catPath, JSON.stringify(cat, null, 2) + '\n');
console.log(`${name}  sha256 ${sha256}`);
