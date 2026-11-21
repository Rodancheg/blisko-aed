'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function ringPosition([x,y], ring) {
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [ax,ay]=ring[j],[bx,by]=ring[i];
    if(Math.abs((x-ax)*(by-ay)-(y-ay)*(bx-ax))<=1e-12&&Math.min(ax,bx)<=x&&x<=Math.max(ax,bx)&&Math.min(ay,by)<=y&&y<=Math.max(ay,by))return 2;
    if((ay>y)!==(by>y)&&x<ax+(y-ay)*(bx-ax)/(by-ay))inside=!inside;
  }
  return Number(inside);
}
function contains(area, record) {
  if(!area)return true;
  const {lat,lon}=record,{south,north,west,east}=area.extent;
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<south||lat>north||lon<west||lon>east)return false;
  const polygons=area.geometry.type==='Polygon'?[area.geometry.coordinates]:area.geometry.coordinates;
  return polygons.some(rings=>{
    const outer=ringPosition([lon,lat],rings[0]);
    if(outer===2)return true;if(!outer)return false;
    const holes=rings.slice(1).map(ring=>ringPosition([lon,lat],ring));
    return holes.includes(2)||!holes.includes(1);
  });
}
class Areas {
  constructor(directory){this.directory=directory;this.cached=[];this.loaded=0;this.loading=null;this.byId=new Map();this.boundaries=new Map();}
  async list(){
    if(this.loaded&&Date.now()-this.loaded<15000)return this.cached;
    if(this.loading)return this.loading;
    this.loading=this.read().finally(()=>{this.loading=null;});return this.loading;
  }
  async read(){
    let entries;try{entries=await fs.readdir(this.directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
    const results=await Promise.allSettled(entries.filter(entry=>entry.isDirectory()&&/^\d{7}$/.test(entry.name)).map(async entry=>{
      const dir=path.join(this.directory,entry.name);
      const stamp=(await fs.stat(path.join(dir,'manifest.json'))).mtimeMs;
      const cached=this.byId.get(entry.name);if(cached?.stamp===stamp)return cached;
      const [manifest,boundary]=await Promise.all(['manifest.json','boundary.geojson'].map(async name=>JSON.parse(await fs.readFile(path.join(dir,name),'utf8'))));
      if(manifest.status!=='complete'||manifest.terc!==entry.name||!['Polygon','MultiPolygon'].includes(boundary.geometry?.type))return null;
      const geometry=boundary.geometry,polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
      const vertices=polygons.flatMap(rings=>rings[0]);
      const extent=vertices.reduce((box,[x,y])=>({west:Math.min(box.west,x),east:Math.max(box.east,x),south:Math.min(box.south,y),north:Math.max(box.north,y)}),{west:Infinity,east:-Infinity,south:Infinity,north:-Infinity});
      const area={id:entry.name,name:manifest.name,kind:entry.name.endsWith('1')?'city':entry.name.endsWith('3')?'urban_rural':'rural',rawCount:manifest.records,completedAt:manifest.completed_at,extent,bounds:[[extent.south,extent.west],[extent.north,extent.east]],stamp};
      this.byId.set(entry.name,area);this.boundaries.delete(entry.name);return area;
    }));
    this.cached=results.filter(result=>result.status==='fulfilled'&&result.value).map(result=>result.value).sort((a,b)=>a.name.localeCompare(b.name,'pl')||a.id.localeCompare(b.id));
    this.loaded=Date.now();return this.cached;
  }
  async selected(url){
    const code=url.searchParams.get('city');if(!code)return null;
    if(!/^\d{7}$/.test(code))throw Object.assign(Error('Wybierz miasto lub gminę z listy.'),{status:400});
    const area=(await this.list()).find(area=>area.id===code);
    if(!area)throw Object.assign(Error('Dane tego obszaru nie są jeszcze gotowe.'),{status:404});
    let geometry=this.boundaries.get(code);
    if(!geometry){geometry=JSON.parse(await fs.readFile(path.join(this.directory,code,'boundary.geojson'),'utf8')).geometry;if(this.boundaries.size>=3)this.boundaries.delete(this.boundaries.keys().next().value);this.boundaries.set(code,geometry);}
    return {...area,geometry};
  }
}
function publicArea({geometry,stamp,...area}){return area;}
function filterModeration(state,area){
  if(!area)return state;
  return {...state,proposals:state.proposals.filter(item=>contains(area,item.decision?.fields||item.fields)),reports:state.reports.filter(item=>contains(area,item.current||item.snapshot||{})||contains(area,item.snapshot||{}))};
}
function importFields(row){
  const properties=row?.properties||row||{},geometry=row?.geometry;
  if(geometry&&geometry.type!=='Point')throw Object.assign(Error('Import obsługuje wyłącznie punkty AED (Point).'),{status:400});
  let coordinates=geometry?.coordinates;if(Array.isArray(coordinates?.[0]))coordinates=coordinates[0];
  return {name:properties.location_object_name||properties.name||properties.operator||'Defibrylator AED',address:properties.address||[properties.location_street||properties['addr:street'],properties.location_building||properties['addr:housenumber'],properties.location_postcode||properties['addr:postcode']].filter(Boolean).join(' '),city:properties.location_city||properties.city||properties['addr:city']||'',lat:coordinates?.[1]??properties.lat,lon:coordinates?.[0]??properties.lon,hours:properties.device_access_description||properties.hours||properties.opening_hours||'',access:properties.device_public_access||properties.access||'',description:properties.location_description||properties['defibrillator:location:pl']||properties['defibrillator:location']||properties.description||'',device_operational_status:'unknown'};
}
module.exports={Areas,contains,publicArea,filterModeration,importFields};
