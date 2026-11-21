(() => {
  const createDialog = document.createElement('dialog'), reportDialog = document.createElement('dialog');
  createDialog.className = reportDialog.className = 'submission-dialog';
  createDialog.setAttribute('aria-labelledby','proposalTitle'); reportDialog.setAttribute('aria-labelledby','reportTitle');
  createDialog.innerHTML = '<div class="submission-head"><h2 id="proposalTitle">Zgłoś nowy AED</h2><button type="button" data-close aria-label="Zamknij formularz">×</button></div><div class="submission-body"><p>Administrator sprawdzi propozycję. Punkt pojawi się w rejestrze dopiero po zatwierdzeniu.</p><form id="proposalForm" class="submission-form"><label>Nazwa miejsca<input name="name" maxlength="120" required></label><label>Adres<input name="address" maxlength="200"></label><label>Miejscowość<input name="city" maxlength="120"></label><label>Warunki dostępu<input name="access" maxlength="200" placeholder="Np. przy wejściu, bez kodu"></label><label>Szerokość geograficzna<input name="lat" type="number" min="49" max="55" step="any" required></label><label>Długość geograficzna<input name="lon" type="number" min="14" max="25" step="any" required></label><button type="button" id="pickProposalLocation" class="submission-secondary">Wskaż miejsce na mapie</button><label>Godziny dostępu<input name="hours" maxlength="200" placeholder="Np. pon.–pt. 08:00–18:00"></label><label class="submission-wide">Jak znaleźć AED<textarea name="description" maxlength="500" rows="3"></textarea></label><div class="submission-wide photo-upload" id="proposalPhoto"><label>Zdjęcie AED (opcjonalnie)<input type="file" accept="image/jpeg,image/png,image/webp" aria-describedby="proposalPhotoHelp"></label><p id="proposalPhotoHelp" class="photo-help">JPG, PNG lub WebP, do 20 MB. Zdjęcie zmniejszymy automatycznie. Pojawi się po zatwierdzeniu punktu.</p><img class="photo-preview" alt="Podgląd zdjęcia AED" hidden><button type="button" data-remove-photo hidden>Usuń zdjęcie</button><p data-photo-status role="status" aria-live="polite"></p></div><div class="submission-wide submission-actions"><button type="submit">Wyślij propozycję</button></div></form><p id="proposalStatus" class="submission-status" role="status" aria-live="polite"></p></div>';
  reportDialog.innerHTML = '<div class="submission-head"><h2 id="reportTitle">Zgłoś problem z AED</h2><button type="button" data-close aria-label="Zamknij zgłoszenie">×</button></div><div class="submission-body"><p id="reportedPointName"></p><p>Zgłoszenie trafi do administratora. Samo przesłanie nie zmienia danych punktu.</p><form id="reportForm" class="submission-form"><label class="submission-wide">Rodzaj problemu<select name="reason"><option value="closed">Zamknięte drzwi / ograniczony dostęp</option><option value="missing">Brak urządzenia</option><option value="wrong_location">Błędna lokalizacja</option><option value="not_working">Urządzenie nie działa</option><option value="other">Inny problem</option></select></label><label class="submission-wide">Co trzeba sprawdzić?<textarea name="details" maxlength="1000" rows="3" placeholder="Opisz, co zauważono i gdzie szukać urządzenia"></textarea></label><fieldset id="suggestedLocation" class="submission-wide submission-form" hidden disabled><legend>Proponowana lokalizacja (opcjonalnie)</legend><label>Szerokość geograficzna<input name="lat" type="number" min="49" max="55" step="any"></label><label>Długość geograficzna<input name="lon" type="number" min="14" max="25" step="any"></label><label class="submission-wide">Poprawny adres<input name="address" maxlength="200"></label></fieldset><div class="submission-wide submission-actions"><button type="submit">Wyślij zgłoszenie</button></div></form><p id="reportStatus" class="submission-status" role="status" aria-live="polite"></p></div>';
  document.body.append(createDialog,reportDialog);
  for (const modal of [createDialog,reportDialog]) {
    modal.querySelector('[data-close]').onclick=()=>modal.close();
    modal.addEventListener('click',event=>{if(event.target===modal)modal.close();});
  }
  async function send(url,input){const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data.error||'Nie udało się wysłać zgłoszenia. Spróbuj ponownie.');return data;}
  const proposalForm=createDialog.querySelector('form'),proposalStatus=createDialog.querySelector('#proposalStatus');
  const photoUpload=window.aedPhotoUpload(createDialog.querySelector('#proposalPhoto'));
  document.getElementById('proposePoint').onclick=()=>{
    proposalStatus.textContent='';if(locationPoint&&!proposalForm.elements.lat.value){proposalForm.elements.lat.value=locationPoint.lat.toFixed(6);proposalForm.elements.lon.value=locationPoint.lon.toFixed(6);}createDialog.showModal();
  };
  proposalForm.onsubmit=async event=>{
    event.preventDefault();const button=proposalForm.querySelector('[type=submit]');button.disabled=true;proposalStatus.textContent='Przesyłanie propozycji…';
    try{const input=Object.fromEntries(new FormData(proposalForm));const photo=photoUpload.value();if(photo)input.photo=photo;await send('/api/proposals',input);proposalForm.reset();photoUpload.reset();proposalStatus.textContent='Propozycja zapisana. Oczekuje na zatwierdzenie administratora. Nie jest jeszcze widoczna w rejestrze.';}
    catch(error){proposalStatus.textContent=error.message;}finally{button.disabled=false;}
  };
  const pickNotice=document.createElement('div');pickNotice.className='point-pick-notice';pickNotice.hidden=true;pickNotice.innerHTML='<span>Kliknij miejsce AED na mapie.</span><button type="button">Anuluj wskazywanie</button>';document.getElementById('aedMap').after(pickNotice);
  let picker=null;
  function endPicking(){if(map&&picker)map.off('click',picker);picker=null;pickNotice.hidden=true;if(map)map.getContainer().classList.remove('choose-location');}
  pickNotice.querySelector('button').onclick=()=>{endPicking();createDialog.showModal();};
  createDialog.querySelector('#pickProposalLocation').onclick=()=>{
    if(!map){proposalStatus.textContent='Mapa jest niedostępna. Wpisz współrzędne ręcznie.';return;}
    endPicking();createDialog.close();pickNotice.hidden=false;map.getContainer().classList.add('choose-location');
    picker=event=>{proposalForm.elements.lat.value=event.latlng.lat.toFixed(6);proposalForm.elements.lon.value=event.latlng.lng.toFixed(6);endPicking();createDialog.showModal();};
    map.once('click',picker);document.getElementById('aedMap').scrollIntoView({behavior:'smooth',block:'center'});
  };
  const reportForm=reportDialog.querySelector('form'),reportStatus=reportDialog.querySelector('#reportStatus'),suggested=reportDialog.querySelector('#suggestedLocation');let target=null;
  function reportPoint(point){target=point;reportForm.reset();suggested.hidden=true;suggested.disabled=true;reportStatus.textContent='';reportDialog.querySelector('#reportedPointName').textContent=point.name+(point.address?' · '+point.address:'');if(dialog.open)dialog.close();reportDialog.showModal();}
  reportForm.elements.reason.onchange=()=>{suggested.hidden=reportForm.elements.reason.value!=='wrong_location';suggested.disabled=suggested.hidden;};
  list.addEventListener('click',event=>{const button=event.target.closest('[data-report]');if(button&&points[Number(button.dataset.report)])reportPoint(points[Number(button.dataset.report)]);});
  document.addEventListener('aed-report-request',event=>reportPoint(event.detail));
  reportForm.onsubmit=async event=>{
    event.preventDefault();const button=reportForm.querySelector('[type=submit]');button.disabled=true;reportStatus.textContent='Przesyłanie zgłoszenia…';
    try{
      const input={registryId:target.registry_id,source:target.source,id:target.id,reason:reportForm.elements.reason.value,details:reportForm.elements.details.value};
      if(input.reason==='wrong_location'){
        const lat=reportForm.elements.lat.value,lon=reportForm.elements.lon.value;
        if(Boolean(lat)!==Boolean(lon))throw Error('Podaj obie współrzędne albo pozostaw oba pola puste.');
        input.suggested={};if(lat){input.suggested.lat=lat;input.suggested.lon=lon;}if(reportForm.elements.address.value.trim())input.suggested.address=reportForm.elements.address.value.trim();
      }
      await send('/api/reports',input);reportStatus.textContent='Zgłoszenie zapisane. Administrator sprawdzi je przed zmianą danych punktu.';
    }catch(error){reportStatus.textContent=error.message;}finally{button.disabled=false;}
  };
  let polling=false;
  async function refreshRegistry(){
    if(polling||document.hidden||createDialog.open||reportDialog.open||dialog.open)return;polling=true;
    try{const response=await fetch('/api/registry/version');if(!response.ok)return;const data=await response.json();if(window.aedRegistryVersion&&data.version!==window.aedRegistryVersion&&locationPoint)await nearby();}catch{}finally{polling=false;}
  }
  setInterval(refreshRegistry,10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshRegistry();});
})();
