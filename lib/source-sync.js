'use strict';
const https=require('node:https'),dns=require('node:dns/promises'),net=require('node:net'),fs=require('node:fs/promises'),path=require('node:path');
const {readUpload,mappingFor}=require('./import-reader');
const fail=message=>Object.assign(Error(message),{status:502});
function publicAddress(address){
 if(net.isIPv4(address)){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0))||(a===198&&(b===18||b===19)));}
 const value=address.toLowerCase();if(value.startsWith('::ffff:'))return publicAddress(value.slice(7));return value!=='::'&&value!=='::1'&&!/^(fc|fd|fe[89ab]|ff)/.test(value);
}
async function download(url,options={},redirects=0){
 const target=new URL(url);if(target.protocol!=='https:'||target.username||target.password||redirects>3)throw fail('Źródło musi być publicznym adresem HTTPS.');
 let addresses;try{addresses=await dns.lookup(target.hostname,{all:true});}catch{throw fail('Nie znaleziono publicznego serwera źródła.');}if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw fail('Źródło musi wskazywać publiczny serwer.');
 const address=addresses.find(item=>item.family===4)||addresses[0];
 return new Promise((resolve,reject)=>{
  let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const request=https.request(target,{method:options.method||'GET',headers:options.headers||{},lookup:(_hostname,_options,callback)=>_options.all?callback(null,[address]):callback(null,address.address,address.family)},response=>{
   if([301,302,303,307,308].includes(response.statusCode)&&response.headers.location){response.resume();const next=new URL(response.headers.location,target),headers={...options.headers};if(next.origin!==target.origin)delete headers.Authorization;download(next,{...options,headers,method:response.statusCode===303?'GET':options.method},redirects+1).then(value=>finish(null,value),finish);return;}
   if(response.statusCode!==200){response.resume();finish(fail('Źródło zwróciło HTTP '+response.statusCode+'.'));return;}
   const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>15000000){request.destroy();finish(fail('Źródło przekracza limit 15 MB.'));}else chunks.push(chunk);});response.on('end',()=>finish(null,Buffer.concat(chunks)));response.on('error',()=>finish(fail('Przerwano pobieranie danych ze źródła.')));
  });
  const timer=setTimeout(()=>{request.destroy();finish(fail('Przekroczono czas pobierania danych ze źródła.'));},60000);
  request.on('error',()=>finish(fail('Nie udało się połączyć ze źródłem danych.')));if(options.body)request.write(options.body);request.end();
 });
}
class SourceSync{
 constructor(store,areas,root){this.store=store;this.areas=areas;this.root=root;this.pending=new Map();this.running=false;}
 sync(id){
  if(this.pending.has(id))return this.pending.get(id);
  const task=this.perform(id).catch(async error=>{await this.store.syncError(id,error.message);throw error;}).finally(()=>this.pending.delete(id));this.pending.set(id,task);return task;
 }
 async perform(id){
  const source=(await this.store.read()).sources[id];if(!source||source.mode!=='api')throw Object.assign(Error('Wybierz źródło typu URL / API.'),{status:400});
  const headers={Accept:'application/json, application/geo+json, text/csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Accept-Encoding':'identity','User-Agent':'BliskoAED/1.0'};
  if(source.secretRef==='WARSAW_API_TOKEN'&&new URL(source.url).hostname==='dane.um.warszawa.pl'){
   let token=process.env.WARSAW_API_TOKEN;if(!token){try{const env=await fs.readFile(path.join(this.root,'.env'),'utf8');token=env.match(/^WARSAW_API_TOKEN=(.*)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g,'');}catch{}}
   if(!token)throw fail('Brak tokenu do miejskiego źródła danych.');headers.Authorization=token;
  }
  const bytes=await download(source.url,{method:source.method||'GET',headers});
  const filename='source-'+source.id+'.'+source.format,table=await readUpload({filename,content:bytes.toString('base64')});
  const area=source.terc?await this.areas.selected(new URL('/?city='+source.terc,'http://localhost')):null;
  const directory=path.join(this.store.directory,'uploads'),uploadId=require('node:crypto').randomUUID();await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,uploadId+'.upload'),bytes,{flag:'wx'});
  const result=await this.store.prepare({sourceId:id,rows:table.rows,filename,mapping:source.mapping||(['warsaw','osm'].includes(source.id)?{}:mappingFor(table.rows).mapping),area,origin:'automatic',archive:{uploadId,sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')}});
  if(!result.valid)throw fail('Źródło zawiera błędne rekordy: '+result.errors.slice(0,3).map(error=>'wiersz '+error.row+': '+error.message).join('; '));return result;
 }
 start(){
  const tick=async()=>{if(this.running)return;this.running=true;try{const state=await this.store.read();for(const source of Object.values(state.sources)){if(source.daily&&source.mode==='api'&&(!source.nextCheckAt||Date.parse(source.nextCheckAt)<=Date.now())){try{await this.sync(source.id);}catch{}}}}finally{this.running=false;}};
  this.timer=setInterval(tick,60000);this.timer.unref();this.initial=setTimeout(tick,15000);this.initial.unref();
 }
}
module.exports={SourceSync,download};
