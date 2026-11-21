'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {registryId} = require('./registry');
const {savePhoto} = require('./proposal-photos');

const EDITABLE = {name: 120, address: 200, city: 120, description: 500, hours: 200, access: 200};
const STATES = ['unknown', 'operational', 'out_of_service', 'decommissioned'];
const REASONS = ['closed', 'missing', 'wrong_location', 'not_working', 'other'];
const fail = (status, message) => Object.assign(new Error(message), {status});
const now = () => new Date().toISOString();
function cleanFields(input, full = true) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'Nieprawidłowe dane AED.');
  const result = {};
  for (const [key, max] of Object.entries(EDITABLE)) {
    if (!full && !Object.hasOwn(input, key)) continue;
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > max) throw fail(400, `Nieprawidłowe pole: ${key}.`);
    result[key] = value.trim();
  }
  if (Object.hasOwn(result, 'name') && !result.name) throw fail(400, 'Podaj nazwę miejsca.');
  for (const [key, min, max] of [['lat', 49, 55], ['lon', 14, 25]]) {
    if (!full && !Object.hasOwn(input, key)) continue;
    if (!['number', 'string'].includes(typeof input[key]) || String(input[key]).trim() === '') throw fail(400, 'Podaj współrzędne punktu.');
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw fail(400, 'Współrzędne muszą wskazywać Polskę.');
    result[key] = value;
  }
  if (full || Object.hasOwn(input, 'device_operational_status')) {
    const value = input.device_operational_status || 'unknown';
    if (!STATES.includes(value)) throw fail(400, 'Nieprawidłowy stan urządzenia.');
    result.device_operational_status = value;
  }
  return result;
}
function fingerprint(record) {
  if (!record) return null;
  const fields = Object.fromEntries([...Object.keys(EDITABLE), 'lat', 'lon', 'device_operational_status', 'hidden'].map(key => [key, record[key] ?? null]));
  return crypto.createHash('sha256').update(JSON.stringify({id: record.id, source_ids: record.source_ids, fields})).digest('hex');
}
const aliases = record => record.source_ids || [record.id];
const findTarget = (records, id) => records.find(record => aliases(record).includes(id));

function proposalRecords(state) {
  return state.proposals.filter(item => item.status === 'approved').map(item => {
    const fields = item.decision.fields;
    return {id: 'community/' + item.id, registry_id: registryId('pl.blisko.community', item.id),
      source: 'community', source_label: 'Zgłoszenie potwierdzone przez administratora', source_record_id: item.id,
      ...fields, ...(item.photo ? {photoUrl: '/api/proposal-photo?id=' + item.id} : {}), verification: {status: 'unverified', last_verified_at: null}, review: {status: 'approved', reviewed_at: item.decision.at, method: 'administrator_review'},
      raw: {geometry: {type: 'Point', coordinates: [item.fields.lon, item.fields.lat]}, properties: {...item.fields}, submitted_at: item.created}};
  });
}
function applyReports(records, state) {
  const approved = state.reports.filter(item => item.status === 'approved').sort((a, b) => a.decision.sequence - b.decision.sequence);
  return records.map(record => {
    let result = {...record, hidden: false}, changes = {}, ids = [];
    for (const item of approved) {
      if (!aliases(record).includes(item.targetId)) continue;
      ids.push(item.id);
      if (item.decision.operation === 'hide') result.hidden = true;
      else { Object.assign(changes, item.decision.patch); Object.assign(result, item.decision.patch); }
      result.reviewed_at = item.decision.at;
      result.review = {status: 'approved', reviewed_at: item.decision.at, method: 'administrator_review'};
    }
    return {...result, moderation_report_ids: ids, moderation_patch: changes};
  });
}
function candidateRecords(projected) {
  return projected.filter(record => !record.hidden).flatMap(record => (record.source_records || [record]).map(member => ({...member, ...record.moderation_patch})));
}

