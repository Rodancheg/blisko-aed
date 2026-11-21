'use strict';
const crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {normalizeRecord,publicProperties}=require('./data-model');
const {contains}=require('./areas');
const {metres}=require('./duplicate-review');
const {WARSAW,OSM}=require('./registry');
const now=()=>new Date().toISOString();
const fail=(status,message)=>Object.assign(Error(message),{status});
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));return value;}
const fingerprint=record=>record?digest({id:record.id,lat:record.lat,lon:record.lon,properties:publicProperties(record),raw:record.raw}):null;
const builtin=[
 {...WARSAW,title:'Lokalizacja defibryzatorów (AED) — Warszawa',format:'json',mode:'api',url:'https://dane.um.warszawa.pl/api/action/get_scb_lokalizacja_defibrylatorow',method:'POST',secretRef:'WARSAW_API_TOKEN',daily:true,version:0,publicationVersion:0,lastCheckedAt:null,lastSuccessAt:null,nextCheckAt:null,lastError:null,license:{name:'Creative Commons Attribution',url:null,confirmed:true}},
 {id:'bydgoszcz',namespace:'pl.bydgoszcz.city.aed',title:'Miejski wykaz AED — Bydgoszcz',publisher:'Serwis miejski Bydgoszczy — mapa osadzona',terc:'0461011',area_name:'Bydgoszcz',mode:'file',format:'json',url:'https://www.bydgoszcz.pl/bezpieczenstwo/abc-bezpieczenstwa/',daily:false,version:0,publicationVersion:0,lastCheckedAt:null,lastSuccessAt:null,nextCheckAt:null,lastError:null,license:{name:'Warunki wymagają potwierdzenia',url:null,confirmed:false},notes:'Pilotaż: 112 wpisów KML, 111 bez jawnych współrzędnych; właściciel mapy i warunki ponownego wykorzystania wymagają potwierdzenia.'},
 {...OSM,title:'AED Polska — OpenStreetMap',format:'geojson',mode:'api',url:'https://aed.openstreetmap.org.pl/aed_poland.geojson',method:'GET',daily:true,version:0,publicationVersion:0,lastCheckedAt:null,lastSuccessAt:null,nextCheckAt:null,lastError:null,license:{...OSM.license,confirmed:true}}
];
class SourceStore{
 constructor(directory,baseRecords){this.directory=path.join(directory,'data-hub');this.file=path.join(this.directory,'state.json');this.baseRecords=baseRecords;this.writes=Promise.resolve();}
 async read(){try{const state=JSON.parse(await fs.readFile(this.file,'utf8'));for(const source of builtin)if(!state.sources[source.id])state.sources[source.id]={...source};return state;}catch(error){if(error.code!=='ENOENT')throw error;return {version:1,revision:0,publishedRevision:0,sources:Object.fromEntries(builtin.map(source=>[source.id,{...source}])),batches:{},history:[]};}}
 transaction(change){const task=this.writes.then(async()=>{const state=await this.read(),result=await change(state);state.revision++;await fs.mkdir(this.directory,{recursive:true});const temp=this.file+'.tmp',handle=await fs.open(temp,'w');try{await handle.writeFile(JSON.stringify(state));await handle.sync();}finally{await handle.close();}await fs.rename(temp,this.file);return {...result,revision:state.revision,publishedRevision:state.publishedRevision};});this.writes=task.catch(()=>{});return task;}
 async snapshot(ref){if(!ref)return null;if(!/^[a-f0-9-]{36}$/.test(ref))throw Error('Invalid snapshot reference');return JSON.parse(await fs.readFile(path.join(this.directory,'snapshots',ref+'.json'),'utf8'));}
 async saveSnapshot(records,extra={}){const ref=crypto.randomUUID(),directory=path.join(this.directory,'snapshots');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,ref+'.json'),JSON.stringify({createdAt:now(),...extra,records}),{flag:'wx'});return ref;}
 async baseline(source,state){return source.publicationRef?(await this.snapshot(source.publicationRef)).records:(await this.baseRecords()).filter(record=>record.source===source.id);}
 async publishedRecords(base,state){state=state||await this.read();const managed=Object.values(state.sources).filter(source=>source.publicationRef);const ids=new Set(managed.map(source=>source.id));const snapshots=await Promise.all(managed.map(source=>this.snapshot(source.publicationRef)));return [...base.filter(record=>!ids.has(record.source)),...snapshots.flatMap(snapshot=>snapshot.records)];}
 async list(){const state=await this.read();return {sources:Object.values(state.sources).map(source=>this.publicSource(source)),revision:state.revision,publishedRevision:state.publishedRevision};}
 publicSource({secretRef,...source}){return {...source,authorizationRequired:!!secretRef};}
 async saveSource(input){return this.transaction(state=>{
  const previous=input.id?state.sources[input.id]:null;if(input.id&&!previous)throw fail(404,'Nie znaleziono źródła.');
  if(previous&&input.version!==previous.version)throw fail(409,'Źródło zostało zmienione. Odśwież listę.');
  const required=(value,title,max=200)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw fail(400,'Uzupełnij pole: '+title+'.');return value.trim();};
  const id=previous?.id||'src-'+crypto.randomUUID(),title=required(input.title,'nazwa źródła'),publisher=required(input.publisher,'dostawca');
  const terc=input.terc||null;if(terc&&!/^\d{7}$/.test(terc))throw fail(400,'Nieprawidłowy kod TERC.');
  const mode=['file','api'].includes(input.mode)?input.mode:'file',format=input.format||'json';if(!['json','geojson','csv','xlsx'].includes(format))throw fail(400,'Nieobsługiwany format.');
  let url=input.url||null;if(url||mode==='api'){try{const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash||[...parsed.searchParams.keys()].some(key=>/token|secret|password|api.?key|authorization/i.test(key)))throw Error();url=parsed.href;}catch{throw fail(400,'Podaj publiczny adres HTTPS źródła.');}}
  const license={name:required(input.licenseName,'licencja',200),url:input.licenseUrl||null,confirmed:input.licenseConfirmed===true};
  if(license.url){try{if(!['https:','http:'].includes(new URL(license.url).protocol))throw Error();}catch{throw fail(400,'Nieprawidłowy adres licencji.');}}
  if(previous?.publicationRef&&previous.terc!==terc)throw fail(409,'Źródło ma opublikowane dane. Utwórz nowe źródło dla innego zakresu terytorialnego.');
  const source={...previous,id,namespace:previous?.namespace||'pl.blisko.'+id,title,publisher,terc,area_name:input.areaName||null,mode,format,url,
   method:previous?.secretRef?previous.method:'GET',license,daily:mode==='api'&&input.daily===true,version:(previous?.version||0)+1,publicationVersion:previous?.publicationVersion||0,
   lastCheckedAt:previous?.lastCheckedAt||null,lastSuccessAt:previous?.lastSuccessAt||null,nextCheckAt:previous?.nextCheckAt||null,lastError:previous?.lastError||null,createdAt:previous?.createdAt||now(),updatedAt:now()};
  state.sources[id]=source;state.history.push({kind:'source',action:previous?'update':'create',sourceId:id,at:now()});return {source:this.publicSource(source)};
 });}
 async prepare({sourceId,rows,filename,mapping={},area=null,origin='file',archive=null}){
  if(!Array.isArray(rows)||!rows.length||rows.length>25000)throw fail(400,'Import musi zawierać od 1 do 25 000 rekordów.');
  const state=await this.read(),source=state.sources[sourceId];if(!source)throw fail(404,'Wybierz zarejestrowane źródło danych.');
  if(source.terc&&area?.id&&source.terc!==area.id)throw fail(400,'Wybrany obszar nie odpowiada zakresowi źródła.');
  const checkedAt=now(),records=[],errors=[],seen=new Set();
  for(let index=0;index<rows.length;index++){
   try{
    const original=rows[index];if(original?.geometry&&original.geometry.type!=='Point')throw fail(400,'Obsługiwane są wyłącznie punkty AED (Point).');let row=original;
    if(Object.keys(mapping).length){const properties={};for(const [target,column]of Object.entries(mapping)){if(!column)continue;const value=Object.hasOwn(original,column)?original[column]:column.split('.').reduce((value,key)=>value?.[key],original);properties[target]=value;}
     row=properties;}
    const record=normalizeRecord(row,source,{strictCountry:true,importedAt:checkedAt,checkedAt,terc:source.terc||area?.id,areaName:source.area_name||area?.name});record.raw=JSON.parse(JSON.stringify(original));
    if(source.terc&&area&&!contains(area,record)){record.quality_flags=['outside_declared_scope'];record.administrative_area={country:'PL',terc:null,name:null};}
    if(seen.has(record.id))throw fail(400,'Powtórzony defibrillator_id w pliku: '+record.source_record_id);seen.add(record.id);records.push(record);
   }catch(error){errors.push({row:index+1,message:error.message});}
  }
  if(errors.length)return {valid:false,errors,accepted:records.length,total:rows.length};
  const before=await this.baseline(source,state),previous=new Map(before.map(record=>[record.id,record])),next=new Map(records.map(record=>[record.id,record]));
  const changes=[];
  for(const record of records){const old=previous.get(record.id);if(fingerprint(old)!==fingerprint(record))changes.push({id:record.id,type:old?'change':'add',sourceRecordId:record.source_record_id,beforeHash:fingerprint(old),before:old?this.summary(old):null,after:this.summary(record),rawChanged:!!old&&digest(old.raw)!==digest(record.raw),status:'pending'});}
  for(const record of before)if(!next.has(record.id))changes.push({id:record.id,type:'missing',sourceRecordId:record.source_record_id,beforeHash:fingerprint(record),before:this.summary(record),after:null,status:'pending'});
  const peers=[...await this.publishedRecords(await this.baseRecords(),state),...records],grid=new Map();
  for(const peer of peers){const key=Math.floor(peer.lon/.0005)+':'+Math.floor(peer.lat/.0005);if(!grid.has(key))grid.set(key,[]);grid.get(key).push(peer);}
  for(const change of changes.filter(change=>change.type==='add')){const record=next.get(change.id),x=Math.floor(record.lon/.0005),y=Math.floor(record.lat/.0005),matches=new Map();
   for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const peer of grid.get((x+dx)+':'+(y+dy))||[]){if(peer.id!==record.id&&metres(peer,record)<=25)matches.set(peer.id,{id:peer.id,name:peer.name,lat:peer.lat,lon:peer.lon});}
   if(matches.size)change.possibleDuplicates=[...matches.values()].slice(0,5);
  }
  const contentHash=digest(records.map(record=>({id:record.id,hash:fingerprint(record)})).sort((a,b)=>a.id.localeCompare(b.id)));
  const reusable=Object.values(state.batches).find(batch=>batch.sourceId===sourceId&&batch.baseVersion===source.publicationVersion&&batch.sourceVersion===source.version&&batch.contentHash===contentHash);
  const snapshot=changes.length?(reusable?.snapshot||await this.saveSnapshot(records,{sourceId,filename:path.basename(filename||'API'),archive})):null;
  const beforeSnapshot=changes.length?(reusable?.beforeSnapshot||source.publicationRef||await this.saveSnapshot(before,{sourceId,kind:'before-import'})):null;
  return this.transaction(current=>{
   const live=current.sources[sourceId];if(live.version!==source.version||live.publicationVersion!==source.publicationVersion)throw fail(409,'Źródło zmieniło się podczas przygotowania importu. Wczytaj plik ponownie.');
   if(origin==='file')live.mapping=mapping;live.lastCheckedAt=checkedAt;live.lastSuccessAt=checkedAt;live.lastError=null;live.nextCheckAt=new Date(Date.parse(checkedAt)+86400000).toISOString();
   if(!changes.length)return {valid:true,unchanged:true,counts:{add:0,change:0,missing:0,unchanged:records.length},message:'Dane są zgodne z opublikowaną wersją.'};
   const existing=Object.values(current.batches).find(batch=>batch.sourceId===sourceId&&batch.baseVersion===source.publicationVersion&&batch.sourceVersion===source.version&&batch.contentHash===contentHash);
   if(existing){existing.beforeSnapshot=existing.beforeSnapshot||beforeSnapshot;return {valid:true,batch:this.publicBatch(existing),reused:true};}
   const batch={id:crypto.randomUUID(),sourceId,sourceVersion:source.version,baseVersion:source.publicationVersion,contentHash,snapshot,beforeSnapshot,filename:path.basename(filename||'API').slice(0,200),origin,createdAt:checkedAt,version:0,changes,unchanged:records.length-changes.filter(change=>change.type!=='missing').length};
   current.batches[batch.id]=batch;current.history.push({kind:'batch',action:'prepare',batchId:batch.id,sourceId,at:checkedAt});return {valid:true,batch:this.publicBatch(batch)};
  });
 }
 summary(record){return {id:record.id,registry_id:record.registry_id,source_record_id:record.source_record_id,lat:record.lat,lon:record.lon,properties:{...publicProperties(record),source_updated_at:record.provenance?.[0]?.source_updated_at||null},administrative_area:record.administrative_area,quality_flags:record.quality_flags||[]};}
 publicBatch(batch){return {...batch,counts:{add:batch.changes.filter(change=>change.type==='add').length,change:batch.changes.filter(change=>change.type==='change').length,missing:batch.changes.filter(change=>change.type==='missing').length,unchanged:batch.unchanged},pending:batch.changes.filter(change=>change.status==='pending').length};}
 async batches(sourceId){const state=await this.read();return {batches:Object.values(state.batches).filter(batch=>!sourceId||batch.sourceId===sourceId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(batch=>({...this.publicBatch(batch),stale:batch.baseVersion!==state.sources[batch.sourceId]?.publicationVersion||batch.sourceVersion!==state.sources[batch.sourceId]?.version})),history:state.history.filter(item=>item.kind==='publication').slice(-50).reverse(),revision:state.revision,publishedRevision:state.publishedRevision};}
 async decide(input){return this.transaction(async state=>{
  const batch=state.batches[input.batchId];if(!batch)throw fail(404,'Nie znaleziono importu.');
  if(input.version!==batch.version)throw fail(409,'Import został zmieniony. Odśwież podgląd.');
  if(!['approve','reject'].includes(input.action))throw fail(400,'Nieprawidłowa decyzja.');
  if(!Array.isArray(input.ids)||!input.ids.length||input.ids.some(id=>typeof id!=='string'))throw fail(400,'Wybierz zmiany do rozpatrzenia.');
  const ids=new Set(input.ids),selected=batch.changes.filter(change=>ids.has(change.id)&&change.status==='pending');if(selected.length!==ids.size)throw fail(409,'Wybrane zmiany zostały już rozpatrzone.');
  const source=state.sources[batch.sourceId],decisionId=crypto.randomUUID();
  if(input.action==='approve'){
   if(!source.license?.confirmed)throw fail(400,'Potwierdź warunki ponownego wykorzystania w ustawieniach źródła.');
   if(source.version!==batch.sourceVersion)throw fail(409,'Zmieniono ustawienia źródła. Przygotuj nowy podgląd zmian.');
   if(source.publicationVersion!==batch.baseVersion)throw fail(409,'Opublikowano inną wersję źródła. Przygotuj nowy podgląd zmian.');
   const baseline=await this.baseline(source,state),published=new Map(baseline.map(record=>[record.id,record])),incoming=new Map((await this.snapshot(batch.snapshot)).records.map(record=>[record.id,record]));
   for(const change of selected){if(fingerprint(published.get(change.id))!==change.beforeHash)throw fail(409,'Dane rekordu zmieniły się. Przygotuj nowy podgląd.');if(change.type==='missing')published.delete(change.id);else published.set(change.id,incoming.get(change.id));}
   const beforeRef=source.publicationRef||batch.beforeSnapshot||await this.saveSnapshot(baseline,{sourceId:source.id});
   const publicationAt=now();for(const change of selected){if(change.type!=='missing')published.get(change.id).review={status:'approved',reviewed_at:publicationAt,method:'administrator_review'};}source.publicationRef=await this.saveSnapshot([...published.values()],{sourceId:source.id,publishedAt:publicationAt});source.publicationVersion++;source.lastPublishedAt=publicationAt;state.publishedRevision++;
   state.history.push({id:decisionId,kind:'publication',action:'approve',sourceId:source.id,batchId:batch.id,ids:[...ids],beforeRef,afterRef:source.publicationRef,sourceVersion:source.publicationVersion,at:publicationAt});batch.baseVersion=source.publicationVersion;
  }
  if(input.action==='reject')state.history.push({id:decisionId,kind:'publication',action:'reject',sourceId:source.id,batchId:batch.id,ids:[...ids],at:now()});
  for(const change of selected){change.decisionId=decisionId;change.status=input.action==='approve'?'approved':'rejected';change.decidedAt=now();}batch.version++;
  return {batch:this.publicBatch(batch)};
 });}
 async undo(input){return this.transaction(state=>{
  const event=state.history.find(event=>event.kind==='publication'&&event.id===input.id),source=event&&state.sources[event.sourceId];
  if(!event||!['approve','reject'].includes(event.action)||event.undoneAt)throw fail(404,'Nie znaleziono decyzji do cofnięcia.');
  if(event.action==='approve'&&source.publicationRef!==event.afterRef)throw fail(409,'Źródło ma późniejsze zmiany. Cofnij je w odwrotnej kolejności.');
  const batch=state.batches[event.batchId];if(batch.changes.some(change=>event.ids.includes(change.id)&&change.decisionId&&change.decisionId!==event.id))throw fail(409,'Wybrane wiersze mają późniejsze decyzje.');
  if(event.action==='approve'){source.publicationRef=event.beforeRef;source.publicationVersion++;source.lastPublishedAt=now();state.publishedRevision++;batch.baseVersion=source.publicationVersion;}event.undoneAt=now();
  for(const change of batch.changes)if(event.ids.includes(change.id)){change.status='pending';delete change.decidedAt;delete change.decisionId;}batch.version++;
  state.history.push({id:crypto.randomUUID(),kind:'publication',action:'undo',sourceId:source.id,batchId:batch.id,at:now(),undoes:event.id});return {batch:this.publicBatch(batch)};
 });}
 async syncError(sourceId,message){return this.transaction(state=>{const source=state.sources[sourceId];if(!source)return {};source.lastCheckedAt=now();source.lastError=String(message).slice(0,500);source.nextCheckAt=new Date(Date.now()+3600000).toISOString();return {};});}
}
module.exports={SourceStore,fingerprint};
