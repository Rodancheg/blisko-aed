'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function imageType(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  return null;
}

class WarsawPhotos {
  constructor(directory, fetchRecord) {
    this.directory = directory; this.fetchRecord = fetchRecord; this.pending = new Map();
  }
  async get(id) {
    if (!/^\d{1,12}$/.test(id || '')) throw Object.assign(Error('Nieprawidłowy identyfikator zdjęcia.'), {status:400});
    const file = path.join(this.directory, id + '.image');
    try {
      const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]), type = imageType(bytes);
      if (type) {
        // A stale photo remains available while the official source refreshes.
        if (Date.now() - stat.mtimeMs > 86400000) this.refresh(id, file).catch(() => {});
        return {bytes, type};
      }
    } catch (error) { if (error.code !== 'ENOENT') console.warn('Warsaw photo cache unavailable.'); }
    return this.refresh(id, file);
  }
  refresh(id, file) {
    if (this.pending.has(id)) return this.pending.get(id);
    const task = (async () => {
      const result = await this.fetchRecord(id);
      const row = Array.isArray(result) ? result.find(row => String(row?.properties?.defibrillator_id) === id) : null;
      const encoded = row?.properties?.attachment;
      if (typeof encoded !== 'string' || !encoded.trim()) throw Object.assign(Error('Brak zdjęcia w danych źródłowych.'), {status:404});
      if (encoded.length > 12000000) throw Object.assign(Error('Zdjęcie źródłowe jest zbyt duże.'), {status:502});
      const bytes = Buffer.from(encoded.replace(/^data:image\/[^;]+;base64,/i, '').replace(/\s/g, ''), 'base64'), type = imageType(bytes);
      if (!type) throw Object.assign(Error('Nieprawidłowy format zdjęcia źródłowego.'), {status:502});
      try {
        await fs.mkdir(this.directory, {recursive:true});
        await fs.writeFile(file + '.tmp', bytes);
        await fs.rename(file + '.tmp', file);
      } catch { console.warn('Warsaw photo could not be cached.'); }
      return {bytes, type};
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, task); return task;
  }
}
module.exports = {WarsawPhotos};
