'use strict';
const {registryId}=require('./record-id');
const xml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const tag=(name,value)=>'<'+name+'>'+xml(value)+'</'+name+'>';
const polish=(name,value)=>'<'+name+'>'+tag('polish',value)+'</'+name+'>';
function buildHarvester({baseUrl,areas,publisher,updatedAt=null,draft=false}){
 if(!draft&&!publisher)throw Object.assign(Error('Odpowiedzialny dostawca zbioru nie został wyznaczony.'),{status:400});
 const root=new URL(baseUrl);if(root.protocol!=='https:'||root.username||root.password||root.pathname!=='/'||root.search||root.hash)throw Object.assign(Error('Podaj główny adres HTTPS aplikacji, bez ścieżki i parametrów.'),{status:400});
 const origin=root.origin,all=[{id:'polska',name:'Polska'},...areas];
 const datasets=all.map(area=>{
  const suffix=area.id==='polska'?'':'&city='+area.id,title='Defibrylatory AED — '+area.name;
  const description='Otwarty rejestr lokalizacji AED. Odpowiedzialny dostawca zestawienia: '+(publisher||'nie wyznaczono')+'. '+(draft?'Podgląd roboczy; nie oznacza publikacji w dane.gov.pl. ':'')+'Zakres: '+area.name+'. Pochodzenie i warunki wykorzystania poszczególnych rekordów podano w provenance. Zatwierdzenie przez administratora jest decyzją o publikacji w aplikacji, nie weryfikacją terenową ani potwierdzeniem przez dostawcę. Brak wpisu nie potwierdza braku AED; pobranie danych nie potwierdza aktualnej sprawności ani dostępu.';
  const resources=[['json','JSON Warszawa'],['geojson','GeoJSON'],['csv','CSV']].map(([format,label])=>'<resource status="'+(draft?'draft':'published')+'">'+tag('extIdent',registryId('pl.blisko.resource',area.id+'/'+format))+tag('url',origin+'/api/export?format='+format+suffix)+polish('title',title+' — '+label)+polish('description',description)+tag('availability','remote')+(updatedAt?tag('lastUpdateDate',updatedAt):'')+tag('isAutoDataDate','false')+(area.id==='polska'?'':'<regions>'+tag('terytIdent',area.id)+'</regions>')+'</resource>').join('');
  return '<dataset status="'+(draft?'draft':'published')+'">'+tag('extIdent',registryId('pl.blisko.dataset',area.id))+polish('title',title)+polish('description',description)+tag('url',origin+'/datasets.html'+(area.id==='polska'?'':'?city='+area.id))+tag('updateFrequency','irregular')+'<categories><category>HEAL</category></categories><conditions><source>true</source><dbOrCopyrighted>Warunki i oznaczenie źródła są zapisane w polu provenance każdego rekordu. Aktualizacje źródeł są sprawdzane codziennie; publikacja następuje po decyzji administratora.</dbOrCopyrighted></conditions><resources>'+resources+'</resources><tags><tag lang="pl">AED</tag><tag lang="pl">defibrylatory</tag><tag lang="pl">'+xml(area.name)+'</tag></tags>'+(updatedAt?tag('lastUpdateDate',updatedAt):'')+'</dataset>';
 }).join('');
 return '<?xml version="1.0" encoding="UTF-8"?>\n<p:datasets xmlns:p="urn:otwarte-dane:harvester:1.13" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:otwarte-dane:harvester:1.13 https://dane.gov.pl/static/xml/otwarte_dane_latest.xsd">'+datasets+'</p:datasets>\n';
}
module.exports={buildHarvester};
