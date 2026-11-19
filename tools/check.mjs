import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await fs.readFile(new URL('orca-plugin.json',root),'utf8'));
const files = [];
async function walk(url) {
  for (const item of await fs.readdir(url,{withFileTypes:true})) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const child = new URL(item.name+(item.isDirectory()?'/':''),url);
    if (item.isDirectory()) await walk(child);
    else if (/\.(mjs|js)$/.test(item.name)) files.push(child);
  }
}
await walk(root);
for (const file of files) execFileSync(process.execPath,['--check',fileURLToPath(file)],{stdio:'pipe'});
for (const file of [manifest.main,...manifest.contributes.panels.map(p=>p.entry)]) await fs.access(new URL(file,root));
if (manifest.id.startsWith('orca-')) throw new Error('Reserved Orca plugin ID');
if (manifest.manifestVersion !== 2 || manifest.execution !== 'trusted-worker') throw new Error('Invalid manifest profile');
if (!manifest.contributes.statusBarItems?.length) throw new Error('Durable worker needs a status item');
const readme = await fs.readFile(new URL('README.md',root),'utf8');
if (!readme.includes('orca plugin install')) throw new Error('README must include install instructions');
console.log('Syntax checked '+files.length+' JavaScript modules; manifest entries and installation docs are present.');
