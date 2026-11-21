const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const {ReviewStore,candidates,resolve:resolveDuplicates,metres}=require('./lib/duplicate-review');
const {records:registryRecords}=require('./lib/registry');
const {AdminAuth}=require('./lib/admin-auth');
const {WarsawPhotos}=require('./lib/warsaw-photos');
const {SourceStore}=require('./lib/source-store');
const {SourceSync}=require('./lib/source-sync');
const {readUpload,mappingFor}=require('./lib/import-reader');
const {toFeature,toWarsaw,publicProperties,publicVerification,publicReview,SCHEMA_VERSION}=require('./lib/data-model');
const crypto=require('node:crypto');
const {buildHarvester}=require('./lib/portal-export');
const {responsibility,publicationStatus}=require('./lib/publication');
const {Areas,contains:inArea,publicArea,filterModeration,importFields}=require('./lib/areas');
const areas=new Areas(path.join(__dirname,'collector','results'));
const {ModerationStore,proposalRecords,applyReports,candidateRecords}=require('./lib/moderation');
const runtimeDirectory=process.env.AED_REVIEW_DIR||path.join(__dirname,'runtime');
const reviewStore=new ReviewStore(runtimeDirectory),adminAuth=new AdminAuth(runtimeDirectory);
const sourceStore=new SourceStore(runtimeDirectory,loadLegacyRegistry);
const sourceSync=new SourceSync(sourceStore,areas,__dirname);
let registryWrites=Promise.resolve();
function registryMutation(change){const task=registryWrites.then(change);registryWrites=task.catch(()=>{});return task;}
const moderationStore=new ModerationStore(runtimeDirectory,async state=>resolveDuplicates([...await loadRegistry(),...proposalRecords(state)],(await reviewStore.read()).decisions),process.env.AED_REVIEW_DIR?null:__dirname);
const warsawPhotos=new WarsawPhotos(path.join(runtimeDirectory,'warsaw-photos'),async id=>{
  let token=process.env.WARSAW_API_TOKEN;
  if(!token){const env=await fs.readFile(path.join(__dirname,'.env'),'utf8');token=env.match(/^WARSAW_API_TOKEN=(.*)$/m)?.[1]?.trim()}
  if(!token)throw Object.assign(Error('Źródło zdjęć jest niedostępne.'),{status:503});
  try{
    const upstream=await fetch('https://dane.um.warszawa.pl/api/action/get_scb_lokalizacja_defibrylatorow',{method:'POST',headers:{Authorization:token,'Content-Type':'application/json'},body:JSON.stringify({defibrillator_id:id}),signal:AbortSignal.timeout(60000)});
    if(!upstream.ok)throw Object.assign(Error('Źródło zdjęć jest chwilowo niedostępne.'),{status:503});
    return await upstream.json();
  }catch(error){if(error.status)throw error;throw Object.assign(Error('Nie udało się pobrać zdjęcia ze źródła. Spróbuj ponownie.'),{status:503});}
});
const root=path.join(__dirname,'dist'),port=Number(process.env.PORT??8765);let cache=null,updated=0,osmCache=null,osmUpdated=0;
const adminPages={
  '/admin/map':{section:'coverage',view:'coverage',title:'Mapa pokrycia',description:'Zobacz znane AED i obszary poza wybranym promieniem.',script:'admin.js'},
  '/admin/new':{section:'proposals',view:'moderation',title:'Kolejka nowych AED',description:'Sprawdź nowe punkty przed dodaniem ich do rejestru.',script:'moderation.js'},
  '/admin/reports':{section:'reports',view:'moderation',title:'Uwagi i zgłoszenia',description:'Rozpatrz problemy i zatwierdź sprawdzone poprawki.',script:'moderation.js'},
  '/admin/duplicates':{section:'duplicates',view:'duplicates',title:'Możliwe duplikaty',description:'Porównaj pobliskie rekordy i zdecyduj, czy opisują to samo urządzenie.',script:'duplicate-review.js'},
  '/admin/data':{section:'data',view:'data',title:'Dane i import',description:'Sprawdź gotowe obszary, pobierz dane albo prześlij nowe punkty do weryfikacji.'}
};
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const distance=(a,b,c,d)=>{const r=x=>x*Math.PI/180,x=r(c-a),y=r(d-b),q=Math.sin(x/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(y/2)**2;return 6371*2*Math.atan2(Math.sqrt(q),Math.sqrt(1-q))};
async function localSnapshot(prefix,extension){
  const directory=process.env.AED_SNAPSHOT_DIR||path.join(__dirname,'data-model','snapshots');
  let names;try{names=await fs.readdir(directory)}catch(error){if(error.code==='ENOENT')return null;throw error}
  const name=names.filter(name=>name.startsWith(prefix)&&name.endsWith(extension)).sort().at(-1);
  return name?JSON.parse(await fs.readFile(path.join(directory,name),'utf8')):null;
}
let legacyMetadata=null;
async function loadLegacyRegistry(){
 const rows=await Promise.all([loadWarsaw(),loadOSM()]);
 if(!legacyMetadata){legacyMetadata={};if(!process.env.AED_SNAPSHOT_DIR){for(const [id,file]of [['warsaw','warsaw.json'],['osm','osm-poland.json']]){try{const metadata=JSON.parse(await fs.readFile(path.join(__dirname,'data-model','sources',file),'utf8'));legacyMetadata[id]={importedAt:metadata.fetched_at||null};}catch{}}}}
 return registryRecords(...rows,legacyMetadata);
}
async function loadRegistry(sourceState){return sourceStore.publishedRecords(await loadLegacyRegistry(),sourceState)}
const registryRevision=context=>context.moderation.registryRevision+':'+context.sourceState.publishedRevision;
async function loadContext(){
  const [moderation,reviews,sourceState]=await Promise.all([moderationStore.read(),reviewStore.read(),sourceStore.read()]);
  const originals=[...await loadRegistry(sourceState),...proposalRecords(moderation)].map(record=>({...record,verification:publicVerification(record),review:publicReview(record)}));
  const projected=applyReports(resolveDuplicates(originals,reviews.decisions),moderation);
  return {moderation,reviews,sourceState,originals,projected,visible:projected.filter(record=>!record.hidden),candidates:candidateRecords(projected)};
}
async function readReviewBody(req,maxBytes=8192){
  const origin=req.headers.origin;
  let accepted=false;try{const parsed=new URL(origin);accepted=['http:','https:'].includes(parsed.protocol)&&parsed.host===req.headers.host}catch{}
  if(!accepted||!String(req.headers['content-type']||'').startsWith('application/json'))throw Object.assign(Error('Nieprawidłowe pochodzenie żądania.'),{status:403});
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw Object.assign(Error('Żądanie jest zbyt duże.'),{status:413});chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');
  try{const input=JSON.parse(raw);if(!input||typeof input!=='object'||Array.isArray(input))throw Error();return input}catch{throw Object.assign(Error('Nieprawidłowy JSON.'),{status:400})}
}
function jsonResponse(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
async function loadWarsaw(){if(cache&&Date.now()-updated<4*60*60*1000)return cache;const local=await localSnapshot('warsaw-','.json');if(local){if(!Array.isArray(local))throw Error('Invalid Warsaw snapshot');cache=local;updated=Date.now();return cache}let token=process.env.WARSAW_API_TOKEN;if(!token){const env=await fs.readFile(path.join(__dirname,'.env'),'utf8');token=env.match(/^WARSAW_API_TOKEN=(.*)$/m)?.[1]?.trim()}if(!token)throw Error('Missing token');const response=await fetch('https://dane.um.warszawa.pl/api/action/get_scb_lokalizacja_defibrylatorow',{method:'POST',headers:{Authorization:token},signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('Warsaw API error');const json=await response.json();if(!Array.isArray(json))throw Error('Unexpected Warsaw response');cache=json;updated=Date.now();return cache}
function warsawPoints(data,lat,lon){return data.map(e=>{const raw=e.geometry?.coordinates,coords=Array.isArray(raw?.[0])?raw[0]:raw,t=e.properties||{},x=Number(coords?.[0]),y=Number(coords?.[1]);return {id:String(t.defibrillator_id||''),source:'warsaw',lat:y,lon:x,name:t.location_object_name||'Defibrylator AED',address:[t.location_street,t.location_building,t.location_city].filter(Boolean).join(' ')||'Adres nieznany',description:t.location_description||'',access:[t.device_public_access,t.device_availability].filter(Boolean).join(' · ')||'Dostępność nieznana',hours:t.device_access_description||'Godziny nieznane',distance:distance(lat,lon,y,x)}}).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&p.distance<=10).sort((a,b)=>a.distance-b.distance).slice(0,12)}
async function loadOSM(){if(!osmCache||Date.now()-osmUpdated>=4*60*60*1000){const local=await localSnapshot('osm-poland-','.geojson');if(local){if(!Array.isArray(local.features))throw Error('Invalid OSM snapshot');osmCache=local.features;osmUpdated=Date.now();return osmCache}const response=await fetch('https://aed.openstreetmap.org.pl/aed_poland.geojson',{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('OpenStreetMap unavailable');const data=await response.json();if(!Array.isArray(data.features))throw Error('Unexpected OpenStreetMap response');osmCache=data.features;osmUpdated=Date.now()}return osmCache}
async function osmPoints(lat,lon){return (await loadOSM()).map(e=>{const coords=e.geometry?.coordinates,t=e.properties||{},x=Number(coords?.[0]),y=Number(coords?.[1]);return {id:String(t['@osm_type']||'node')+'/'+String(t['@osm_id']||''),source:'osm',photoCommons:typeof t.wikimedia_commons==='string'&&t.wikimedia_commons.startsWith('File:')?t.wikimedia_commons:'',lat:y,lon:x,name:t.name||'Defibrylator AED',address:[t['addr:street'],t['addr:housenumber'],t['addr:city']].filter(Boolean).join(' ')||'Adres nieznany',description:t['defibrillator:location']||t.description||'',access:t.access||'Dostępność nieznana',hours:t.opening_hours||'Godziny nieznane',distance:distance(lat,lon,y,x)}}).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&p.distance<=10).sort((a,b)=>a.distance-b.distance).slice(0,12)}
http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');
if(req.method==='GET'&&['/api/areas','/api/dataset','/api/export','/api/schema','/api/dane-gov.xml','/api/dane-gov.xml.md5'].includes(url.pathname)&&url.searchParams.get('view')!=='raw')res.setHeader('Access-Control-Allow-Origin','*');
const pagePath=decodeURIComponent(url.pathname);
if(pagePath==='/admin.html'||pagePath==='/admin'||pagePath==='/admin/'){
  res.writeHead(302,{'Cache-Control':'no-store',Location:'/admin/map'+url.search});res.end();return;
}
if(Object.hasOwn(adminPages,pagePath)){
  if(!await adminAuth.authenticated(req)){res.writeHead(302,{'Cache-Control':'no-store',Location:'/login.html?next='+encodeURIComponent(pagePath+url.search)});res.end();return}
  const page=adminPages[pagePath];
  const [layout,content]=await Promise.all([fs.readFile(path.join(root,'admin.html'),'utf8'),fs.readFile(path.join(root,'admin-views',page.view+'.html'),'utf8')]);
  const scripts=(page.section==='coverage'?['https://unpkg.com/leaflet@1.9.4/dist/leaflet.js','/hours.js']:[]).concat(['/admin-scope.js','/admin-auth.js','/admin-common.js'],page.script?['/'+page.script]:[],['/admin-shell.js'],page.section==='data'?['/data-hub.js']:[]);
  const html=layout.replace('<!--ADMIN_CONTENT-->',content).replaceAll('<!--ADMIN_TITLE-->',page.title).replace('<!--ADMIN_DESCRIPTION-->',page.description).replace('<!--ADMIN_SECTION-->',page.section).replace('<!--ADMIN_SCRIPTS-->',scripts.map(src=>'<script src="'+src+'"></script>').join(''));
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);return;
}
if(url.pathname==='/login.html')res.setHeader('Cache-Control','no-store');
if(url.pathname==='/api/admin/publication'){
  await adminAuth.require(req);
  if(req.method==='GET'){const settings=(await sourceStore.read()).publication||{};jsonResponse(res,{settings,schema:'https://dane.gov.pl/static/xml/otwarte_dane_latest.xsd',...publicationStatus(settings)});return;}
  if(req.method==='POST'){
    const input=await readReviewBody(req),publisher=typeof input.publisher==='string'?input.publisher.trim():'';
    if(publisher.length>200||input.responsibilityAccepted===true&&!publisher)throw Object.assign(Error('Podaj nazwę organizacji odpowiedzialnej za zbiór.'),{status:400});
    const publicBaseUrl=typeof input.publicBaseUrl==='string'?input.publicBaseUrl.trim():'';
    if(publicBaseUrl)buildHarvester({baseUrl:publicBaseUrl,areas:[],publisher,draft:true});
    jsonResponse(res,await sourceStore.transaction(state=>{state.publication={publicBaseUrl:publicBaseUrl?new URL(publicBaseUrl).origin:null,publisher,responsibilityAccepted:input.responsibilityAccepted===true,providerIdentifier:typeof input.providerIdentifier==='string'?input.providerIdentifier.trim().slice(0,100):'',updatedAt:new Date().toISOString()};return {settings:state.publication,...publicationStatus(state.publication)};}),201);return;
  }
  res.writeHead(405);res.end();return;
}
if((url.pathname==='/api/dane-gov.xml'||url.pathname==='/api/dane-gov.xml.md5'||url.pathname==='/api/admin/publication/preview')&&req.method==='GET'){
  const preview=url.pathname==='/api/admin/publication/preview';if(preview)await adminAuth.require(req);
  const state=await sourceStore.read(),settings=state.publication||{};
  const status=publicationStatus(settings);
  if(!preview&&!status.export_ready){jsonResponse(res,{error:'Eksport dla portalu jest nieaktywny. '+status.missing.join(' '),...status},503);return;}
  const [moderation,reviews]=await Promise.all([moderationStore.read(),reviewStore.read()]);
  const dates=[...Object.values(state.sources).map(source=>source.lastPublishedAt),...moderation.history.filter(event=>['approve','undo'].includes(event.action)).map(event=>event.at),...reviews.history.map(event=>event.reviewedAt)].filter(Boolean).sort();
  const body=buildHarvester({baseUrl:settings.publicBaseUrl||'https://example.invalid',publisher:status.responsibility.organization,areas:(await areas.list()).map(publicArea),updatedAt:dates.at(-1)||null,draft:preview});
  if(url.pathname.endsWith('.md5')){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(crypto.createHash('md5').update(body).digest('hex'));return;}
  res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'no-store','Content-Disposition':'attachment; filename="blisko-aed-dane-gov.xml"'});res.end(body);return;
}
if(url.pathname.startsWith('/api/templates/')&&req.method==='GET'){
  const name=url.pathname.slice('/api/templates/'.length),files={'warsaw.json':'application/json; charset=utf-8','aed.csv':'text/csv; charset=utf-8','aed.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
  if(!Object.hasOwn(files,name)){res.writeHead(404);res.end();return;}
  const bytes=await fs.readFile(path.join(__dirname,'data-model','templates',name));res.writeHead(200,{'Content-Type':files[name],'Content-Disposition':'attachment; filename="'+name+'"','Cache-Control':'public, max-age=3600'});res.end(bytes);return;
}
if(url.pathname==='/api/schema'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/schema+json; charset=utf-8'});res.end(await fs.readFile(path.join(__dirname,'data-model','registry-feature.schema.json')));return;}
if(url.pathname==='/api/areas'&&req.method==='GET'){jsonResponse(res,{areas:(await areas.list()).map(publicArea)});return;}
if(url.pathname==='/api/dataset'&&req.method==='GET'){
  const area=await areas.selected(url),context=await loadContext(),records=context.visible.filter(record=>inArea(area,record));
  const sourceIds=new Set(records.flatMap(record=>(record.source_records||[record]).map(source=>source.source)));
  const sources=Object.values(context.sourceState.sources).filter(source=>sourceIds.has(source.id)).map(source=>({id:source.id,title:source.title,publisher:source.publisher,license:source.license,terc:source.terc||null,lastCheckedAt:source.lastCheckedAt,lastPublishedAt:source.lastPublishedAt||null,refreshStatus:source.lastError?'delayed':'available'}));
  if(sourceIds.has('community'))sources.push({id:'community',title:'Zatwierdzone zgłoszenia społeczności',publisher:'Zgłaszający społeczności',license:null,lastCheckedAt:null,lastPublishedAt:null});
  jsonResponse(res,{schema_version:SCHEMA_VERSION,title:'Rejestr AED — '+(area?.name||'Polska'),area:area?publicArea(area):null,records:records.length,responsibility:responsibility(context.sourceState.publication),sources,version:context.reviews.revision+':'+registryRevision(context),downloads:{json:'/api/export?format=json'+(area?'&city='+area.id:''),geojson:'/api/export?format=geojson'+(area?'&city='+area.id:''),csv:'/api/export?format=csv'+(area?'&city='+area.id:'')},limitations:['Zakres obejmuje dane pozyskane z wymienionych źródeł. Brak AED w zbiorze nie potwierdza braku urządzeń.','Data sprawdzenia źródła i decyzja administratora nie są terenową weryfikacją urządzenia ani potwierdzeniem przez odpowiedzialnego dostawcę.']});return;
}
if(url.pathname==='/api/admin/cities'&&req.method==='GET'){
  await adminAuth.require(req);jsonResponse(res,{areas:(await areas.list()).map(publicArea)});return;
}
if(url.pathname==='/api/admin/data'&&req.method==='GET'){
  await adminAuth.require(req);const area=await areas.selected(url),context=await loadContext();
  const records=context.visible.filter(record=>inArea(area,record));
  let collector=null;try{collector=JSON.parse(await fs.readFile(path.join(__dirname,'collector','status.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
  const snapshots=process.env.AED_SNAPSHOT_DIR||path.join(__dirname,'data-model','snapshots');
  const filenames=await fs.readdir(snapshots).catch(error=>{if(error.code==='ENOENT')return [];throw error});
  const sources=await Promise.all([['osm','OpenStreetMap Polska','osm-poland-','.geojson','GeoJSON'],['warsaw','Urząd m.st. Warszawy','warsaw-','.json','JSON']].map(async([id,label,prefix,extension,format])=>{
    const filename=filenames.filter(name=>name.startsWith(prefix)&&name.endsWith(extension)).sort().at(-1);
    const stat=filename?await fs.stat(path.join(snapshots,filename)):null;
    return{id,label,format,filename:filename||null,bytes:stat?.size||null,updatedAt:stat?.mtime.toISOString()||null,records:records.filter(record=>record.source_records?.some(source=>source.source===id)||record.source===id).length};
  }));
  for(const source of Object.values(context.sourceState.sources)){
    const count=records.filter(record=>(record.source_records||[record]).some(member=>member.source===source.id)).length;
    const existing=sources.find(row=>row.id===source.id);
    if(existing){existing.updatedAt=source.lastSuccessAt||existing.updatedAt;existing.lastPublishedAt=source.lastPublishedAt||null;continue;}
    if(count||!area||!source.terc||source.terc===area.id)sources.push({id:source.id,label:source.title+' — '+source.publisher,format:source.format.toUpperCase(),records:count,updatedAt:source.lastSuccessAt||null,lastPublishedAt:source.lastPublishedAt||null});
  }
  sources.push({id:'community',label:'Zatwierdzone zgłoszenia',format:'Rejestr',records:records.filter(record=>record.source_records?.some(source=>source.source==='community')||record.source==='community').length});
  jsonResponse(res,{area:area?publicArea(area):null,records:records.length,sources,collector,areas:(await areas.list()).map(publicArea)});return;
}
if(url.pathname==='/api/admin/sources'){
  await adminAuth.require(req);
  if(req.method==='GET'){jsonResponse(res,await sourceStore.list());return;}
  if(req.method==='POST'){const input=await readReviewBody(req,20000);if(input.terc)await areas.selected(new URL('/?city='+encodeURIComponent(input.terc),'http://localhost'));jsonResponse(res,await sourceStore.saveSource(input),201);return;}
  res.writeHead(405);res.end();return;
}
if(url.pathname==='/api/admin/sources/sync'&&req.method==='POST'){await adminAuth.require(req);const input=await readReviewBody(req);jsonResponse(res,await sourceSync.sync(input.sourceId),201);return;}
if(url.pathname==='/api/admin/uploads'&&req.method==='POST'){
  await adminAuth.require(req);const input=await readReviewBody(req,21000000),table=await readUpload(input);
  const id=crypto.randomUUID(),directory=path.join(runtimeDirectory,'data-hub','uploads'),filename=path.basename(input.filename).slice(0,200),bytes=Buffer.from(input.content,'base64');
  await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,id+'.upload'),bytes,{flag:'wx'});
  await fs.writeFile(path.join(directory,id+'.json'),JSON.stringify({filename,format:table.format,rows:table.rows,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}),{flag:'wx'});
  jsonResponse(res,{uploadId:id,filename,format:table.format,total:table.rows.length,sheets:table.sheets,selectedSheet:table.selectedSheet,...mappingFor(table.rows),sample:table.rows.slice(0,5)},201);return;
}
if(url.pathname==='/api/admin/imports'&&req.method==='GET'){await adminAuth.require(req);jsonResponse(res,await sourceStore.batches(url.searchParams.get('source')));return;}
if(url.pathname==='/api/admin/imports/preview'&&req.method==='POST'){
  await adminAuth.require(req);const input=await readReviewBody(req,30000);
  if(!/^[a-f0-9-]{36}$/.test(input.uploadId||''))throw Object.assign(Error('Wybierz plik do importu.'),{status:400});
  const upload=JSON.parse(await fs.readFile(path.join(runtimeDirectory,'data-hub','uploads',input.uploadId+'.json'),'utf8'));
  const source=(await sourceStore.read()).sources[input.sourceId];if(!source)throw Object.assign(Error('Wybierz źródło danych.'),{status:400});
  const area=source.terc?await areas.selected(new URL('/?city='+source.terc,'http://localhost')):null;
  const allowed=new Set(mappingFor(upload.rows).fields),mapping=input.mapping||{};
  if(Object.keys(mapping).some(key=>!allowed.has(key)||typeof mapping[key]!=='string'))throw Object.assign(Error('Nieprawidłowe przypisanie kolumn.'),{status:400});
  jsonResponse(res,await sourceStore.prepare({sourceId:source.id,rows:upload.rows,filename:upload.filename,mapping,area,archive:{uploadId:input.uploadId,sha256:upload.sha256}}),201);return;
}
if(url.pathname==='/api/admin/import-record'&&req.method==='GET'){
  await adminAuth.require(req);const state=await sourceStore.read(),batch=state.batches[url.searchParams.get('batch')];
  if(!batch){jsonResponse(res,{error:'Nie znaleziono importu.'},404);return;}
  const ref=url.searchParams.get('side')==='before'?batch.beforeSnapshot:batch.snapshot;
  const snapshot=ref?await sourceStore.snapshot(ref):null,record=snapshot?.records.find(record=>record.id===url.searchParams.get('id'));
  if(!record){jsonResponse(res,{error:'Brak oryginału rekordu w tej wersji.'},404);return;}
  jsonResponse(res,{id:record.id,raw:record.raw,provenance:record.provenance});return;
}
if(url.pathname==='/api/admin/imports/decisions'&&req.method==='POST'){await adminAuth.require(req);const input=await readReviewBody(req,3000000);jsonResponse(res,await registryMutation(()=>sourceStore.decide(input)),201);return;}
if(url.pathname==='/api/admin/imports/undo'&&req.method==='POST'){await adminAuth.require(req);const input=await readReviewBody(req);jsonResponse(res,await registryMutation(()=>sourceStore.undo(input)),201);return;}
if(url.pathname==='/api/admin/import'&&req.method==='POST'){
  const input=await readReviewBody(req,1000000);await adminAuth.require(req);const area=await areas.selected(url);
  const rows=Array.isArray(input.records)?input.records:input.records?.type==='FeatureCollection'?input.records.features:null;
  if(!Array.isArray(rows))throw Object.assign(Error('Wybierz tablicę JSON albo kolekcję GeoJSON FeatureCollection.'),{status:400});
  jsonResponse(res,await moderationStore.submitBatch(rows.map(importFields),input.filename,area,inArea),201);return;
}
if(url.pathname==='/api/admin/session'){
  if(req.method==='GET'){await adminAuth.config();jsonResponse(res,{authenticated:await adminAuth.authenticated(req)});return}
  if(req.method==='POST'){const input=await readReviewBody(req);res.setHeader('Set-Cookie',await adminAuth.login(req,input.password));jsonResponse(res,{authenticated:true});return}
  if(req.method==='DELETE'){await readReviewBody(req);res.setHeader('Set-Cookie','aed_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');jsonResponse(res,{authenticated:false});return}
  res.writeHead(405);res.end();return;
}
if(url.pathname==='/api/proposals'||url.pathname==='/api/admin/drafts'){
  if(req.method==='POST'){const result=await moderationStore.submitProposal(await readReviewBody(req,2100000));jsonResponse(res,{...result.item,...result.item.fields},201);return}
  if(req.method==='GET'){await adminAuth.require(req);const state=await moderationStore.read();jsonResponse(res,state.proposals.map(item=>({...item,...item.fields})));return}
  res.writeHead(405);res.end();return;
}
if(url.pathname==='/api/reports'){
  if(req.method==='POST'){jsonResponse(res,(await moderationStore.submitReport(await readReviewBody(req))).item,201);return}
  if(req.method==='GET'){await adminAuth.require(req);jsonResponse(res,(await moderationStore.read()).reports);return}
  res.writeHead(405);res.end();return;
}
if(url.pathname==='/api/admin/moderation'&&req.method==='GET'){
  await adminAuth.require(req);const area=await areas.selected(url);jsonResponse(res,filterModeration(await moderationStore.list(),area));return;
}
if(url.pathname==='/api/admin/moderation/summary'&&req.method==='GET'){
  await adminAuth.require(req);const area=await areas.selected(url),state=filterModeration(area?await moderationStore.list():await moderationStore.read(),area);
  jsonResponse(res,{revision:state.revision,registryRevision:state.registryRevision,proposals:state.proposals.filter(item=>item.status==='pending').length,reports:state.reports.filter(item=>item.status==='pending').length});return;
}
if(url.pathname==='/api/admin/moderation/decisions'){
  if(req.method!=='POST'){res.writeHead(405);res.end();return}
  const input=await readReviewBody(req);await adminAuth.require(req);jsonResponse(res,await registryMutation(()=>moderationStore.review(input)),201);return;
}
if(url.pathname==='/api/registry/version'&&req.method==='GET'){
  const [a,b,c]=await Promise.all([reviewStore.read(),moderationStore.read(),sourceStore.read()]);jsonResponse(res,{version:a.revision+':'+b.registryRevision+':'+c.publishedRevision});return;
}
if(url.pathname==='/api/duplicates'&&req.method==='GET'){
  const context=await loadContext(),records=context.candidates,state=context.reviews;
  const area=await areas.selected(url),all=candidates(records,state.decisions).filter(pair=>inArea(area,pair.a)||inArea(area,pair.b)),offset=Math.max(0,parseInt(url.searchParams.get('offset'))||0),limit=Math.min(50,Math.max(1,parseInt(url.searchParams.get('limit'))||20));
  jsonResponse(res,{pairs:all.slice(offset,offset+limit),total:all.length,offset,limit,revision:state.revision,reviewed:Object.keys(state.decisions).length,threshold:25,moderationRevision:registryRevision(context)});return;
}
if(url.pathname==='/api/duplicates/history'&&req.method==='GET'){
  await adminAuth.require(req);const state=await reviewStore.read(),moderation=await moderationStore.read();
  const area=await areas.selected(url),decisions=Object.values(state.decisions).filter(item=>!area||item.snapshots?.some(record=>inArea(area,record))).sort((a,b)=>b.sequence-a.sequence);
  jsonResponse(res,{decisions,revision:state.revision,events:state.history.length,moderationRevision:moderation.registryRevision+':'+(await sourceStore.read()).publishedRevision});return;
}
if(url.pathname==='/api/duplicates/decisions'){
  if(req.method!=='POST'){res.writeHead(405);res.end();return}
  const input=await readReviewBody(req);await adminAuth.require(req);
  const result=await registryMutation(async()=>{const context=await loadContext();if(input.moderationRevision!==registryRevision(context))throw Object.assign(Error('Rejestr zmienił się po moderacji lub publikacji źródła. Odśwież pary.'),{status:409});return reviewStore.decide(input,context.candidates);});
  jsonResponse(res,result,201);return;
}
if(url.pathname==='/api/export'&&req.method==='GET'){
  const view=url.searchParams.get('view');if(view==='raw')await adminAuth.require(req);
  const context=await loadContext(),state=context.reviews;
  const area=await areas.selected(url),all=(view==='raw'?context.originals:context.visible).filter(record=>inArea(area,record)).map(record=>area?{...record,administrative_area:{country:'PL',terc:area.id,name:area.name}}:record);
  const format=url.searchParams.get('format');
  const datasetResponsibility=responsibility(context.sourceState.publication);
  if(format==='geojson'){
    const data={type:'FeatureCollection',responsibility:datasetResponsibility,review_revision:state.revision,moderation_revision:registryRevision(context),view:view==='raw'?'raw':'reviewed',schema_version:SCHEMA_VERSION,features:all.map(record=>toFeature(record,{raw:view==='raw'}))};
    res.writeHead(200,{'Content-Type':'application/geo+json; charset=utf-8','Cache-Control':'no-store','Content-Disposition':'attachment; filename="aed-registry.geojson"'});res.end(JSON.stringify(data));return;
  }
  if(format==='json'||format==='warsaw'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Disposition':'attachment; filename="aed-registry.json"'});res.end(JSON.stringify(all.map(record=>{const item=toWarsaw(record);item.registry.responsibility=datasetResponsibility;return item;})));return;}
  if(format==='csv'){
    const keys=['registry_id','source','lat','lon',...Object.keys(publicProperties(all[0]||{})),'source_updated_at','imported_at','checked_at','last_verified_at','review','responsibility','provenance'];
    const csvRows=all.map(record=>{const feature=toFeature(record);return {...publicProperties(record),registry_id:record.registry_id,source:record.source_label,lat:record.lat,lon:record.lon,source_updated_at:record.provenance?.[0]?.source_updated_at||null,imported_at:record.provenance?.[0]?.imported_at||null,checked_at:record.provenance?.[0]?.checked_at||null,last_verified_at:feature.verification.last_verified_at,review:feature.review,responsibility:datasetResponsibility,provenance:feature.provenance};});
    const cell=value=>{let text=typeof value==='object'?JSON.stringify(value):String(value??'');if(typeof value==='string'&&/^[=+@\-\t\r]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"'};
    const csv=keys.join(',')+'\r\n'+csvRows.map(record=>keys.map(key=>cell(record[key])).join(',')).join('\r\n');
    res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'no-store','Content-Disposition':'attachment; filename="aed-registry.csv"'});res.end('\ufeff'+csv);return;
  }
  res.writeHead(400);res.end('Unknown format');return;
}
if(url.pathname==='/api/geocode' && req.method==='GET'){const query=(url.searchParams.get('q')||'').trim().replace(/\s+/g,' ');if(query.length<2||query.length>160){res.writeHead(400);res.end('Invalid address');return}async function lookup(value){const target=new URL('https://services.gugik.gov.pl/uug/');target.search=new URLSearchParams({request:'GetAddress',srid:'4326',address:value});const response=await fetch(target,{signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error('Geocoder unavailable');const data=await response.json();const items=Object.values(data.results||{}).filter(x=>Number.isFinite(Number(x.x))&&Number.isFinite(Number(x.y))&&Number(x.x)>=14&&Number(x.x)<=25&&Number(x.y)>=49&&Number(x.y)<=55).map(x=>({lat:Number(x.y),lon:Number(x.x),label:[x.city,x.street,x.number,x.voivodeship].filter(Boolean).join(', '),type:data.type||'unknown'}));return items.slice(0,8)}const alternatives=[query];if(!query.includes(',')){const i=query.indexOf(' ');if(i>0)alternatives.push(query.slice(0,i)+', '+query.slice(i+1))}let results=[];for(const a of alternatives){results=await lookup(a);if(results.length)break}let approximate=false;if(!results.length&&/\s+\d+[\w/-]*\s*$/.test(query)){approximate=true;for(const a of alternatives){results=await lookup(a.replace(/\s+\d+[\w/-]*\s*$/,''));if(results.length)break}}res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({results,approximate,source:'GUGiK UUG'}));return}
if(url.pathname==='/api/proposal-photo'&&req.method==='GET'){
  const id=url.searchParams.get('id');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id||'')){res.writeHead(404);res.end();return}
  const state=await moderationStore.read(),item=state.proposals.find(row=>row.id===id);
  if(!item?.photo){res.writeHead(404);res.end();return}
  if(!await adminAuth.authenticated(req)){
    if(item.status!=='approved'||!(await loadContext()).visible.some(record=>(record.source_ids||[record.id]).includes('community/'+id))){res.writeHead(404,{'Cache-Control':'no-store'});res.end();return}
  }
  const bytes=await fs.readFile(path.join(moderationStore.photoDirectory,id+'.image'));
  res.writeHead(200,{'Content-Type':item.photo.type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'});res.end(bytes);return;
}
if(url.pathname==='/api/photo'&&req.method==='GET'){
  const photo=await warsawPhotos.get(url.searchParams.get('id'));
  res.writeHead(200,{'Content-Type':photo.type,'Cache-Control':'public, max-age=86400','X-Content-Type-Options':'nosniff'});res.end(photo.bytes);return;
}
if(url.pathname==='/api/admin/points'&&req.method==='GET'){
  await adminAuth.require(req);const context=await loadContext(),area=await areas.selected(url);
  const points=context.visible.filter(record=>inArea(area,record)).map(({lat,lon,name,hours,registry_id,device_operational_status})=>({lat,lon,name,hours,registry_id,device_operational_status}));
  jsonResponse(res,{points,area:area?publicArea(area):null,source:'Rejestr AED · źródła i zatwierdzone zgłoszenia',review_revision:context.reviews.revision,moderation_revision:registryRevision(context)});return;
}
if(url.pathname==='/api/nearby'){
  const lat=Number(url.searchParams.get('lat')),lon=Number(url.searchParams.get('lon'));
  if(!url.searchParams.has('lat')||!url.searchParams.has('lon')||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180){jsonResponse(res,{error:'Invalid coordinates'},400);return}
  const context=await loadContext();
  const points=context.visible.filter(record=>!['out_of_service','decommissioned'].includes(record.device_operational_status)).map(record=>({...record,distance:metres({lat,lon},record)/1000})).filter(record=>record.distance<=10).sort((a,b)=>a.distance-b.distance).slice(0,12).map(({raw,source_records,...record})=>{
    const community=record.photoUrl||source_records?.find(source=>source.photoUrl)?.photoUrl;
    const warsaw=record.source==='warsaw'?record:source_records?.find(source=>source.source==='warsaw');
    const commons=record.photoCommons||source_records?.find(source=>source.photoCommons)?.photoCommons;
    return {...record,...(community?{photoUrl:community}:{}),...(warsaw?{photoWarsawId:warsaw.source_record_id}:{}),...(commons?{photoCommons:commons}:{}),id:record.source_record_id};
  });
  jsonResponse(res,{points,source:'registry',review_revision:context.reviews.revision,moderation_revision:registryRevision(context)});return;
}
const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname).replace(/^\/+/,''),file=path.resolve(root,relative);if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}if(file===path.join(root,'admin.html')){res.writeHead(302,{'Cache-Control':'no-store',Location:'/admin/map'+url.search});res.end();return}const bytes=await fs.readFile(file);res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(bytes)}catch(err){if(err.status){jsonResponse(res,{error:err.message},err.status);return}res.writeHead(err.code==='ENOENT'?404:502,{'Content-Type':'text/plain; charset=utf-8'});res.end('Dane tymczasowo niedostępne')}}).listen(port,'127.0.0.1',function(){console.log(`Blisko AED: http://localhost:${this.address().port}`);if(process.env.AED_DISABLE_SYNC!=='1')sourceSync.start()});
