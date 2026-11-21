'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {ModerationStore, proposalRecords, applyReports, fingerprint, candidateRecords} = require('../lib/moderation');
const {resolve} = require('../lib/duplicate-review');

const fields = {name: 'Proposed AED', lat: 52.2, lon: 21, address: 'Testowa 1', city: 'Warszawa', hours: '24/7'};
const source = {id:'osm/node/1',source:'osm',source_record_id:'node/1',registry_id:'source-uuid',name:'Original AED',address:'Original address',city:'Warszawa',lat:52.2,lon:21,hours:'24/7',description:'Original description',access:'yes'};

test('proposals require approval; rejection, undo and persistence never publish pending data', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aed-moderation-'));
  try {
    const store=new ModerationStore(dir,async state=>resolve([source,...proposalRecords(state)],{}));
    const proposal=(await store.submitProposal({...fields,status:'approved',decision:{fields}})).item;
    assert.equal(proposalRecords(await store.read()).length,0);
    await store.review({kind:'proposal',id:proposal.id,action:'reject',version:0});
    assert.equal(proposalRecords(await store.read()).length,0);
    await store.review({kind:'proposal',id:proposal.id,action:'undo',version:1});
    await store.review({kind:'proposal',id:proposal.id,action:'approve',version:2,fields:{...fields,name:'Checked AED'}});
    let state=await new ModerationStore(dir,store.resolveBase).read();
    assert.equal(proposalRecords(state)[0].name,'Checked AED');
    assert.equal(proposalRecords(state)[0].raw.properties.name,'Proposed AED');
    const id=proposalRecords(state)[0].registry_id;
    await store.review({kind:'proposal',id:proposal.id,action:'undo',version:3});
    assert.equal(proposalRecords(await store.read()).length,0);
    await store.review({kind:'proposal',id:proposal.id,action:'approve',version:4});
    state=await store.read();assert.equal(proposalRecords(state)[0].registry_id,id);
    assert.equal(state.history.length,5);
  }finally{await fs.rm(dir,{recursive:true});}
});

test('reports change a merged device only after approval and keep source snapshots intact',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aed-moderation-'));
  try {
    const other={...source,id:'warsaw/2',registry_id:'second-uuid',source:'warsaw'};
    const base=resolve([source,other],{pair:{action:'merge',recordIds:[source.id,other.id],primaryId:other.id,sequence:1}});
    const store=new ModerationStore(dir,async()=>base);
    const report=(await store.submitReport({registryId:other.registry_id,reason:'wrong_location',suggested:{lat:52.201,lon:21.001},details:'Wrong entrance'})).item;
    assert.equal(applyReports(base,await store.read())[0].lat,52.2);
    let queue=await store.list();
    await store.review({kind:'report',id:report.id,action:'approve',version:0,operation:'edit',targetRevision:queue.reports[0].targetRevision,fields:{lat:52.201,lon:21.001,address:'Correct address'}});
    const projected=applyReports(base,await store.read());
    assert.equal(projected[0].lat,52.201);assert.equal(projected[0].address,'Correct address');
    assert.equal(projected[0].source_records[0].lat,52.2);
    assert.equal(candidateRecords(projected).every(row=>row.lat===52.201),true);
    const missing=(await store.submitReport({registryId:other.registry_id,reason:'missing'})).item;
    queue=await store.list();
    await store.review({kind:'report',id:missing.id,action:'approve',version:0,operation:'hide',targetRevision:queue.reports.find(row=>row.id===missing.id).targetRevision});
    const hidden=applyReports(base,await store.read());assert.equal(hidden[0].hidden,true);assert.equal(candidateRecords(hidden).length,0);
    await store.review({kind:'report',id:missing.id,action:'undo',version:1});
    assert.equal(applyReports(base,await store.read())[0].hidden,false);
  }finally{await fs.rm(dir,{recursive:true});}
});

test('stale report review is rejected, and undo preserves a later approved correction',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aed-moderation-'));
  try{
    const base=resolve([source],{}),store=new ModerationStore(dir,async()=>base);
    const a=(await store.submitReport({registryId:source.registry_id,reason:'other'})).item;
    const b=(await store.submitReport({registryId:source.registry_id,reason:'other'})).item;
    const original=(await store.list()).reports.find(row=>row.id===a.id).targetRevision;
    await store.review({kind:'report',id:a.id,action:'approve',version:0,operation:'edit',targetRevision:original,fields:{address:'Address A'}});
    await assert.rejects(store.review({kind:'report',id:b.id,action:'approve',version:0,operation:'edit',targetRevision:original,fields:{address:'Address B'}}),{status:409});
    const current=(await store.list()).reports.find(row=>row.id===b.id);
    await store.review({kind:'report',id:b.id,action:'approve',version:0,operation:'edit',targetRevision:current.targetRevision,fields:{address:'Address B'}});
    await store.review({kind:'report',id:a.id,action:'undo',version:1});
    assert.equal(applyReports(base,await store.read())[0].address,'Address B');
    const race=await Promise.allSettled([store.review({kind:'report',id:a.id,action:'reject',version:2}),store.review({kind:'report',id:a.id,action:'reject',version:2})]);
    assert.equal(race.filter(item=>item.status==='fulfilled').length,1);
  }finally{await fs.rm(dir,{recursive:true});}
});

