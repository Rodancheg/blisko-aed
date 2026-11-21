'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
const {WARSAW_FIELDS}=require('./data-model');
function readUpload(input){return new Promise((resolve,reject)=>{
 if(typeof input.filename!=='string'||typeof input.content!=='string'||input.content.length>20000100){reject(Object.assign(Error('Nieprawidłowy plik lub rozmiar powyżej 15 MB.'),{status:400}));return;}
 const child=spawn(process.env.AED_PYTHON||'/usr/bin/python3',[path.join(__dirname,'..','tools','read_import.py')],{stdio:['pipe','pipe','pipe']});let output='',errorText='',finished=false;
 const timer=setTimeout(()=>{child.kill();reject(Object.assign(Error('Odczyt pliku trwał zbyt długo.'),{status:400}));},30000);
 child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>55000000){child.kill();}});child.stderr.on('data',chunk=>{errorText+=chunk;});
 child.on('error',error=>{clearTimeout(timer);reject(error);});child.stdin.on('error',()=>{});
 child.on('close',code=>{clearTimeout(timer);if(finished)return;finished=true;let result;try{result=JSON.parse(output);}catch{reject(Object.assign(Error('Nie udało się odczytać pliku.'),{status:400}));return;}if(code||result.error){reject(Object.assign(Error(result.error||'Nie udało się odczytać pliku.'),{status:400}));return;}resolve(result);});
 child.stdin.end(JSON.stringify({filename:input.filename,content:input.content,sheet:input.sheet}));
});}
function columnPaths(value,prefix='',result=[]){if(!value||typeof value!=='object')return result;for(const [key,item]of Object.entries(value)){const column=prefix?prefix+'.'+key:key;if(item&&typeof item==='object'&&!Array.isArray(item))columnPaths(item,column,result);else if(Array.isArray(item)&&column==='geometry.coordinates'){result.push(column+'.0',column+'.1');if(Array.isArray(item[0]))result.push(column+'.0.0',column+'.0.1');}else if(!Array.isArray(item))result.push(column);}return result;}
const ALIASES={defibrillator_id:['defibrillator_id','source_record_id','id','nr','identyfikator'],lat:['lat','latitude','szerokosc','szerokość geograficzna'],lon:['lon','longitude','lng','dlugosc','długość geograficzna'],location_object_name:['location_object_name','name','nazwa','operator'],location_city:['location_city','city','miejscowosc','miejscowość','miasto','addr:city'],location_street:['location_street','street','ulica','addr:street'],location_building:['location_building','building','numer','addr:housenumber'],location_postcode:['location_postcode','postcode','kod pocztowy','addr:postcode'],location_description:['location_description','description','opis','defibrillator:location'],device_access_description:['device_access_description','hours','opening_hours','godziny'],device_manufacturer:['device_manufacturer','manufacturer','producent'],device_public_access:['device_public_access','access','dostep','dostęp'],device_location:['device_location','placement','lokalizacja'],address:['address','adres']};
function mappingFor(rows){const columns=[...new Set(rows.slice(0,100).flatMap(row=>columnPaths(row)))],mapping={};for(const target of [...WARSAW_FIELDS,'lat','lon','address','source_updated_at']){
 const aliases=ALIASES[target]||[target];const match=columns.find(column=>aliases.includes(column.replace(/^properties\./,'').toLocaleLowerCase('pl')));if(match)mapping[target]=match;
 }const c=rows[0]?.geometry?.coordinates;if(Array.isArray(c)){mapping.lon=Array.isArray(c[0])?'geometry.coordinates.0.0':'geometry.coordinates.0';mapping.lat=Array.isArray(c[0])?'geometry.coordinates.0.1':'geometry.coordinates.1';}
 return {columns,mapping,fields:[...WARSAW_FIELDS,'lat','lon','address','device_operational_status','source_updated_at']};}
module.exports={readUpload,mappingFor};
