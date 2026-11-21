(() => {
  const panel = document.getElementById('moderationPanel'), request = window.aedAdminRequest, esc = escapeText;
  if (!panel) return;
  const reasons = {closed: 'Zamknięte drzwi / ograniczony dostęp', missing: 'Brak urządzenia', wrong_location: 'Błędna lokalizacja', not_working: 'Urządzenie nie działa', other: 'Inny problem'};
  const labels = {name:'Nazwa miejsca', address:'Adres', city:'Miejscowość', lat:'Szerokość geograficzna', lon:'Długość geograficzna', hours:'Godziny dostępu', access:'Warunki dostępu', description:'Jak znaleźć AED', device_operational_status:'Stan urządzenia'};
  let kindFilter=document.body.dataset.adminSection==='reports'?'report':'proposal', state = null, decided = false, dirty = false, busy = false, version = 0;
  panel.innerHTML = '<div class="review-heading"><div><h2 id="moderationTitle" tabindex="-1">Nowe punkty i zgłoszenia</h2><p>Zmiany trafiają do rejestru, wyszukiwarki, mapy i eksportu po zatwierdzeniu.</p></div><button type="button" id="closeModeration">Zamknij</button></div><div class="review-tabs"><button type="button" data-queue-view="pending" aria-pressed="true">Oczekujące</button><button type="button" data-queue-view="decided" aria-pressed="false">Rozpatrzone</button><button type="button" id="refreshModeration">Odśwież kolejkę</button></div><p id="moderationStatus" role="status" aria-live="polite"></p><div id="moderationItems"></div>';
  const message = panel.querySelector('#moderationStatus'), content = panel.querySelector('#moderationItems');
  function fields(values) {
    return Object.entries(labels).map(([key, title]) => {
      if (key === 'device_operational_status') return `<label>${title}<select name="${key}">${[['unknown','Niepotwierdzony'],['operational','Sprawny — potwierdzone'],['out_of_service','Niesprawny'],['decommissioned','Wycofany']].map(([value,label])=>`<option value="${value}"${(values[key] || 'unknown') === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`;
      const numeric = key === 'lat' || key === 'lon';
      const required = ['name','lat','lon'].includes(key);
      return `<label>${title}<input name="${key}" value="${esc(values[key] ?? '')}"${numeric ? ` type="number" step="any" min="${key === 'lat' ? 49 : 14}" max="${key === 'lat' ? 55 : 25}"` : ` maxlength="${key === 'name' || key === 'city' ? 120 : key === 'description' ? 500 : 200}"`}${required ? ' required' : ''}></label>`;
    }).join('');
  }
  const photoMarkup=item=>item.photo?`<figure class="moderation-photo"><a href="/api/proposal-photo?id=${encodeURIComponent(item.id)}" target="_blank" rel="noopener"><img src="/api/proposal-photo?id=${encodeURIComponent(item.id)}" alt="Zdjęcie przesłane z propozycją AED" loading="lazy"></a><figcaption>Zdjęcie ze zgłoszenia · kliknij, aby powiększyć</figcaption></figure>`:'';
  function pendingCard(item, kind) {
    const proposal = kind === 'proposal', current = proposal ? item.fields : item.current || item.snapshot || {};
    const values = {...current, ...(!proposal ? item.suggested : {})};
    if (!proposal && item.reason === 'not_working') values.device_operational_status = 'out_of_service';
    const hide = !proposal && item.reason === 'missing';
    return `<article class="moderation-card" data-kind="${kind}" data-id="${esc(item.id)}"><h3>${proposal ? 'Nowy AED' : 'Zgłoszenie problemu'} · ${esc(current.name || 'Nieznany punkt')}</h3><p class="moderation-meta">Przesłano ${esc(new Date(item.created).toLocaleString('pl-PL'))}</p>${proposal ? `<p>Sprawdź lokalizację i dane przed dodaniem do rejestru.</p>${item.import?`<p class="moderation-meta">Import: ${esc(item.import.filename)}</p>`:''}` : `<p><strong>${esc(reasons[item.reason] || item.reason)}</strong></p><p>${esc(item.details || 'Bez dodatkowego opisu.')}</p>${!item.current ? '<p class="moderation-warning">Punkt nie jest już dostępny. Możesz odrzucić zgłoszenie.</p>' : ''}${Object.keys(item.suggested || {}).length ? '<p class="moderation-warning">Pola zawierają propozycję użytkownika. Sprawdź ją przed zatwierdzeniem.</p>' : ''}`}
      ${proposal ? photoMarkup(item) : ''}<form class="moderation-form">${!proposal ? `<label class="moderation-wide">Decyzja dotycząca rejestru<select name="operation"><option value="edit"${!hide ? ' selected' : ''}>Popraw sprawdzone dane</option><option value="hide"${hide ? ' selected' : ''}>Ukryj punkt — brak AED</option></select></label>` : ''}<fieldset class="moderation-fields"${hide ? ' hidden disabled' : ''}><legend>Dane po zatwierdzeniu</legend>${fields(values)}</fieldset><label class="moderation-wide">Notatka administratora<textarea name="note" maxlength="500" rows="2"></textarea></label><div class="review-actions moderation-wide"><button type="submit" class="review-merge"${!proposal && !item.current ? ' disabled' : ''}>${proposal ? 'Zatwierdź nowy punkt' : 'Zatwierdź zmianę'}</button><button type="button" data-moderation-action="reject">Odrzuć zgłoszenie</button><button type="button" data-moderation-action="map">Pokaż na mapie</button></div></form></article>`;
  }
  function historyCard(item, kind) {
    const values = kind === 'proposal' ? item.decision?.fields || item.fields : item.snapshot;
    const changes = item.decision?.patch || (kind === 'proposal' && item.status === 'approved' ? item.decision.fields : {});
    return `<article class="moderation-card" data-kind="${kind}" data-id="${esc(item.id)}"><h3>${kind === 'proposal' ? 'Nowy AED' : 'Zgłoszenie problemu'} · ${esc(values?.name || 'Punkt AED')}</h3><p><strong>${item.status === 'approved' ? 'Zatwierdzone' : 'Odrzucone'}</strong> · ${esc(new Date(item.decision.at).toLocaleString('pl-PL'))}</p>${item.decision.operation === 'hide' ? '<p>Punkt ukryty w rejestrze, mapie, wyszukiwaniu i eksporcie.</p>' : ''}${kind === 'proposal' ? photoMarkup(item) : ''}<dl class="moderation-changes">${Object.entries(changes).map(([key,value])=>`<div><dt>${esc(labels[key] || key)}</dt><dd>${esc(key === 'device_operational_status' ? ({unknown:'Niepotwierdzony',operational:'Sprawny — potwierdzone',out_of_service:'Niesprawny',decommissioned:'Wycofany'}[value] || value) : value === '' ? 'Brak informacji' : String(value))}</dd></div>`).join('')}</dl>${item.decision.note ? `<p>Notatka: ${esc(item.decision.note)}</p>` : ''}<div class="review-actions"><button type="button" data-moderation-action="undo">Cofnij decyzję</button></div></article>`;
  }
  function cards() {
    if (!state) return;
    const list = [...state.proposals.map(item=>({item,kind:'proposal'})), ...state.reports.map(item=>({item,kind:'report'}))].filter(({item,kind})=>(!kindFilter||kind===kindFilter)&&(decided ? item.status !== 'pending' : item.status === 'pending'));
    list.sort((a,b)=>b.item.created.localeCompare(a.item.created));
    content.innerHTML = list.length ? list.map(({item,kind})=>decided ? historyCard(item,kind) : pendingCard(item,kind)).join('') : '<p class="review-empty">Brak zgłoszeń w tej kolejce.</p>';
  }
  function sidebar() {
    if (!state) return;
    for (const [key, countId, listId] of [['proposals','draftCount','draftList'],['reports','reportCount','reportList']]) {
      const items = state[key].filter(item=>item.status === 'pending');
      document.getElementById(countId).textContent = items.length;
      document.getElementById(listId).innerHTML = items.length ? items.slice(0,5).map(item=>`<div class="draft-item"><strong>${esc(item.fields?.name || item.current?.name || item.snapshot?.name || 'Punkt AED')}</strong><p>${esc(key === 'reports' ? reasons[item.reason] : item.fields.address || 'Nowa propozycja')}</p><button type="button" data-open-moderation="${esc(item.id)}">Sprawdź zgłoszenie</button></div>`).join('') : '<p>Brak oczekujących zgłoszeń.</p>';
    }
  }
  async function load(text = '') {
    if (!window.aedAdminAuthenticated) { content.innerHTML = ''; message.textContent = 'Zaloguj się jako administrator, aby sprawdzić zgłoszenia.'; return; }
    const requestVersion = ++version; busy = true; panel.setAttribute('aria-busy','true'); message.textContent = 'Ładowanie kolejki…';
    try { const data = await request(window.aedWithCity('/api/admin/moderation')); if (requestVersion !== version) return; state = data; dirty = false; cards(); sidebar(); message.textContent = text || 'Sprawdź zgłoszenie i zatwierdź konkretne dane albo je odrzuć.'; }
    catch (error) { message.textContent = error.message; }
    finally { busy = false; panel.setAttribute('aria-busy','false'); }
  }
  window.refreshModeration = load;
  window.openModerationQueue=kind=>{kindFilter=kind;decided=false;dirty=false;panel.querySelector('#moderationTitle').textContent=kind==='report'?'Uwagi i zgłoszenia':'Kolejka nowych AED';panel.querySelectorAll('[data-queue-view]').forEach(tab=>tab.setAttribute('aria-pressed',String(tab.dataset.queueView==='pending')));panel.hidden=false;load();};
  window.addEventListener('city-changed',()=>{dirty=false;load();});
  function findItem(article) { return (article.dataset.kind === 'proposal' ? state.proposals : state.reports).find(item=>item.id === article.dataset.id); }
  async function decide(article, action) {
    if (busy) return;
    const item = findItem(article), form = article.querySelector('form');
    const input = {kind:article.dataset.kind,id:item.id,version:item.version,action,note:form?.elements.note.value || ''};
    if (action === 'approve') {
      input.operation = form.elements.operation?.value || 'edit'; input.targetRevision = item.targetRevision;
      if (input.kind === 'proposal' || input.operation === 'edit') input.fields = Object.fromEntries(Object.keys(labels).map(key=>[key,form.elements.namedItem(key).value]));
    }
    busy = true; article.querySelectorAll('button').forEach(button=>button.disabled=true); message.textContent = 'Zapisywanie decyzji…';
    try {
      await request('/api/admin/moderation/decisions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
      await load(action === 'approve' ? 'Zatwierdzono. Rejestr, mapa, wyszukiwanie i eksport uwzględniają zmianę.' : action === 'reject' ? 'Odrzucono zgłoszenie. Rejestr pozostaje bez zmian.' : 'Cofnięto decyzję. Zgłoszenie wróciło do kolejki.');
      await loadPoints(); window.dispatchEvent(new CustomEvent('registry-changed',{detail:{source:'moderation'}}));
      panel.querySelector('#moderationTitle').focus({preventScroll:true});
    } catch (error) { busy=false; article.querySelectorAll('button').forEach(button=>button.disabled=false); message.textContent=error.message; }
  }
  panel.addEventListener('submit',event=>{if(!event.target.matches('.moderation-form'))return;event.preventDefault();decide(event.target.closest('article'),'approve');});
  panel.addEventListener('input',()=>dirty=true);
  panel.addEventListener('change',event=>{if(event.target.name==='operation'){const group=event.target.closest('form').querySelector('fieldset');group.hidden=event.target.value==='hide';group.disabled=group.hidden;}});
  panel.addEventListener('click',event=>{
    const button=event.target.closest('[data-moderation-action]');if(!button)return;
    const article=button.closest('article'),action=button.dataset.moderationAction,item=findItem(article);
    if(action==='map'){
      const record=item.fields||item.current||item.snapshot;if(record)window.aedShowOnMap([record]);return;
    }
    decide(article,action);
  });
  function open(){panel.hidden=false;load();panel.scrollIntoView({behavior:'smooth',block:'start'});}
  if(!document.getElementById('moderationBtn').dataset.section)document.getElementById('moderationBtn').onclick=open;
  document.addEventListener('click',event=>{const button=event.target.closest('[data-open-moderation]');if(!button)return;const isReport=state?.reports.some(item=>item.id===button.dataset.openModeration);if(window.openAdminSection)window.openAdminSection(isReport?'reports':'proposals');else open();});
  panel.querySelector('#closeModeration').onclick=()=>{panel.hidden=true;document.getElementById('moderationBtn').focus();};
  panel.querySelector('#refreshModeration').onclick=()=>load();
  panel.querySelectorAll('[data-queue-view]').forEach(button=>button.onclick=()=>{decided=button.dataset.queueView==='decided';panel.querySelectorAll('[data-queue-view]').forEach(tab=>tab.setAttribute('aria-pressed',String(tab===button)));dirty=false;cards();});
  window.addEventListener('admin-session-change',()=>{if(window.aedAdminAuthenticated)load();else{state=null;content.innerHTML='';document.getElementById('draftList').textContent='Zaloguj się, aby zobaczyć kolejkę.';document.getElementById('reportList').textContent='Zaloguj się, aby zobaczyć kolejkę.';message.textContent='Zaloguj się jako administrator.';}});
  window.addEventListener('registry-changed',event=>{if(event.detail?.source!=='moderation'){if(dirty)message.textContent='Rejestr zmienił się. Odśwież kolejkę przed zatwierdzeniem.';else load();}});
  setInterval(async()=>{
    if(!window.aedAdminAuthenticated||document.hidden||busy)return;
    try{const data=await request(window.aedWithCity('/api/admin/moderation/summary'));document.getElementById('draftCount').textContent=data.proposals;document.getElementById('reportCount').textContent=data.reports;if(state&&data.revision!==state.revision&&!dirty)load();}catch{}
  },10000);
  if(window.aedAdminAuthenticated)load();
})();
