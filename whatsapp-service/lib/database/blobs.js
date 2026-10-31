'use strict';

const { createHash } = require('node:crypto');
const PREFIX = '\u001emonada-blob-v1:';
const CHUNK_BYTES = 450000;
const MAX_BLOB_BYTES = 32000000;

function prepareBlob(id, value) {
  if (typeof value !== 'string') throw new Error('Snapshot invalido.');
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > MAX_BLOB_BYTES) throw new Error('Snapshot excede o tamanho permitido.');
  const chunks=[];
  // Chunk marker-prefixed values as well, so arbitrary stored text roundtrips.
  if (bytes.length <= CHUNK_BYTES && !value.startsWith(PREFIX)) return { value, chunks };
  for(let offset=0;offset<bytes.length;offset+=CHUNK_BYTES) chunks.push(bytes.subarray(offset,offset+CHUNK_BYTES).toString('base64'));
  const hash=createHash('sha256').update(bytes).digest('hex');
  return {value:PREFIX+JSON.stringify({count:chunks.length,sha256:hash}),chunks,id};
}

async function hydrateBlobs(rows, execute) {
  for(const row of rows) {
    if(typeof row.creds!=='string' || !row.creds.startsWith(PREFIX)) continue;
    const metadata=JSON.parse(row.creds.slice(PREFIX.length));
    if(!Number.isInteger(metadata.count)||metadata.count<1||metadata.count>Math.ceil(MAX_BLOB_BYTES/CHUNK_BYTES)||!/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new Error('Snapshot invalido.');
    const result=await execute([{sql:'SELECT chunk_index,content FROM monada_blob_chunks WHERE session_id=? ORDER BY chunk_index',params:[row.id]}]);
    const parts=result[0].results;
    if(parts.length!==metadata.count || parts.some((part,index)=>part.chunk_index!==index||typeof part.content!=='string'||part.content.length>CHUNK_BYTES*1.34)) throw new Error('Snapshot incompleto.');
    const bytes=Buffer.concat(parts.map(part=>Buffer.from(part.content,'base64')));
    if(bytes.length>MAX_BLOB_BYTES||createHash('sha256').update(bytes).digest('hex')!==metadata.sha256) throw new Error('Snapshot corrompido.');
    row.creds=bytes.toString('utf8');
  }
  return rows;
}

module.exports={prepareBlob,hydrateBlobs};