async function launch(directory){
  const child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:'0',AED_ADMIN_PASSWORD:'test-only-admin-password',AED_SNAPSHOT_DIR:path.join(directory,'snapshots'),AED_REVIEW_DIR:path.join(directory,'reviews')},stdio:['ignore','pipe','pipe']});
  let output='';const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Start timeout'));},10000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(Error('Unexpected server exit '+code));});child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}});});
  return{child,base};
}
async function stop(server){const exit=once(server.child,'exit');server.child.kill('SIGTERM');await exit;}

test('HTTP moderation: admin authorization, proposal creation, reports, map, nearby, exports and restart',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aed-moderation-http-'));let server;
  try{
    await fs.mkdir(path.join(dir,'snapshots'));
    await fs.writeFile(path.join(dir,'snapshots/warsaw-test.json'),'[]');
    await fs.writeFile(path.join(dir,'snapshots/osm-poland-test.geojson'),JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[21,52.2]},properties:{'@osm_id':1,'@osm_type':'node',name:'Original AED',opening_hours:'24/7'}}]}));
    server=await launch(dir);let cookie='';
    const call=async(route,body,admin=false)=>fetch(server.base+route,{method:body===undefined?'GET':'POST',headers:{Origin:server.base,'Content-Type':'application/json',...(admin?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const get=async(route,admin=false)=>(await call(route,undefined,admin)).json();
    const geo=()=>get('/api/export?format=geojson');
    const login=await call('/api/admin/session',{password:'test-only-admin-password'});cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal(login.status,200);
    assert.equal((await call('/api/admin/moderation')).status,401);
    const proposal=await(await call('/api/proposals',{...fields,name:'=TEST proposed',lat:52.205,status:'approved'})).json();
    assert.equal(proposal.status,'pending');assert.equal((await geo()).features.length,1);
    assert.equal((await get('/api/export?format=geojson&view=raw')).features.length,1);
    assert.equal((await get('/api/admin/points')).points.length,1);
    assert.equal((await call('/api/admin/moderation/decisions',{kind:'proposal',id:proposal.id,action:'approve',version:0})).status,401);
    assert.equal((await call('/api/admin/moderation/decisions',{kind:'proposal',id:proposal.id,action:'approve',version:0},true)).status,201);
    assert.equal((await geo()).features.length,2);assert.equal((await get('/api/admin/points')).points.length,2);
    assert.equal((await get('/api/nearby?lat=52.2&lon=21')).points.length,2);
    const csv=await(await call('/api/export?format=csv')).text();assert.ok(csv.includes("'=TEST proposed"));
    const created=(await geo()).features.find(item=>item.properties.source==='Zgłoszenie potwierdzone przez administratora');
    const report=await(await call('/api/reports',{registryId:created.id,reason:'wrong_location',suggested:{lat:52.206,lon:21.001},details:'Entrance moved'})).json();
    assert.equal((await geo()).features.find(item=>item.id===created.id).geometry.coordinates[1],52.205);
    let queue=await get('/api/admin/moderation',true),item=queue.reports.find(row=>row.id===report.id);
    assert.equal((await call('/api/admin/moderation/decisions',{kind:'report',id:report.id,action:'approve',version:0,operation:'edit',targetRevision:item.targetRevision,fields:{lat:52.206,lon:21.001,address:'New entrance'}},true)).status,201);
    assert.equal((await geo()).features.find(row=>row.id===created.id).geometry.coordinates[1],52.206);
    const missing=await(await call('/api/reports',{registryId:created.id,reason:'missing'})).json();
    assert.equal((await geo()).features.length,2);
    queue=await get('/api/admin/moderation',true);item=queue.reports.find(row=>row.id===missing.id);
    await call('/api/admin/moderation/decisions',{kind:'report',id:missing.id,action:'approve',version:0,operation:'hide',targetRevision:item.targetRevision},true);
    assert.equal((await geo()).features.length,1);assert.equal((await get('/api/admin/points')).points.length,1);
    assert.equal((await get('/api/nearby?lat=52.2&lon=21')).points.length,1);
    await stop(server);server=await launch(dir);
    assert.equal((await get('/api/admin/session',true)).authenticated,true,'admin session survives server restart');
    assert.equal((await geo()).features.length,1,'approved hide survives server restart');
    await call('/api/admin/moderation/decisions',{kind:'report',id:missing.id,action:'undo',version:1},true);
    assert.equal((await geo()).features.length,2);
    const broken=await(await call('/api/reports',{registryId:created.id,reason:'not_working'})).json();
    queue=await get('/api/admin/moderation',true);item=queue.reports.find(row=>row.id===broken.id);
    await call('/api/admin/moderation/decisions',{kind:'report',id:broken.id,action:'approve',version:0,operation:'edit',targetRevision:item.targetRevision,fields:{device_operational_status:'out_of_service'}},true);
    assert.equal((await geo()).features.length,2,'out-of-service records remain in the registry');
    assert.equal((await get('/api/nearby?lat=52.2&lon=21')).points.length,1,'out-of-service AED is excluded from emergency search');
    assert.notEqual((await get('/api/registry/version')).version,'0:0');
    assert.equal((await call('/api/proposals',{...fields,lat:''})).status,400);
    assert.equal((await call('/api/admin/moderation/decisions',{kind:'proposal',id:proposal.id,action:'undo',version:1},true)).status,201);
    assert.equal((await geo()).features.length,1);
  }finally{if(server&&server.child.exitCode===null&&server.child.signalCode===null)await stop(server);await fs.rm(dir,{recursive:true});}
});
