(() => {
  const form=document.getElementById('loginForm'),message=document.getElementById('loginStatus');
  let destination='/admin/map';
  try{const candidate=new URL(new URLSearchParams(location.search).get('next')||destination,location.origin);if(candidate.origin===location.origin&&['/admin.html','/admin/map','/admin/new','/admin/reports','/admin/duplicates','/admin/data'].includes(candidate.pathname))destination=candidate.pathname+candidate.search+candidate.hash;}catch{}
  form.onsubmit=async event=>{
    event.preventDefault();const button=form.querySelector('button');button.disabled=true;message.textContent='Logowanie…';
    try{const response=await fetch('/api/admin/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:form.elements.password.value})});const data=await response.json();if(!response.ok)throw Error(data.error||'Nie udało się zalogować.');form.reset();location.assign(destination);}
    catch(error){message.textContent=error.message;button.disabled=false;}
  };
  fetch('/api/admin/session').then(response=>response.json()).then(data=>{if(data.authenticated)location.replace(destination);}).catch(()=>{});
})();
