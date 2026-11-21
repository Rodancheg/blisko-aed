'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {candidates, resolve, pairId, ReviewStore} = require('../lib/duplicate-review');
const {registryId} = require('../lib/registry');

const point = (id, metresNorth = 0) => ({id, registry_id: id, lat: 52 + metresNorth / 6371000 * 180 / Math.PI, lon: 21, name: id, source: 'osm'});

test('25m is a candidate threshold; selection includes same-source pairs and excludes >25m', () => {
  const rows = [point('a'), point('b', 24.99), point('c', 50.01)];
  const pairs = candidates(rows, {});
  assert.deepEqual(pairs.map(pair => [pair.a.id, pair.b.id]), [['a', 'b']]);
  assert.equal(resolve(rows, {}).length, 3, 'proximity alone must never merge records');
  assert.equal(pairId(['b', 'a']), pairId(['a', 'b']));
  assert.equal(registryId('pl.warszawa.scb.aed', '622'), 'b4f2af4f-d084-5291-a507-ba75e3ae43f9');
});

test('merge, persistence, distinct decision and undo preserve original source data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aed-review-'));
  try {
    const rows = [point('a'), point('b', 10)], store = new ReviewStore(dir);
    await store.decide({revision: 0, action: 'merge', recordIds: ['a', 'b'], primaryId: 'b', note: 'Verified'}, rows);
    let state = await new ReviewStore(dir).read();
    const combined = resolve(rows, state.decisions);
    assert.equal(combined.length, 1); assert.equal(combined[0].id, 'b');
    assert.deepEqual(combined[0].source_records, rows);
    assert.equal(candidates(rows, state.decisions).length, 0);
    await store.decide({revision: 1, action: 'undo', pairId: pairId(['a', 'b'])}, rows);
    state = await store.read(); assert.equal(resolve(rows, state.decisions).length, 2);
    await store.decide({revision: 2, action: 'different', recordIds: ['a', 'b']}, rows);
    state = await store.read();
    assert.equal(resolve(rows, state.decisions).length, 2);
    assert.equal(candidates(rows, state.decisions).length, 0);
    assert.equal(state.history.length, 3);
    assert.deepEqual(rows, [point('a'), point('b', 10)], 'inputs were not mutated');
  } finally { await fs.rm(dir, {recursive: true}); }
});

test('transitive merges cannot contradict a known distinct-device decision', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aed-review-'));
  try {
    const rows = [point('a'), point('b', 5), point('c', 10)], store = new ReviewStore(dir);
    await store.decide({revision: 0, action: 'different', recordIds: ['a', 'c']}, rows);
    await store.decide({revision: 1, action: 'merge', recordIds: ['a', 'b'], primaryId: 'a'}, rows);
    assert.equal(candidates(rows, (await store.read()).decisions).length, 0, 'known different-device groups are not proposed again through another alias');
    await assert.rejects(store.decide({revision: 2, action: 'merge', recordIds: ['b', 'c'], primaryId: 'c'}, rows), {status: 409});
    await store.decide({revision: 2, action: 'undo', pairId: pairId(['a', 'c'])}, rows);
    await store.decide({revision: 3, action: 'merge', recordIds: ['b', 'c'], primaryId: 'b'}, rows);
    const merged = resolve(rows, (await store.read()).decisions);
    assert.equal(merged.length, 1); assert.equal(merged[0].id, 'b');
  } finally { await fs.rm(dir, {recursive: true}); }
});

test('concurrent reviews cannot overwrite each other and invalid requests do not write', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aed-review-'));
  try {
    const rows = [point('a'), point('b', 10), point('far', 100)], store = new ReviewStore(dir);
    await assert.rejects(store.decide({revision: 0, action: 'merge', recordIds: ['a', 'far'], primaryId: 'a'}, rows), {status: 409});
    await assert.rejects(store.decide({revision: 0, action: 'merge', recordIds: ['a', 'b'], primaryId: 'missing'}, rows), {status: 400});
    const result = await Promise.allSettled([
      store.decide({revision: 0, action: 'merge', recordIds: ['a', 'b'], primaryId: 'a'}, rows),
      store.decide({revision: 0, action: 'different', recordIds: ['a', 'b']}, rows)
    ]);
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(result.find(r => r.status === 'rejected').reason.status, 409);
    assert.equal((await store.read()).history.length, 1);
  } finally { await fs.rm(dir, {recursive: true}); }
});

