'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_BYTES = 1500000;
const invalid = message => Object.assign(new Error(message), {status: 400});

async function savePhoto(directory, id, value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2000100) throw invalid('Zdjęcie jest zbyt duże. Maksymalnie 1,5 MB po zmniejszeniu.');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw invalid('Dodaj zdjęcie JPG, PNG lub WebP.');
  const bytes = Buffer.from(match[2], 'base64'), type = match[1];
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp = bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if (bytes.length < 16 || bytes.length > MAX_BYTES || bytes.toString('base64') !== match[2] || !({'image/jpeg':jpeg,'image/png':png,'image/webp':webp}[type])) throw invalid('Nieprawidłowe zdjęcie. Dodaj plik JPG, PNG lub WebP do 1,5 MB.');
  await fs.mkdir(directory, {recursive: true});
  await fs.writeFile(path.join(directory, id + '.image'), bytes, {flag:'wx', mode:0o600});
  return {type, bytes:bytes.length};
}
module.exports = {savePhoto};
