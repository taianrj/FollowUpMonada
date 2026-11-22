'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MonadaWaPocMedia = factory();
})(globalThis, function () {
  const MAX_BYTES = 32 * 1024 * 1024;
  function assertOggOpus(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 47 || bytes.length > MAX_BYTES) throw new Error('Áudio Ogg/Opus ausente ou excede 32 MiB.');
    let offset = 0;
    let pages = 0;
    const sequences = new Map();
    while (offset < bytes.length) {
      if (offset + 27 > bytes.length || String.fromCharCode(...bytes.subarray(offset, offset + 4)) !== 'OggS' || bytes[offset + 4] !== 0) throw new Error('Página Ogg inválida ou truncada.');
      const segments = bytes[offset + 26];
      if (offset + 27 + segments > bytes.length) throw new Error('Tabela Ogg truncada.');
      let length = 27 + segments;
      for (let i = 0; i < segments; i++) length += bytes[offset + 27 + i];
      if (offset + length > bytes.length) throw new Error('Payload Ogg truncado.');
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
      const serial = view.getUint32(14, true);
      const sequence = view.getUint32(18, true);
      if (sequences.has(serial) && sequence !== sequences.get(serial) + 1) throw new Error('Sequência de páginas Ogg incompleta.');
      sequences.set(serial, sequence);
      let crc = 0;
      for (let i = 0; i < length; i++) {
        crc = (crc ^ ((i >= 22 && i < 26 ? 0 : bytes[offset + i]) << 24)) >>> 0;
        for (let bit = 0; bit < 8; bit++) crc = ((crc & 0x80000000) ? (crc << 1) ^ 0x04c11db7 : crc << 1) >>> 0;
      }
      if (crc !== view.getUint32(22, true)) throw new Error('Checksum Ogg inválido.');
      if (pages === 0) {
        const start = offset + 27 + segments;
        if (!(bytes[offset + 5] & 2) || sequence !== 0 || String.fromCharCode(...bytes.subarray(start, start + 8)) !== 'OpusHead') throw new Error('Cabeçalho Opus ausente.');
      }
      offset += length;
      pages++;
    }
    // Alguns áudios válidos do WhatsApp não possuem flag EOS: não a exigir.
    return pages;
  }

  async function decodeInBrowser(bytes) {
    const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!Context) throw new Error('Decodificador de áudio indisponível; recuperação não confirmada.');
    const context = new Context(1, 1, 48000);
    let timer;
    try {
      const decoded = await Promise.race([
        context.decodeAudioData(bytes.slice().buffer),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Tempo limite na validação do áudio.')), 20000); })
      ]);
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.length <= 0) throw new Error('Áudio sem conteúdo decodificável.');
      return decoded.duration;
    } finally { clearTimeout(timer); }
  }

  async function validatedDataUrl(bytes, mimetype = 'audio/ogg', expectedDuration) {
    const mime = String(mimetype).split(';')[0].trim().toLowerCase();
    const allowed = ['audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/webm'];
    if (!allowed.includes(mime) || !bytes.length || bytes.length > MAX_BYTES) throw new Error('Tipo ou tamanho de áudio inválido.');
    if (mime === 'audio/ogg' || mime === 'audio/opus') assertOggOpus(bytes);
    const duration = await decodeInBrowser(bytes);
    const expected = Number(expectedDuration);
    if (expected > 0 && duration + Math.max(2, expected * 0.05) < expected) throw new Error('Duração do áudio menor que a informada na mensagem.');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${mime};base64,${btoa(binary)}`;
  }

  function isLocalAudioDataUrl(value) {
    if (typeof value !== 'string' || value.length > Math.ceil(MAX_BYTES / 3) * 4 + 100) return false;
    const comma = value.indexOf(',');
    if (!/^data:audio\/(?:ogg|opus|mpeg|mp4|aac|wav|webm);base64$/.test(value.slice(0, comma))) return false;
    const base64 = value.slice(comma + 1);
    return base64.length > 0 && base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(base64);
  }

  function whatsappMediaUrl(path, legacyUrl) {
    try {
      const url = new URL(typeof path === 'string' && path.startsWith('/') ? `https://mmg.whatsapp.net${path}` : legacyUrl);
      return url.protocol === 'https:' && url.hostname === 'mmg.whatsapp.net' && !url.port && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  async function decryptAudio(encryptedArrayBuffer, mediaKey) {
    let keyBytes;
    if (typeof mediaKey === 'string') keyBytes = Uint8Array.from(atob(mediaKey), c => c.charCodeAt(0));
    else if (mediaKey instanceof ArrayBuffer) keyBytes = new Uint8Array(mediaKey);
    else if (ArrayBuffer.isView(mediaKey)) keyBytes = new Uint8Array(mediaKey.buffer, mediaKey.byteOffset, mediaKey.byteLength);
    if (!keyBytes || keyBytes.length !== 32) throw new Error('Chave de mídia inválida.');
    const encrypted = new Uint8Array(encryptedArrayBuffer);
    if (encrypted.length <= 26 || (encrypted.length - 10) % 16 !== 0) throw new Error('Mídia criptografada truncada.');
    const base = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveBits']);
    const expanded = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('WhatsApp Audio Keys') }, base, 896));
    const iv = expanded.slice(0, 16);
    const ciphertext = encrypted.slice(0, -10);
    const macKey = await crypto.subtle.importKey('raw', expanded.slice(48, 80), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signed = new Uint8Array(iv.length + ciphertext.length);
    signed.set(iv); signed.set(ciphertext, iv.length);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', macKey, signed));
    let mismatch = 0;
    for (let i = 0; i < 10; i++) mismatch |= mac[i] ^ encrypted[encrypted.length - 10 + i];
    if (mismatch) throw new Error('Autenticação da mídia inválida.');
    const aes = await crypto.subtle.importKey('raw', expanded.slice(16, 48), 'AES-CBC', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aes, ciphertext));
  }
  return { assertOggOpus, validatedDataUrl, isLocalAudioDataUrl, whatsappMediaUrl, decryptAudio };
});
