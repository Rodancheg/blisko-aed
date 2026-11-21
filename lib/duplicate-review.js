'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const THRESHOLD_METRES = 25;
const radius = 6371000;
const radians = value => value * Math.PI / 180;
function metres(a, b) {
  const lat = radians(b.lat - a.lat), lon = radians(b.lon - a.lon);
  const q = Math.sin(lat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(lon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(Math.max(0, 1 - q)));
}
const pairId = ids => crypto.createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex');
function problem(status, message) { return Object.assign(new Error(message), {status}); }

function groupsFor(records, decisions) {
  const parent = new Map(records.map(record => [record.id, record.id]));
  const find = id => {
    if (!parent.has(id)) return null;
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) { const next = parent.get(id); parent.set(id, root); id = next; }
    return root;
  };
  const merges = Object.values(decisions).filter(d => d.action === 'merge').sort((a, b) => a.sequence - b.sequence);
  for (const decision of merges) {
    const [a, b] = decision.recordIds.map(find), primary = find(decision.primaryId);
    if (a && b && primary && a !== b) {
      // Preserve the chosen primary source record, including on a transitive merge.
      const chosen = decision.primaryId;
      for (const root of [a, b]) parent.set(root, chosen);
      parent.set(chosen, chosen);
    }
  }
  const groups = new Map();
  for (const record of records) {
    const root = find(record.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(record);
  }
  return {find, groups};
}

function resolve(records, decisions) {
  const {groups} = groupsFor(records, decisions);
  return [...groups.entries()].map(([primaryId, members]) => {
    const primary = members.find(record => record.id === primaryId);
    return {...primary, source_records: members.map(record => ({...record})),
      source_ids: members.map(record => record.id).sort(), merged: members.length > 1};
  });
}

function candidates(records, decisions, threshold = THRESHOLD_METRES) {
  const {find} = groupsFor(records, decisions), grid = new Map(), pairs = [];
  const distinctGroups = new Set(Object.values(decisions).filter(d => d.action === 'different')
    .map(d => d.recordIds.map(find)).filter(ids => ids.every(Boolean)).map(pairId));
  for (const record of records) {
    // Earth-centred grid: candidates at <=25m are at most one cell apart on
    // each axis, including at the date line. Exact arc distance is checked next.
    const lat = radians(record.lat), lon = radians(record.lon);
    const cell = [radius * Math.cos(lat) * Math.cos(lon), radius * Math.cos(lat) * Math.sin(lon), radius * Math.sin(lat)].map(v => Math.floor(v / threshold));
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const neighbours = grid.get([cell[0] + x, cell[1] + y, cell[2] + z].join(',')) || [];
      for (const other of neighbours) {
        if (record.id === other.id || find(record.id) === find(other.id)) continue;
        if (distinctGroups.has(pairId([find(record.id), find(other.id)]))) continue;
        const id = pairId([other.id, record.id]);
        if (decisions[id]) continue;
        const distance = metres(other, record);
        if (distance <= threshold) pairs.push({pairId: id, a: other, b: record, distance});
      }
    }
    const key = cell.join(',');
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(record);
  }
  pairs.sort((a, b) => a.distance - b.distance || a.pairId.localeCompare(b.pairId));
  return pairs;
}

class ReviewStore {
  constructor(directory) { this.file = path.join(directory, 'duplicate-decisions.json'); this.writes = Promise.resolve(); }
  async read() {
    try {
      const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Number.isInteger(state.revision) || !state.decisions || !Array.isArray(state.history)) throw Error('Invalid duplicate decision store');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return {revision: 0, decisions: {}, history: []};
      throw error;
    }
  }
  async decide(input, records) {
    const operation = this.writes.then(async () => {
      const state = await this.read();
      if (!Number.isInteger(input.revision) || input.revision !== state.revision) throw problem(409, 'Lista została zmieniona. Odśwież ją i spróbuj ponownie.');
      if (!['merge', 'different', 'undo'].includes(input.action)) throw problem(400, 'Nieznane działanie.');
      let ids, previous;
      if (input.action === 'undo') {
        if (typeof input.pairId !== 'string' || !/^[a-f0-9]{64}$/.test(input.pairId)) throw problem(400, 'Nieprawidłowy identyfikator pary.');
        previous = state.decisions[input.pairId];
        if (!previous) throw problem(404, 'Nie znaleziono decyzji do cofnięcia.');
        ids = previous.recordIds;
      } else {
        ids = input.recordIds;
        if (!Array.isArray(ids) || ids.length !== 2 || ids.some(id => typeof id !== 'string') || ids[0] === ids[1]) throw problem(400, 'Wybierz dwa różne rekordy.');
        const index = new Map(records.map(record => [record.id, record])), [a, b] = ids.map(id => index.get(id));
        if (!a || !b) throw problem(404, 'Rekord nie jest już dostępny w źródłach.');
        if (metres(a, b) > THRESHOLD_METRES) throw problem(409, 'Te rekordy są dalej niż 25 m. Wymagają ponownej analizy.');
        if (input.action === 'merge' && !ids.includes(input.primaryId)) throw problem(400, 'Wybierz rekord główny.');
        previous = state.decisions[pairId(ids)];
        if (input.action === 'merge' && previous?.action !== 'merge') {
          const grouping = groupsFor(records, state.decisions);
          if (grouping.find(ids[0]) === grouping.find(ids[1])) throw problem(409, 'Te rekordy są już połączone.');
        }
      }
      const id = pairId(ids), decision = {pairId: id, recordIds: [...ids].sort(), action: input.action,
        primaryId: input.action === 'merge' ? input.primaryId : null,
        note: typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '',
        reviewedAt: new Date().toISOString(), sequence: state.revision + 1,
        snapshots: ids.map(recordId => records.find(record => record.id === recordId)).filter(Boolean)};
      const next = {...state.decisions};
      if (input.action === 'undo') delete next[id]; else next[id] = decision;
      const grouping = groupsFor(records, next);
      for (const different of Object.values(next).filter(d => d.action === 'different')) {
        const [a, b] = different.recordIds.map(grouping.find);
        if (a && b && a === b) throw problem(409, 'Połączenie koliduje z decyzją „Różne urządzenia”. Najpierw cofnij tamtą decyzję.');
      }
      const updated = {revision: state.revision + 1, decisions: next,
        history: [...state.history, {...decision, previous: previous || null}]};
      await fs.mkdir(path.dirname(this.file), {recursive: true});
      const temporary = this.file + '.tmp';
      const handle = await fs.open(temporary, 'w');
      try { await handle.writeFile(JSON.stringify(updated, null, 2)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.file);
      return {revision: updated.revision, decision};
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
}

module.exports = {THRESHOLD_METRES, metres, pairId, groupsFor, resolve, candidates, ReviewStore};
