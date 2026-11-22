import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const isStore = process.argv.includes('--store');
const target = path.resolve(root, 'chrome-extension', isStore ? 'store' : 'dist');
if (!target.startsWith(path.resolve(root, 'chrome-extension') + path.sep)) throw new Error('Destino inválido.');

const originArg = process.argv.find(a => a.startsWith('--origin='));
if (isStore && !originArg) throw new Error('Informe --origin=https://seu-dominio para empacotar para a Chrome Web Store.');
const origins = originArg ? [new URL(originArg.slice(9)).origin] : ['http://localhost:3000', 'http://127.0.0.1:3000'];
for (const origin of origins) {
  const url = new URL(origin);
  if (isStore) {
    if (url.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('A Chrome Web Store exige uma origem HTTPS pública (sem localhost).');
    }
  } else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Origem de aplicação inválida.');
  }
}

await rm(target, { recursive: true, force: true });
await mkdir(path.join(target, 'poc', 'lib'), { recursive: true });
await mkdir(path.join(target, 'shared'), { recursive: true });
await mkdir(path.join(target, 'icons'), { recursive: true });

for (const name of ['engine.mjs', 'domain.mjs']) await copyFile(path.join(root, 'workers', 'whatsapp-extension', name), path.join(target, 'shared', name));
const localEngine = await readFile(path.join(root, 'chrome-extension', 'local-engine.mjs'), 'utf8');
await writeFile(path.join(target, 'local-engine.mjs'), localEngine.replaceAll('../workers/whatsapp-extension/', './shared/'));
for (const name of ['background.mjs', 'collector.mjs', 'storage.mjs', 'session.mjs', 'runner.mjs', 'runner.html']) await copyFile(path.join(root, 'chrome-extension', name), path.join(target, name));
for (const name of ['devtools-collector.js', 'main-world-bridge.js', 'lib/poc-core.js', 'lib/poc-media.js']) await copyFile(path.join(root, 'poc-chrome-whatsapp', name), path.join(target, 'poc', name));
for (const size of ['16', '32', '48', '128']) await copyFile(path.join(root, 'chrome-extension', 'icons', `icon-${size}.png`), path.join(target, 'icons', `icon-${size}.png`));

const manifest = JSON.parse(await readFile(path.join(root, 'chrome-extension', 'manifest.json'), 'utf8'));
if (isStore) delete manifest.key;
manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(/connect-src[^;]*/, 'connect-src ' + origins.join(' '));
manifest.host_permissions = ['https://web.whatsapp.com/*', ...origins.map(o => new URL(o).protocol + '//' + new URL(o).hostname + '/*')];
manifest.externally_connectable.matches = origins.map(o => new URL(o).protocol + '//' + new URL(o).hostname + '/*');

await writeFile(path.join(target, 'origins.mjs'), 'export const APP_ORIGINS = ' + JSON.stringify(origins) + ';\n');
await writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

if (isStore) {
  const zipPath = path.resolve(root, 'chrome-extension', `followup-monada-whatsapp-${manifest.version}.zip`);
  await rm(zipPath, { force: true });
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `$ProgressPreference = 'SilentlyContinue'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${target}', '${zipPath}', [System.IO.Compression.CompressionLevel]::Optimal, $false)`], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-r', zipPath, '.'], { cwd: target, stdio: 'inherit' });
  }
  console.log('Pacote da Chrome Web Store gerado em: ' + zipPath);
} else {
  console.log('Extensão preparada em: ' + target + '\nCarregue essa pasta no Chrome e configure NEXT_PUBLIC_WHATSAPP_EXTENSION_ID com o ID mostrado em chrome://extensions.');
}
