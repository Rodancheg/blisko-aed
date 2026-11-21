const message=document.getElementById('mapMessage'),count=document.getElementById('visibleCount'),radius=document.getElementById('radius'),form=document.getElementById('aedForm'),panel=document.getElementById('addPanel');
let points=[],layers=null,chosen=null,mask=null,loaded=false,focusLayer=null,lastCoverageArea=null,pointsRequest=0;
if(window.L){
  map=L.map('adminMap',{preferCanvas:true}).setView([52.1,19.4],6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
  const pane=map.createPane('blindZones');pane.style.zIndex=350;pane.style.pointerEvents='none';
  mask=L.DomUtil.create('canvas','blind-mask',pane);layers=L.layerGroup().addTo(map);
  map.on('moveend resize',draw);
  map.on('click',event=>{
    if(panel.hidden)return;
    document.getElementById('draftLat').value=event.latlng.lat.toFixed(6);document.getElementById('draftLon').value=event.latlng.lng.toFixed(6);
    if(chosen)map.removeLayer(chosen);chosen=L.marker(event.latlng).addTo(map).bindPopup('Nowa propozycja').openPopup();
  });
}else message.textContent='Nie udało się załadować mapy.';

function drawMarkers(visible){
  const zoom=map.getZoom(),spacing=zoom<=7?140:zoom<=10?110:zoom<=12?90:zoom<=14?70:48;
  const groups=[],grid=new Map();
  // Keep representative markers apart, including across neighboring grid cells.
  // Anchoring each group to a real AED avoids shifting markers into each other.
  for(const point of [...visible].sort((a,b)=>String(a.registry_id).localeCompare(String(b.registry_id)))){
    const screen=map.project([point.lat,point.lon],zoom),x=Math.floor(screen.x/spacing),y=Math.floor(screen.y/spacing);
    let nearest=null,minimum=spacing*spacing;
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
      for(const group of grid.get((x+dx)+':'+(y+dy))||[]){
        const distance=(screen.x-group.screen.x)**2+(screen.y-group.screen.y)**2;
        if(distance<minimum){minimum=distance;nearest=group;}
      }
    }
    if(nearest){nearest.points.push(point);continue;}
    const group={anchor:point,screen,points:[point]},key=x+':'+y;
    groups.push(group);if(!grid.has(key))grid.set(key,[]);grid.get(key).push(group);
  }
  for(const {anchor,points:group} of groups){
    if(group.length===1){
      const point=group[0];L.circleMarker([point.lat,point.lon],{radius:5,color:'#fff',weight:1.5,fillColor:'#155443',fillOpacity:1}).bindPopup(escapeText(point.name)).addTo(layers);continue;
    }
    const bounds=L.latLngBounds(group.map(point=>[point.lat,point.lon]));
    const marker=L.marker([anchor.lat,anchor.lon],{icon:L.divIcon({className:'aed-cluster',html:'<span>'+group.length+'</span>',iconSize:[36,36],iconAnchor:[18,18]}),title:group.length+' AED — kliknij, aby przybliżyć',alt:'Grupa '+group.length+' AED'}).addTo(layers);
    marker.on('click',()=>{
      if(map.getZoom()>=19){marker.bindPopup('<strong>'+group.length+' AED</strong><br>'+group.slice(0,8).map(point=>escapeText(point.name)).join('<br>')).openPopup();return;}
      map.fitBounds(bounds,{padding:[45,45],maxZoom:Math.min(19,map.getZoom()+3)});
    });
  }
}
function draw(){
  if(!map||!layers)return;
  layers.clearLayers();const size=map.getSize();mask.width=size.x;mask.height=size.y;
  L.DomUtil.setPosition(mask,map.containerPointToLayerPoint([0,0]));
  const ctx=mask.getContext('2d'),maxRadius=Number(radius.value),half=maxRadius/2;
  document.getElementById('legendGreen').textContent=`0–${half} m`;document.getElementById('legendYellow').textContent=`${half}–${maxRadius} m`;document.getElementById('legendRed').textContent=`ponad ${maxRadius} m`;
  if(!loaded){count.textContent='—';message.textContent='Ładowanie danych…';return;}
  const timeValue=document.getElementById('coverageTime').value,now=new Date();
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Warsaw',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const hour=Number(parts.find(part=>part.type==='hour').value),minute=Number(parts.find(part=>part.type==='minute').value);
  const when=timeValue==='all'?null:new Date(now.getTime()+(Number(timeValue)*60-hour*60-minute)*60000);
  const usable=points.filter(point=>!['out_of_service','decommissioned'].includes(point.device_operational_status));
  const coverage=when?usable.filter(point=>aedAvailability(point.hours,when)==='open'):usable;
  const current=map.getBounds(),latPad=maxRadius/110000,lonPad=latPad/Math.cos(map.getCenter().lat*Math.PI/180);
  const box=L.latLngBounds([current.getSouth()-latPad,current.getWest()-lonPad],[current.getNorth()+latPad,current.getEast()+lonPad]);
  const visible=coverage.filter(point=>Number.isFinite(point.lat)&&Number.isFinite(point.lon)&&box.contains([point.lat,point.lon]));
  const inView=visible.filter(point=>current.contains([point.lat,point.lon]));
  count.textContent=inView.length.toLocaleString('pl-PL');
  message.textContent=!points.length?'Brak AED w danych dla wybranego obszaru.':when?'Pokrycie: tylko punkty o znanych godzinach; widoczne AED: '+inView.length:'Widoczne AED: '+inView.length+'. Kliknij grupę z liczbą, aby przybliżyć.';
  // Markers remain visible at every zoom. The coverage mask needs street/city scale.
  if(map.getZoom()>=11){
    const circles=visible.map(point=>{
      const center=map.latLngToContainerPoint([point.lat,point.lon]),edge=map.latLngToContainerPoint([point.lat+maxRadius/111320,point.lon]);
      return {center,pixels:Math.abs(center.y-edge.y)};
    });
    function paths(context,factor){context.beginPath();for(const item of circles){context.moveTo(item.center.x+item.pixels*factor,item.center.y);context.arc(item.center.x,item.center.y,item.pixels*factor,0,Math.PI*2);}context.fill();}
    ctx.fillStyle='rgba(211,57,47,.48)';ctx.fillRect(0,0,size.x,size.y);ctx.globalCompositeOperation='destination-out';paths(ctx,1);ctx.globalCompositeOperation='source-over';
    const layer=document.createElement('canvas');layer.width=size.x;layer.height=size.y;const paint=layer.getContext('2d');
    paint.fillStyle='#eab11f';paths(paint,1);paint.globalCompositeOperation='destination-out';paths(paint,.5);paint.globalCompositeOperation='source-over';ctx.globalAlpha=.55;ctx.drawImage(layer,0,0);
    paint.clearRect(0,0,size.x,size.y);paint.fillStyle='#25a260';paths(paint,.5);ctx.globalAlpha=.48;ctx.drawImage(layer,0,0);ctx.globalAlpha=1;
  }
  drawMarkers(inView);
}
radius.addEventListener('change',draw);document.getElementById('coverageTime').addEventListener('change',draw);