async function launch(directory) {
  const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
    env: {...process.env, PORT: '0', AED_ADMIN_PASSWORD: 'test-only-admin-password', AED_SNAPSHOT_DIR: path.join(directory, 'snapshots'), AED_REVIEW_DIR: path.join(directory, 'reviews')},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Server start timeout')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error('Server exited: ' + code)); });
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } });
  });
  return {child, base};
}
async function stop(server) {
  const exit = once(server.child, 'exit'); server.child.kill('SIGTERM'); await exit;
}

test('HTTP lifecycle: merged registry, export, map, restart, undo and distinct-device review', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aed-review-http-'));
  let server;
  try {
    await fs.mkdir(path.join(dir, 'snapshots'));
    await fs.writeFile(path.join(dir, 'snapshots/warsaw-test.json'), JSON.stringify([{geometry: {type: 'Point', coordinates: [[21, 52]]}, properties: {defibrillator_id: '100', location_object_name: 'Municipal AED', location_street: 'Street A', location_city: 'Warszawa'}}]));
    await fs.writeFile(path.join(dir, 'snapshots/osm-poland-test.geojson'), JSON.stringify({type: 'FeatureCollection', features: [
      {type: 'Feature', geometry: {type: 'Point', coordinates: [21, 52.0001]}, properties: {'@osm_id': 200, '@osm_type': 'node', name: 'OSM AED'}},
      {type: 'Feature', geometry: {type: 'Point', coordinates: [18, 54]}, properties: {'@osm_id': 201, '@osm_type': 'node'}}
    ]}));
    server = await launch(dir);
    const login=await fetch(server.base+'/api/admin/session',{method:'POST',headers:{'Content-Type':'application/json',Origin:server.base},body:JSON.stringify({password:'test-only-admin-password'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const get = async route => (await fetch(server.base + route,{headers:{Cookie:cookie}})).json();
    const post = async body => fetch(server.base + '/api/duplicates/decisions', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: server.base.replace('http:', 'https:'),Cookie:cookie}, body: JSON.stringify(body===null?null:{moderationRevision:0,...body})});
    let pending = await get('/api/duplicates');
    assert.equal(pending.total, 1);
    const pair = pending.pairs[0];
    const action = {revision: 0, action: 'merge', recordIds: [pair.a.id, pair.b.id], primaryId: pair.a.id};
    const forbidden = await fetch(server.base + '/api/duplicates/decisions', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://other.example'}, body: JSON.stringify(action)});
    assert.equal(forbidden.status, 403);
    assert.equal((await post(null)).status, 400);
    assert.equal((await post(action)).status, 201);
    assert.equal((await get('/api/duplicates')).total, 0);
    const exported = await get('/api/export?format=geojson');
    assert.equal(exported.features.length, 2);
    assert.equal(exported.features.find(f => f.properties.merged).properties.source_records.length, 2);
    assert.equal((await get('/api/export?format=geojson&view=raw')).features.length, 3);
    assert.equal((await get('/api/admin/points')).points.length, 2);
    assert.equal((await get('/api/nearby?lat=52&lon=21')).points.length, 1);
    await stop(server); server = await launch(dir);
    assert.equal((await get('/api/duplicates')).total, 0);
    assert.equal((await post({revision: 1, action: 'undo', pairId: pair.pairId})).status, 201);
    assert.equal((await get('/api/duplicates')).total, 1);
    assert.equal((await get('/api/nearby?lat=52&lon=21')).points.length, 2);
    assert.equal((await post({revision: 2, action: 'different', recordIds: [pair.a.id, pair.b.id]})).status, 201);
    assert.equal((await get('/api/duplicates')).total, 0);
    assert.equal((await get('/api/export?format=geojson')).features.length, 3);
    assert.equal((await get('/api/duplicates/history')).events, 3);
  } finally {
    if (server && server.child.exitCode === null && server.child.signalCode === null) await stop(server);
    await fs.rm(dir, {recursive: true});
  }
});
