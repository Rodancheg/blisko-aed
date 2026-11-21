(() => {
  // Decode locally and re-encode a smaller JPEG, without the original file metadata.
  window.aedPhotoUpload = host => {
    const input=host.querySelector('input[type=file]'),preview=host.querySelector('img'),remove=host.querySelector('[data-remove-photo]'),message=host.querySelector('[data-photo-status]');
    let photo=null,version=0,working=false,error='';
    function reset(clearInput=true){version++;photo=null;working=false;error='';if(clearInput)input.value='';preview.removeAttribute('src');preview.hidden=true;remove.hidden=true;message.textContent='';}
    input.addEventListener('change',async()=>{
      const file=input.files[0];reset(false);if(!file)return;const request=version;working=true;message.textContent='Przygotowywanie zdjęcia…';
      let url;
      try{
        if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('Wybierz zdjęcie JPG, PNG lub WebP.');
        if(file.size>20000000)throw Error('Zdjęcie jest większe niż 20 MB. Wybierz mniejszy plik.');
        url=URL.createObjectURL(file);const image=new Image();image.src=url;await image.decode();
        if(request!==version)return;
        const scale=Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
        const context=canvas.getContext('2d');if(!context)throw Error('Nie udało się przygotować zdjęcia.');
        context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
        let value=canvas.toDataURL('image/jpeg',.82);if(value.length>2000000)value=canvas.toDataURL('image/jpeg',.6);
        if(!value.startsWith('data:image/jpeg;base64,')||value.length>2000000)throw Error('Wybierz mniejsze zdjęcie. Limit po zmniejszeniu wynosi 1,5 MB.');
        photo=value;preview.src=value;preview.hidden=false;remove.hidden=false;message.textContent='Zdjęcie gotowe. Zostanie przesłane razem z propozycją.';
      }catch(problem){if(request!==version)return;error=problem.message||'Nie udało się otworzyć zdjęcia. Wybierz inny plik.';message.textContent=error;remove.hidden=false;}
      finally{if(url)URL.revokeObjectURL(url);if(request===version)working=false;}
    });
    remove.onclick=()=>reset();
    return {reset,value(){if(working)throw Error('Poczekaj na przygotowanie zdjęcia.');if(error)throw Error(error);return photo;}};
  };
})();
