(() => {
  let active=null;
  function sources(point){
    const result=[];
    if(typeof point.photoUrl==='string'&&/^\/api\/proposal-photo\?id=[a-f0-9-]+$/.test(point.photoUrl))result.push({url:point.photoUrl,credit:'Zdjęcie ze zgłoszenia zatwierdzonego przez administratora'});
    const warsawId=point.photoWarsawId||(point.source==='warsaw'?point.source_record_id||point.id:'');
    if(/^\d{1,12}$/.test(String(warsawId||'')))result.push({url:'/api/photo?id='+encodeURIComponent(warsawId),credit:'Źródło: Urząd m.st. Warszawy'});
    if(typeof point.photoCommons==='string'&&point.photoCommons.startsWith('File:'))result.push({url:'https://commons.wikimedia.org/wiki/Special:FilePath/'+encodeURIComponent(point.photoCommons.slice(5))+'?width=800',credit:'Źródło i licencja zdjęcia: Wikimedia Commons',link:'https://commons.wikimedia.org/wiki/'+encodeURIComponent(point.photoCommons)});
    return result;
  }
  function stop(){
    if(!active)return;const previous=active;active=null;previous.controller.abort();clearTimeout(previous.timer);if(previous.blobURL)URL.revokeObjectURL(previous.blobURL);
  }
  window.aedStopPhoto=stop;
  window.aedPhotoBlock=point=>sources(point).length?'<div class="aed-photo" data-photo-block data-state="loading" aria-busy="true"><div class="aed-photo-placeholder" role="status" aria-live="polite">Ładowanie zdjęcia…</div><img alt="Zdjęcie lokalizacji AED" hidden><button class="aed-photo-retry" type="button" hidden>Spróbuj ponownie</button><small data-photo-credit hidden></small></div>':'<div class="aed-no-photo">Brak zdjęcia w danych źródłowych</div>';
  window.aedLoadPhoto=async(host,point)=>{
    const block=host.querySelector('[data-photo-block]');if(!block)return;
    stop();const state={controller:new AbortController(),blobURL:null,timer:null};active=state;
    const image=block.querySelector('img'),message=block.querySelector('[role=status]'),button=block.querySelector('button'),credit=block.querySelector('[data-photo-credit]');
    block.dataset.state='loading';block.setAttribute('aria-busy','true');image.hidden=true;message.hidden=false;message.textContent='Ładowanie zdjęcia…';credit.hidden=true;button.hidden=true;
    button.onclick=()=>window.aedLoadPhoto(host,point);
    const candidates=sources(point);let missing=0;
    try{
      for(const source of candidates){
        if(active!==state)return;
        try{
          state.timer=setTimeout(()=>state.controller.abort(),70000);
          if(source.url.startsWith('/')){
            const response=await fetch(source.url,{signal:state.controller.signal});
            if(!response.ok){if(response.status===404)missing++;throw Error('Photo source unavailable');}
            const blob=await response.blob();if(!blob.type.startsWith('image/'))throw Error('Invalid photo');
            if(active!==state)return;state.blobURL=URL.createObjectURL(blob);image.src=state.blobURL;
          }else image.src=source.url;
          await new Promise((resolve,reject)=>{
            const cancelled=()=>reject(Error('Photo load cancelled'));
            if(state.controller.signal.aborted){cancelled();return;}
            state.controller.signal.addEventListener('abort',cancelled,{once:true});
            image.decode().then(resolve,reject).finally(()=>state.controller.signal.removeEventListener('abort',cancelled));
          });
          if(active!==state)return;
          image.hidden=false;message.hidden=true;block.dataset.state='ready';
          credit.replaceChildren();
          if(source.link){const link=document.createElement('a');link.href=source.link;link.target='_blank';link.rel='noopener noreferrer';link.textContent=source.credit;credit.appendChild(link);}else credit.textContent=source.credit;
          credit.hidden=false;return;
        }catch{
          if(active!==state)return;
          image.removeAttribute('src');if(state.blobURL){URL.revokeObjectURL(state.blobURL);state.blobURL=null;}
          if(state.controller.signal.aborted)break;
        }finally{clearTimeout(state.timer);}
      }
      if(active!==state)return;
      const absent=missing===candidates.length;
      block.dataset.state='unavailable';message.textContent=absent?'Brak zdjęcia w danych źródłowych.':'Zdjęcie jest chwilowo niedostępne. Spróbuj ponownie.';button.hidden=absent;
    }finally{if(active===state)block.setAttribute('aria-busy','false');}
  };
})();
