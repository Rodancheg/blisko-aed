'use strict';
const {registryId}=require('./record-id');
const SCHEMA_VERSION='1.0.0';
const WARSAW_FIELDS=['defibrillator_id','device_access_description','device_availability','device_location','device_manufacturer','device_public_access','device_specifications','location_building','location_city','location_description','location_object_name','location_postcode','location_street'];
const STATES=['unknown','operational','out_of_service','decommissioned'];
const fail=message=>Object.assign(Error(message),{status:400});
const text=value=>value==null?'':String(value).trim();
const number=value=>typeof value==='number'?value:typeof value==='string'&&value.trim()?Number(value.trim().replace(',','.')):NaN;
function sourceIdentity(row,source){
  const p=row?.properties||row||{};
  if(source.id==='osm'&&p['@osm_id']!=null)return text(p['@osm_type']||'node')+'/'+text(p['@osm_id']);
  const id=p.defibrillator_id??p.source_record_id??p.id??row?.id;
  if(!['string','number'].includes(typeof id)||!text(id)||text(id).length>200)throw fail('Brak trwałego ID rekordu. Dodaj kolumnę defibrillator_id.');
  if(typeof id==='number'&&!Number.isSafeInteger(id))throw fail('Zapisz identyfikator jako tekst, aby nie utracić cyfr.');
  return text(id);
}
function normalizeRecord(row,source,meta={}){
  if(!row||typeof row!=='object'||Array.isArray(row))throw fail('Rekord musi być obiektem.');
  const p=row.properties||row,geometry=row.geometry;
  if(!p||typeof p!=='object'||Array.isArray(p))throw fail('Nieprawidłowe properties.');
  if(geometry&&geometry.type!=='Point')throw fail('Obsługiwane są wyłącznie punkty AED (Point).');
  let c=geometry?.coordinates;if(Array.isArray(c?.[0])&&c.length===1)c=c[0];
  const lon=number(c?.[0]??p.lon??p.longitude),lat=number(c?.[1]??p.lat??p.latitude);
  if(!Number.isFinite(lon)||!Number.isFinite(lat)||lon< -180||lon>180||lat< -90||lat>90)throw fail('Podaj prawidłowe współrzędne WGS84.');
  if(meta.strictCountry&&(lat<49||lat>55||lon<14||lon>25))throw fail('Współrzędne muszą wskazywać Polskę.');
  const sourceRecordId=sourceIdentity(row,source),osm=source.id==='osm';
  const properties=Object.fromEntries(WARSAW_FIELDS.map(key=>[key,p[key]==null?null:text(p[key])]));
  const choose=(key,...values)=>{if(properties[key]==null)properties[key]=values.find(value=>value!=null&&text(value)!=='')??null;if(properties[key]!=null)properties[key]=text(properties[key]);};
  properties.defibrillator_id=sourceRecordId;
  choose('location_object_name',p.name,p.operator,'Defibrylator AED');choose('location_city',p.city,p['addr:city']);
  choose('location_street',p.street,p['addr:street']);choose('location_building',p.building,p['addr:housenumber']);choose('location_postcode',p.postcode,p['addr:postcode']);
  choose('location_description',p.description,p['defibrillator:location:pl'],p['defibrillator:location']);
  choose('device_access_description',p.hours,p.opening_hours);choose('device_manufacturer',p.manufacturer);
  choose('device_location',p.placement,osm?({'yes':'Wewnątrz budynku','no':'Na zewnątrz budynku'}[p.indoor]):null);
  choose('device_public_access',p.access);
  const state=STATES.includes(p.device_operational_status)?p.device_operational_status:'unknown';
  const originalHours=text(properties.device_access_description);
  const importedAt=meta.importedAt||null,checkedAt=meta.checkedAt||importedAt;
  const sourceProvenance=Array.isArray(row.provenance)?row.provenance:Array.isArray(row.registry?.provenance)?row.registry.provenance:[];
  const sourceUpdatedAt=meta.sourceUpdatedAt??p.source_updated_at??sourceProvenance.find(item=>item?.source_record_id===sourceRecordId)?.source_updated_at??null;
  if(sourceUpdatedAt!==null&&(typeof sourceUpdatedAt!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(sourceUpdatedAt)||!Number.isFinite(Date.parse(sourceUpdatedAt))))throw fail('Data zmiany źródła musi być zapisana w ISO 8601.');
  const result={schema_version:SCHEMA_VERSION,id:source.id+'/'+sourceRecordId,registry_id:registryId(source.namespace||source.id,sourceRecordId),source:source.id,source_label:source.publisher||source.title||source.id,source_record_id:sourceRecordId,
    lat,lon,properties,name:properties.location_object_name||'Defibrylator AED',
    address:text(p.address)||[properties.location_street,properties.location_building,properties.location_postcode,properties.location_city].filter(Boolean).join(' '),
    city:properties.location_city||'',description:properties.location_description||'',hours:originalHours,
    access:[properties.device_public_access,properties.device_availability].filter(Boolean).join(' · '),
    placement:properties.device_location||'',manufacturer:properties.device_manufacturer||'',device_operational_status:state,
    administrative_area:{country:'PL',terc:meta.terc||null,name:meta.areaName||null},reference_scope:{country:'PL',terc:source.terc||null,name:source.area_name||null},
    provenance:[{source_id:source.namespace||source.id,source_record_id:sourceRecordId,source_url:source.url||source.catalogue_url||null,source_updated_at:sourceUpdatedAt,imported_at:importedAt,checked_at:checkedAt,license:source.license||null}],
    verification:{status:'unverified',last_verified_at:null},
    raw:row};
  if(text(p.wikimedia_commons).startsWith('File:'))result.photoCommons=text(p.wikimedia_commons);
  return result;
}
function publicProperties(record){
  const p={...Object.fromEntries(WARSAW_FIELDS.map(key=>[key,null])),...record.properties};
  p.defibrillator_id=record.source_record_id;
  p.location_object_name=record.name||null;p.location_city=record.city||null;p.location_description=record.description||null;p.device_access_description=record.hours||null;
  p.device_location=record.placement||p.device_location;p.device_manufacturer=record.manufacturer||p.device_manufacturer;
  return {...p,address:record.address||null,access:record.access||null,device_operational_status:record.device_operational_status||'unknown',opening_hours:record.hours==='24/7'?'24/7':null,opening_hours_timezone:'Europe/Warsaw'};
}
function publicRaw(value){
  if(Array.isArray(value))return value.map(publicRaw);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='attachment'&&key!=='photo').map(([key,item])=>[key,publicRaw(item)]));
  return value;
}
function publicVerification(record){
  const value=record.verification;
  // Older imports used "verified" for administrator approval. Interpret
  // those snapshots without rewriting their immutable history.
  if(value?.method==='administrator_review')return {status:'unverified',last_verified_at:null};
  return value||{status:'unverified',last_verified_at:null};
}
function publicReview(record){
  if(record.review)return record.review;
  if(record.verification?.method==='administrator_review')return {status:'approved',reviewed_at:record.verification.last_verified_at,method:'administrator_review'};
  return {status:'unreviewed',reviewed_at:null};
}
function toFeature(record,{raw=false}={}){
  const members=record.source_records||[record];
  return {type:'Feature',id:record.registry_id,schema_version:SCHEMA_VERSION,geometry:{type:'Point',coordinates:[record.lon,record.lat]},properties:publicProperties(record),administrative_area:record.administrative_area||{country:'PL',terc:null,name:null},
    reference_scope:record.reference_scope||null,quality_flags:record.quality_flags||[],
    provenance:members.flatMap(member=>member.provenance||[{source_id:member.source,source_record_id:member.source_record_id,imported_at:null,checked_at:null}]),
    verification:publicVerification(record),review:publicReview(record),
    source_ids:record.source_ids||[record.id],...(raw?{source_records:members.map(member=>({id:member.id,raw:publicRaw(member.raw)}))}:{})};
}
function toWarsaw(record){return {geometry:{type:'Point',coordinates:[[record.lon,record.lat]]},properties:publicProperties(record),registry:{id:record.registry_id,schema_version:SCHEMA_VERSION,administrative_area:record.administrative_area||null,reference_scope:record.reference_scope||null,quality_flags:record.quality_flags||[],provenance:toFeature(record).provenance,verification:publicVerification(record),review:publicReview(record)}};}
module.exports={SCHEMA_VERSION,WARSAW_FIELDS,STATES,normalizeRecord,sourceIdentity,publicProperties,publicRaw,publicVerification,publicReview,toFeature,toWarsaw};
