'use strict';
const {registryId}=require('./record-id');
const {normalizeRecord}=require('./data-model');
const WARSAW={id:'warsaw',namespace:'pl.warszawa.scb.aed',publisher:'Urząd m.st. Warszawy',terc:'1465011',area_name:'Warszawa',catalogue_url:'https://dane.um.warszawa.pl/pl/catalogue/7bc32ffc-c2ac-4d32-83c9-b6f7a0b38de8',license:{name:'Creative Commons Attribution',url:null}};
const OSM={id:'osm',namespace:'osm.pl.aed',publisher:'OpenStreetMap',catalogue_url:'https://aed.openstreetmap.org.pl/',license:{name:'ODbL 1.0',url:'https://www.openstreetmap.org/copyright'}};
function warsawRecord(row,meta){return normalizeRecord(row,WARSAW,meta);}
function osmRecord(row,meta){return normalizeRecord(row,OSM,meta);}
function records(warsaw,osm,meta={}){
  const rows=[];
  for(const row of warsaw){try{rows.push(warsawRecord(row,meta.warsaw));}catch{}}
  for(const row of osm){if(row.geometry?.type!=='Point')continue;try{rows.push(osmRecord(row,meta.osm));}catch{}}
  const unique=new Map(rows.map(row=>[row.id,row]));return [...unique.values()];
}
module.exports={registryId,warsawRecord,osmRecord,records,WARSAW,OSM};
