(() => {
  'use strict';
  const panel = document.getElementById('duplicatesPanel');
  if (!panel) return;
  let view = 'pending', offset = 0, revision = 0, moderationRevision = 0, busy = false, mapLayers = null, loadVersion = 0;
  const pageSize = 20;
  panel.innerHTML = `<div class="review-heading"><div><h2 id="reviewTitle" tabindex="-1">Weryfikacja duplikatów</h2><p>Odległość do 25 m wskazuje parę do sprawdzenia. W jednym budynku mogą być różne AED.</p></div><button type="button" id="closeReview" aria-label="Zamknij weryfikację">Zamknij</button></div>
    <div class="review-tabs"><button type="button" data-view="pending" aria-pressed="true">Do sprawdzenia</button><button type="button" data-view="history" aria-pressed="false">Zapisane decyzje</button><button type="button" id="refreshReview">Odśwież</button></div>
    <p id="reviewStatus" role="status" aria-live="polite"></p><div id="reviewContent"></div><div id="reviewPages" class="review-pages"></div>`;
  const status = panel.querySelector('#reviewStatus'), content = panel.querySelector('#reviewContent'), pages = panel.querySelector('#reviewPages');
  const escape = escapeText;
  const label = value => escape(value || 'Brak informacji');
  function setBusy(value) {
    busy = value;
    panel.setAttribute('aria-busy', String(value));
    panel.querySelectorAll('button, input, textarea').forEach(element => { element.disabled = value; });
    if (!value) {
      if(!window.aedAdminAuthenticated)panel.querySelectorAll('[data-action=merge],[data-action=different],[data-action=undo]').forEach(button=>button.disabled=true);
      const previous = pages.querySelector('#previousReview'), next = pages.querySelector('#nextReview');
      if (previous) previous.disabled = offset === 0;
      if (next) next.disabled = !next.dataset.canNext;
    }
  }
  async function request(url, options) {
    const response = await fetch(url, options), data = await response.json();
    if (!response.ok) throw Error(data.error || 'Nie udało się zapisać decyzji.');
    return data;
  }
  function fields(record, other) {
    return [['Nazwa', 'name'], ['Adres', 'address'], ['Dostęp', 'access'], ['Godziny', 'hours'], ['Jak znaleźć', 'description'], ['Wewnątrz / na zewnątrz', 'placement']].map(([title, key]) => {
      const different = other && String(record[key] || '').trim() !== String(other[key] || '').trim();
      return `<div class="review-field${different ? ' review-difference' : ''}"><dt>${title}${different ? ' · różnica' : ''}</dt><dd>${label(record[key])}</dd></div>`;
    }).join('');
  }
  function recordCard(record, other, pairId, main = false, selectable = true) {
    return `<section class="review-source"><h3>${escape(record.source_label || record.source)}</h3><p class="review-source-id">${escape(record.id)}</p><dl>${fields(record, other)}</dl><p class="review-coordinates">${record.lat.toFixed(6)}, ${record.lon.toFixed(6)}</p>${selectable ? `<label class="review-primary-choice"><input type="radio" name="primary-${pairId}" value="${escape(record.id)}"${main ? ' checked' : ''}> Użyj tych danych jako głównych</label>` : ''}</section>`;
  }
  function renderPair(pair) {
    return `<article class="review-pair" data-pair="${pair.pairId}"><div class="review-pair-heading"><h3>Porównaj dwa rekordy</h3><strong>${pair.distance.toFixed(1)} m</strong></div><div class="review-compare">${recordCard(pair.a, pair.b, pair.pairId, true)}${recordCard(pair.b, pair.a, pair.pairId)}</div><label class="review-note-label">Notatka (opcjonalnie)<textarea maxlength="500" rows="2" placeholder="Np. dwa urządzenia na różnych piętrach"></textarea></label><div class="review-actions"><button type="button" class="review-merge" data-action="merge">Połącz jako jedno AED</button><button type="button" data-action="different">Różne urządzenia</button><button type="button" data-action="map">Pokaż na mapie</button></div><p class="review-explanation">Połączenie zachowuje oba źródła i ich oryginalne dane. Wybrany rekord dostarcza główne dane w rejestrze.</p></article>`;
  }
  function renderDecision(decision) {
    const records = decision.snapshots || [], first = records[0], second = records[1];
    return `<article class="review-pair" data-decision="${decision.pairId}"><div class="review-pair-heading"><h3>${decision.action === 'merge' ? 'Połączone: jedno AED' : 'Różne urządzenia'}</h3><time datetime="${escape(decision.reviewedAt)}">${escape(new Date(decision.reviewedAt).toLocaleString('pl-PL'))}</time></div>${first && second ? `<div class="review-compare">${recordCard(first, second, decision.pairId, false, false)}${recordCard(second, first, decision.pairId, false, false)}</div>` : ''}${decision.primaryId ? `<p>Rekord główny: <strong>${escape(decision.primaryId)}</strong></p>` : ''}${decision.note ? `<p>Notatka: ${escape(decision.note)}</p>` : ''}<div class="review-actions"><button type="button" data-action="undo">Cofnij decyzję</button></div></article>`;
  }
  let shownPairs = new Map();
  function pagination(total) {
    pages.innerHTML = `<button type="button" id="previousReview"${offset === 0 ? ' disabled' : ''}>Poprzednie</button><span>${total ? offset + 1 : 0}–${Math.min(offset + pageSize, total)} z ${total}</span><button type="button" id="nextReview"${offset + pageSize >= total ? ' disabled' : ''}>Następne</button>`;
    pages.querySelector('#previousReview').onclick = () => { offset = Math.max(0, offset - pageSize); load(); };
    pages.querySelector('#nextReview').onclick = () => { offset += pageSize; load(); };
    if (offset + pageSize < total) pages.querySelector('#nextReview').dataset.canNext = 'true';
  }
  async function load(messageText = '') {
    const version = ++loadVersion;
    setBusy(true); status.textContent = 'Ładowanie…';
    try {
      if (view === 'pending') {
        const data = await request(window.aedWithCity(`/api/duplicates?offset=${offset}&limit=${pageSize}`));
        if (version !== loadVersion) return;
        revision = data.revision; moderationRevision = data.moderationRevision; shownPairs = new Map(data.pairs.map(pair => [pair.pairId, pair]));
        content.innerHTML = data.pairs.length ? data.pairs.map(renderPair).join('') : '<p class="review-empty">Brak par oczekujących na sprawdzenie.</p>';
        status.textContent = messageText || `Pary do sprawdzenia: ${data.total}. Zapisane decyzje: ${data.reviewed}.`;
        pagination(data.total);
      } else {
        const data = await request(window.aedWithCity('/api/duplicates/history'));
        if (version !== loadVersion) return;
        revision = data.revision; moderationRevision = data.moderationRevision;
        content.innerHTML = data.decisions.length ? data.decisions.slice(offset, offset + pageSize).map(renderDecision).join('') : '<p class="review-empty">Nie zapisano jeszcze decyzji.</p>';
        status.textContent = messageText || `Zapisane decyzje: ${data.decisions.length}. Zmiany w dzienniku: ${data.events}.`;
        pagination(data.decisions.length);
      }
    } catch (error) { if (version === loadVersion) status.textContent = error.message; }
    finally {
      if (version === loadVersion) {
        setBusy(false);
      }
    }
  }
  panel.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button || busy) return;
    const article = button.closest('article'), action = button.dataset.action;
    const pair = shownPairs.get(article.dataset.pair);
    if (action === 'map') {
      if(pair)window.aedShowOnMap([pair.a,pair.b]);
      return;
    }
    const input = {action, revision, moderationRevision};
    if (action === 'undo') input.pairId = article.dataset.decision;
    else {
      if (!pair) return;
      input.recordIds = [pair.a.id, pair.b.id];
      input.primaryId = article.querySelector('input:checked')?.value;
      input.note = article.querySelector('textarea').value;
    }
    setBusy(true); status.textContent = 'Zapisywanie decyzji…';
    try {
      await request('/api/duplicates/decisions', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)});
      offset = 0;
      await load(action === 'merge' ? 'Połączono rekordy. Oba źródła zachowano; mapa i eksport uwzględniają decyzję. Możesz ją cofnąć w zapisanych decyzjach.' : action === 'different' ? 'Zapisano: różne urządzenia. Para nie będzie ponownie proponowana.' : 'Cofnięto decyzję. Rejestr został przeliczony.');
      await loadPoints(); window.dispatchEvent(new CustomEvent('registry-changed',{detail:{source:'duplicates'}}));
      panel.querySelector('#reviewTitle').focus({preventScroll: true});
    } catch (error) { setBusy(false); status.textContent = error.message + ' Użyj „Odśwież”, aby pobrać aktualną listę.'; }
  });
  panel.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => {
    view = button.dataset.view; offset = 0;
    panel.querySelectorAll('[data-view]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
    load();
  }; });
  panel.querySelector('#refreshReview').onclick = () => load();
  panel.querySelector('#closeReview').onclick = () => { panel.hidden = true; document.getElementById('duplicatesBtn').focus(); };
  window.addEventListener('admin-session-change',()=>setBusy(busy));
  window.addEventListener('registry-changed',event=>{if(event.detail?.source!=='duplicates'&&!panel.hidden){if([...panel.querySelectorAll('textarea')].some(input=>input.value.trim()))status.textContent='Rejestr zmienił się. Odśwież pary przed zapisaniem decyzji.';else load();}});
  window.refreshDuplicateReview=()=>{panel.hidden=false;offset=0;load();};
  window.addEventListener('city-changed',()=>{offset=0;if(!panel.hidden)load();});
  if(!document.getElementById('duplicatesBtn').dataset.section)document.getElementById('duplicatesBtn').onclick = () => { panel.hidden = false; load(); };
})();
