import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function extensionId(publicKey) {
  return Array.from(createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest().subarray(0, 16)).map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
}
export function updateLocalEnvironment(source, values) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  for (const [key, value] of Object.entries(values)) {
    let updated = false;
    for (let index = 0; index < lines.length; index++) if (new RegExp('^' + key + '\\s*=').test(lines[index])) { lines[index] = updated ? '' : key + '=' + value; updated = true; }
    if (!updated) lines.push(key + '=' + value);
  }
  return lines.join(newline);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const file = path.join(process.cwd(), '.env.local');
  const source = await readFile(file, 'utf8'); // Nunca imprime ou copia segredos.
  if (process.argv.includes('--baileys')) {
    await writeFile(file, updateLocalEnvironment(source, { WHATSAPP_INTEGRATION_MODE: 'baileys' }));
    console.log('Modo local definido como Baileys. Reinicie npm run dev.');
  } else {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), 'chrome-extension', 'manifest.json'), 'utf8'));
    if (!manifest.key) throw new Error('Chave pública da extensão ausente.');
    const id = extensionId(manifest.key);
    const packaged = spawnSync(process.execPath, ['scripts/package-whatsapp-extension.mjs'], { stdio: 'inherit' });
    if (packaged.status !== 0) throw new Error('Não foi possível preparar o pacote.');
    await writeFile(file, updateLocalEnvironment(source, { WHATSAPP_INTEGRATION_MODE: 'chrome_extension', NEXT_PUBLIC_WHATSAPP_EXTENSION_ID: id, APP_URL: 'http://localhost:3000', WHATSAPP_EXTENSION_WORKER_URL: '' }));
    console.log('Configuração local pronta. ID público da extensão: ' + id + '\nReinicie o Mônada na porta 3000 e instale chrome-extension/dist. Nenhum serviço de produção foi alterado.');
  }
}
