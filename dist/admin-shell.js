(() => {
  const request=window.aedAdminRequest,esc=escapeText;
  const drawer=document.getElementById('adminDrawer'),toggle=document.getElementById('menuToggle'),backdrop=document.getElementById('menuBackdrop'),main=document.querySelector('main');
  const desktop=matchMedia('(min-width:1100px)'),cityFilter=document.getElementById('cityFilter'),citySearch=document.getElementById('citySearch');
  const kindLabel={city:'Miasto',rural:'Gmina wiejska',urban_rural:'Gmina miejsko-wiejska'};
  let current=document.body.dataset.adminSection||'coverage',available=[],menuOpen=false,data=null,loadingData=false;
  const normalize=value=>String(value).toLocaleLowerCase('pl').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ł/g,'l');
  function setMenu(open){menuOpen=open;document.body.classList.toggle('menu-open',open);toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'Zamknij menu panelu':'Otwórz menu panelu');drawer.setAttribute('aria-hidden',String(!open));drawer.inert=!open;backdrop.hidden=!open||desktop.matches;main.inert=open&&!desktop.matches;}
  toggle.onclick=()=>setMenu(!menuOpen);backdrop.onclick=()=>{setMenu(false);toggle.focus();};desktop.addEventListener('change',event=>setMenu(event.matches));document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menuOpen){setMenu(false);toggle.focus();}});setMenu(desktop.matches);
  window.aedGetSelectedArea=()=>available.find(area=>area.id===window.aedSelectedCity)||null;
  function saveLocation(clearFocus=false){const url=new URL(location.href);if(clearFocus)for(const key of ['lat','lon','lat2','lon2'])url.searchParams.delete(key);if(window.aedSelectedCity)url.searchParams.set('city',window.aedSelectedCity);else url.searchParams.delete('city');url.hash='';history.replaceState(null,'',url.pathname+url.search+url.hash);}
  function updateDownloads(){
    document.querySelectorAll('[data-section]').forEach(link=>link.href=window.aedAdminHref(link.dataset.section));
    const addURL=new URL(window.aedAdminHref('coverage'),location.origin);addURL.searchParams.set('add','1');document.getElementById('addButton').href=addURL.pathname+addURL.search;
    if(current==='data'){document.getElementById('publicDatasetLink').href=window.aedWithCity('/datasets.html');document.getElementById('dataWarsaw').href=window.aedWithCity('/api/export?format=json');document.getElementById('dataCsv').href=window.aedWithCity('/api/export?format=csv');document.getElementById('dataGeojson').href=window.aedWithCity('/api/export?format=geojson');}
  }
  function selectCity(id){
    if(id&&!available.some(area=>area.id===id))return;
    window.aedSelectedCity=id;cityFilter.value=id;saveLocation(true);updateDownloads();
    const area=window.aedGetSelectedArea();document.getElementById('citySummary').textContent=area?`${area.name} · ${kindLabel[area.kind]} · TERC ${area.id}`:`${available.length} gotowych obszarów · filtr obejmuje wszystkie sekcje`;
    window.dispatchEvent(new CustomEvent('city-changed',{detail:{area}}));
    if(current==='coverage')loadPoints();if(current==='data')loadData();
  }
  function renderCities(){
    const search=normalize(citySearch.value),selected=window.aedSelectedCity;
    cityFilter.innerHTML='<option value="">Wszystkie obszary</option>';
    const names=new Map();available.forEach(area=>names.set(area.name,(names.get(area.name)||0)+1));
    for(const [kind,title] of [['city','Miasta'],['other','Pozostałe gminy']]){
      const group=document.createElement('optgroup');group.label=title;
      available.filter(area=>(kind==='city'?area.kind==='city':area.kind!=='city')&&(!search||normalize(area.name+' '+area.id).includes(search)||area.id===selected)).forEach(area=>{
        const option=document.createElement('option');option.value=area.id;option.textContent=area.name+(names.get(area.name)>1?' · '+kindLabel[area.kind]+' · '+area.id:'');group.appendChild(option);
      });if(group.children.length)cityFilter.appendChild(group);
    }
    cityFilter.value=selected;
  }
  async function loadCities(){
    try{available=(await request('/api/admin/cities')).areas;if(window.aedSelectedCity&&!available.some(area=>area.id===window.aedSelectedCity))window.aedSelectedCity='';renderCities();const area=window.aedGetSelectedArea();document.getElementById('citySummary').textContent=area?`${area.name} · ${kindLabel[area.kind]} · TERC ${area.id}`:`${available.length} gotowych obszarów · filtr obejmuje wszystkie sekcje`;}
    catch(error){document.getElementById('citySummary').textContent=error.message;}
  }
  citySearch.oninput=renderCities;cityFilter.onchange=()=>selectCity(cityFilter.value);document.getElementById('refreshAreas').onclick=async()=>{await loadCities();saveLocation();updateDownloads();window.dispatchEvent(new CustomEvent('city-changed'));if(current==='coverage')loadPoints();if(current==='data')loadData();};
  window.activeAdminSection=current;
  document.querySelectorAll('[data-section]').forEach(link=>{const active=link.dataset.section===current;link.classList.toggle('is-active',active);if(active)link.setAttribute('aria-current','page');});
  if(current!=='coverage')document.getElementById('addButton').onclick=null;
  async function updateQueueCounts(){
    try{const data=await request(window.aedWithCity('/api/admin/moderation/summary'));document.getElementById('draftCount').textContent=data.proposals;document.getElementById('reportCount').textContent=data.reports;}catch{}
  }
  window.addEventListener('city-changed',updateQueueCounts);
  setInterval(()=>{if(!document.hidden)updateQueueCounts();},15000);
  function date(value){return value?new Date(value).toLocaleString('pl-PL'):'Brak informacji';}
  function renderAreaRows(){
    const query=normalize(document.getElementById('dataAreaSearch').value);
    const rows=available.filter(area=>!query||normalize(area.name+' '+area.id).includes(query));
    document.getElementById('areaRows').innerHTML=rows.length?rows.map(area=>`<tr><td><strong>${esc(area.name)}</strong><small>TERC ${area.id}</small></td><td>${esc(kindLabel[area.kind])}</td><td>${area.rawCount}</td><td class="area-row-actions"><button type="button" data-area-open="${area.id}">Otwórz</button><a href="/api/export?format=geojson&city=${area.id}">GeoJSON</a></td></tr>`).join(''):'<tr><td colspan="4">Nie znaleziono gotowego obszaru.</td></tr>';
  }
  async function loadData(){
    if(loadingData)return;loadingData=true;let refreshAfter=false;const requestedCity=window.aedSelectedCity;document.getElementById('dataStatus').textContent='Ładowanie danych…';
    try{
      const result=await request(window.aedWithCity('/api/admin/data'));if(requestedCity!==window.aedSelectedCity){refreshAfter=true;return;}
      data=result;available=result.areas;renderCities();renderAreaRows();updateDownloads();
      document.getElementById('dataRecordCount').textContent=result.records.toLocaleString('pl-PL');document.getElementById('dataAreaCount').textContent=available.length.toLocaleString('pl-PL');document.getElementById('dataAreaLabel').textContent=result.area?result.area.name+' · '+kindLabel[result.area.kind]:'Wszystkie obszary';
      const progress=result.collector?.progress,done=progress?.done||0,total=progress?.total||0,percent=total?Math.round(done/total*100):0;
      document.getElementById('dataProgressCount').textContent=total?done+' / '+total:'—';
      const fresh=result.collector?.updated_at&&Date.now()-Date.parse(result.collector.updated_at)<120000;
      document.getElementById('dataProgressLabel').textContent=fresh&&result.collector.phase==='running'?'Zbieracz przetwarza kolejne gminy':'Ostatni zapis stanu zbieracza';
      const bar=document.getElementById('collectorProgress');bar.setAttribute('aria-valuenow',String(percent));bar.querySelector('span').style.width=percent+'%';
      document.getElementById('collectorStatus').textContent=`Przygotowano ${done} z ${total} obszarów. Ostatni zapis: ${date(result.collector?.updated_at)}. Błędy: ${progress?.failed||0}.`;
      document.getElementById('sourceRows').innerHTML=result.sources.map(source=>`<tr><td><strong>${esc(source.label)}</strong>${source.filename?`<small>${esc(source.filename)}</small>`:''}</td><td>${esc(source.format)}</td><td>${source.records.toLocaleString('pl-PL')}</td><td>${esc(date(source.updatedAt))}</td></tr>`).join('');
      document.getElementById('dataStatus').textContent='';
    }catch(error){document.getElementById('dataStatus').textContent=error.message;}finally{loadingData=false;if(refreshAfter)loadData();}
  }
  if(current==='data'){
  document.getElementById('dataAreaSearch').oninput=renderAreaRows;
  document.getElementById('areaRows').addEventListener('click',event=>{const button=event.target.closest('[data-area-open]');if(button){citySearch.value='';renderCities();selectCity(button.dataset.areaOpen);window.openAdminSection('coverage');}});
  window.addEventListener('registry-changed',()=>{if(current==='data')loadData();});
  setInterval(()=>{if(current==='data'&&!document.hidden)loadData();},15000);
  }
  (async()=>{
    await loadCities();saveLocation();updateDownloads();
    await updateQueueCounts();
    if(current==='coverage')loadPoints();
    else if(current==='proposals'||current==='reports')window.openModerationQueue(current==='proposals'?'proposal':'report');
    else if(current==='duplicates')window.refreshDuplicateReview();
    else if(current==='data')loadData();
  })();
})();