class ModerationStore {
  constructor(directory, resolveBase, legacyDirectory = null) {
    this.file = path.join(directory, 'moderation.json'); this.resolveBase = resolveBase;
    this.photoDirectory = path.join(directory, 'proposal-photos');
    this.legacyDirectory = legacyDirectory; this.writes = Promise.resolve();
  }
  async read() {
    try {
      const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Number.isInteger(state.revision) || !Number.isInteger(state.registryRevision) || !Array.isArray(state.proposals) || !Array.isArray(state.reports) || !Array.isArray(state.history)) throw Error('Invalid moderation store');
      return state;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const state = {revision: 0, registryRevision: 0, proposals: [], reports: [], history: []};
    if (this.legacyDirectory) {
      for (const [file, kind] of [['drafts.json', 'proposal'], ['reports.json', 'report']]) {
        let rows;
        try { rows = JSON.parse(await fs.readFile(path.join(this.legacyDirectory, file), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!Array.isArray(rows)) throw Error('Invalid legacy moderation data');
        for (const row of rows) {
          const common = {id: row.id, created: row.created, status: 'pending', version: 0};
          if (kind === 'proposal') state.proposals.push({...common, fields: cleanFields(row)});
          else state.reports.push({...common, targetId: row.source + '/' + row.pointId, reason: row.reason, details: '', suggested: {}, snapshot: {name: row.name}});
        }
      }
    }
    return state;
  }
  transaction(change) {
    const task = this.writes.then(async () => {
      const state = await this.read(), result = await change(state);
      state.revision++;
      await fs.mkdir(path.dirname(this.file), {recursive: true});
      const temp = this.file + '.tmp', file = await fs.open(temp, 'w');
      try { await file.writeFile(JSON.stringify(state, null, 2)); await file.sync(); } finally { await file.close(); }
      await fs.rename(temp, this.file);
      return {...result, revision: state.revision, registryRevision: state.registryRevision};
    });
    this.writes = task.catch(() => {}); return task;
  }
  async submitProposal(input) {
    const fields = cleanFields(input);
    const id = crypto.randomUUID(), photo = await savePhoto(this.photoDirectory, id, input.photo);
    try {
      return await this.transaction(state => {
        const item = {id, created: now(), status: 'pending', version: 0, fields, ...(photo ? {photo} : {})};
        state.proposals.unshift(item); return {item};
      });
    } catch (error) {
      if (photo) await fs.unlink(path.join(this.photoDirectory, id + '.image')).catch(() => {});
      throw error;
    }
  }
  submitBatch(rows,filename,area,contains){
    if(!Array.isArray(rows)||rows.length<1||rows.length>200)throw fail(400,'Import musi zawierać od 1 do 200 rekordów.');
    const normalized=rows.map((row,index)=>{
      let fields;try{fields=cleanFields(row);}catch(error){throw fail(400,`Rekord ${index+1}: ${error.message}`);}
      if(area&&!contains(area,fields))throw fail(400,`Rekord ${index+1} leży poza wybranym obszarem. Wybierz właściwe miasto lub wszystkie obszary.`);
      if(!fields.city&&area?.kind==='city')fields.city=area.name;
      return fields;
    });
    return this.transaction(state=>{
      const batchId=crypto.randomUUID(),created=now(),label=typeof filename==='string'?path.basename(filename).slice(0,120):'Import JSON';
      const items=normalized.map(fields=>({id:crypto.randomUUID(),created,status:'pending',version:0,fields,import:{id:batchId,filename:label}}));
      state.proposals.unshift(...items);state.history.push({kind:'import',action:'submit',id:batchId,count:items.length,at:created});
      return {accepted:items.length,batchId,status:'pending'};
    });
  }
  submitReport(input) {
    if (!REASONS.includes(input.reason)) throw fail(400, 'Wybierz rodzaj problemu.');
    const details = input.details ?? '';
    if (typeof details !== 'string' || details.length > 1000) throw fail(400, 'Opis może mieć do 1000 znaków.');
    const suggested = cleanFields(input.suggested || {}, false);
    return this.transaction(async state => {
      const records = applyReports(await this.resolveBase(state), state);
      let record;
      if (typeof input.registryId === 'string') record = records.find(row => row.registry_id === input.registryId);
      else if (['warsaw', 'osm', 'community'].includes(input.source) && typeof input.id === 'string') record = findTarget(records, input.source + '/' + input.id);
      if (!record || record.hidden) throw fail(404, 'Nie znaleziono aktywnego punktu. Odśwież listę AED.');
      const item = {id: crypto.randomUUID(), targetId: record.id, created: now(), status: 'pending', version: 0,
        reason: input.reason, details: details.trim(), suggested,
        snapshot: Object.fromEntries(['id', 'registry_id', 'name', 'address', 'city', 'lat', 'lon', 'hours', 'access', 'description', 'device_operational_status'].map(key => [key, record[key] ?? null]))};
      state.reports.unshift(item); return {item};
    });
  }
  async list() {
    const state = await this.read(), records = applyReports(await this.resolveBase(state), state);
    return {...state, reports: state.reports.map(item => {
      const current = findTarget(records, item.targetId);
      return {...item, current: current || null, targetRevision: fingerprint(current)};
    })};
  }
  review(input) {
    if (!['proposal', 'report'].includes(input.kind) || !['approve', 'reject', 'undo'].includes(input.action)) throw fail(400, 'Nieprawidłowa decyzja.');
    if (typeof input.note !== 'undefined' && (typeof input.note !== 'string' || input.note.length > 500)) throw fail(400, 'Notatka może mieć do 500 znaków.');
    return this.transaction(async state => {
      const items = input.kind === 'proposal' ? state.proposals : state.reports;
      const item = items.find(row => row.id === input.id);
      if (!item) throw fail(404, 'Nie znaleziono zgłoszenia.');
      if (!Number.isInteger(input.version) || input.version !== item.version) throw fail(409, 'Zgłoszenie zostało już zmienione. Odśwież kolejkę.');
      const previous = {status: item.status, decision: item.decision || null};
      if (input.action === 'undo') {
        if (item.status === 'pending') throw fail(409, 'To zgłoszenie oczekuje już na weryfikację.');
        if (item.status === 'approved') state.registryRevision++;
        item.status = 'pending'; delete item.decision;
      } else {
        if (item.status !== 'pending') throw fail(409, 'Najpierw cofnij poprzednią decyzję.');
        const decision = {at: now(), sequence: state.revision + 1, note: (input.note || '').trim()};
        if (input.action === 'approve') {
          if (input.kind === 'proposal') decision.fields = cleanFields(input.fields || item.fields);
          else {
            const current = findTarget(applyReports(await this.resolveBase(state), state), item.targetId);
            if (!current) throw fail(409, 'Punkt nie jest już dostępny w rejestrze.');
            if (input.targetRevision !== fingerprint(current)) throw fail(409, 'Dane punktu zmieniły się. Odśwież zgłoszenie przed zatwierdzeniem.');
            if (!['edit', 'hide'].includes(input.operation)) throw fail(400, 'Wybierz korektę danych albo ukrycie punktu.');
            decision.operation = input.operation;
            decision.before = Object.fromEntries([...Object.keys(EDITABLE), 'lat', 'lon', 'device_operational_status', 'hidden'].map(key => [key, current[key] ?? null]));
            if (input.operation === 'edit') {
              const patch = cleanFields(input.fields || {}, false);
              decision.patch = Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== (current[key] ?? (key === 'device_operational_status' ? 'unknown' : ''))));
              if (!Object.keys(decision.patch).length) throw fail(400, 'Wprowadź sprawdzoną zmianę danych albo odrzuć zgłoszenie.');
            }
          }
          state.registryRevision++;
        }
        item.status = input.action === 'approve' ? 'approved' : 'rejected'; item.decision = decision;
      }
      item.version++;
      state.history.push({kind: input.kind, id: item.id, action: input.action, at: now(), previous, decision: item.decision || null});
      return {item};
    });
  }
}
module.exports = {ModerationStore, cleanFields, fingerprint, proposalRecords, applyReports, candidateRecords};
