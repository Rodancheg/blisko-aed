(() => {
  const host=document.getElementById('adminAuth');window.aedAdminAuthenticated=false;
  function login(){location.replace('/login.html?next='+encodeURIComponent(location.pathname+location.search+location.hash));}
  async function request(url,options){const response=await fetch(url,options);const data=await response.json().catch(()=>({error:'Nie udało się pobrać danych.'}));if(response.status===401){login();throw Error('Sesja administratora wygasła.');}if(!response.ok)throw Error(data.error||'Operacja nie powiodła się.');return data;}
  window.aedAdminRequest=request;
  fetch('/api/admin/session').then(response=>response.json()).then(data=>{
    if(!data.authenticated){login();return;}
    window.aedAdminAuthenticated=true;host.innerHTML='<span class="admin-role">Administrator</span><button type="button" id="adminLogout">Wyloguj</button>';
    host.querySelector('button').onclick=async()=>{try{await request('/api/admin/session',{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'});location.assign('/login.html');}catch(error){host.querySelector('.admin-role').textContent=error.message;}};
    window.dispatchEvent(new CustomEvent('admin-session-change',{detail:{authenticated:true}}));
  }).catch(error=>{host.textContent=error.message;});
})();