async function loadPoints(){
  const request=++pointsRequest,city=window.aedSelectedCity;
  try{
    const data=await window.aedAdminRequest(window.aedWithCity('/api/admin/points'));
    if(request!==pointsRequest||city!==window.aedSelectedCity)return;
    points=data.points;loaded=true;window.aedCurrentArea=data.area;
    document.getElementById('coverageAreaName').textContent='Pokrycie AED · '+(data.area?.name||'Polska');document.getElementById('selectedAreaLabel').textContent=data.area?.name||'Wszystkie obszary';
    const areaKey=data.area?.id||'';
    if(map&&lastCoverageArea!==areaKey){
      map.invalidateSize();if(focusLayer){map.removeLayer(focusLayer);focusLayer=null;}
      const coordinates=points.filter(point=>Number.isFinite(point.lat)&&Number.isFinite(point.lon)).map(point=>[point.lat,point.lon]);
      if(coordinates.length)map.fitBounds(L.latLngBounds(coordinates),{padding:[40,40],maxZoom:coordinates.length<=3?16:17});
      else if(data.area)map.fitBounds(data.area.bounds,{padding:[28,28],maxZoom:15});
      else map.setView([52.1,19.4],6);
      lastCoverageArea=areaKey;
    }
    if(!window.aedMapFocusApplied){
      window.aedMapFocusApplied=true;const params=new URLSearchParams(location.search),focus=[];
      for(const suffix of ['', '2']){const lat=Number(params.get('lat'+suffix)),lon=Number(params.get('lon'+suffix));if(params.has('lat'+suffix)&&params.has('lon'+suffix)&&lat>=49&&lat<=55&&lon>=14&&lon<=25)focus.push([lat,lon]);}
      if(map&&focus.length){focusLayer=L.layerGroup().addTo(map);focus.forEach((coords,index)=>L.circleMarker(coords,{radius:11,color:'#fff',weight:2,fillColor:index?'#b55624':'#155443',fillOpacity:1}).addTo(focusLayer));if(focus.length===1)map.setView(focus[0],18);else map.fitBounds(focus,{padding:[55,55],maxZoom:19});}
    }
    draw();
  }catch(error){if(request!==pointsRequest)return;message.textContent=error.message||'Nie udało się pobrać rejestru AED.';count.textContent='—';}
}
function showProposal(event){
  event?.preventDefault();const area=window.aedGetSelectedArea?.();if(area?.kind==='city'&&!form.elements.city.value)form.elements.city.value=area.name;
  panel.hidden=false;panel.scrollIntoView({behavior:'smooth'});message.textContent='Kliknij mapę, aby wskazać lokalizację.';
}
document.getElementById('addButton').onclick=showProposal;
document.getElementById('closeForm').onclick=()=>{panel.hidden=true;if(chosen){map.removeLayer(chosen);chosen=null;}};
form.addEventListener('submit',async event=>{
  event.preventDefault();const status=document.getElementById('formStatus'),button=form.querySelector('[type=submit]');button.disabled=true;status.textContent='Zapisujemy…';
  try{
    await window.aedAdminRequest('/api/admin/drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    form.reset();if(chosen){map.removeLayer(chosen);chosen=null;}status.textContent='Propozycja zapisana. Oczekuje na zatwierdzenie administratora; nie zmienia jeszcze rejestru.';
    window.dispatchEvent(new CustomEvent('city-changed'));
  }catch(error){status.textContent=error.message||'Nie udało się zapisać propozycji.';}finally{button.disabled=false;}
});
if(new URLSearchParams(location.search).get('add')==='1')showProposal();
