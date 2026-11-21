window.aedSelectedCity=new URLSearchParams(location.search).get('city')||'';
window.aedWithCity=function(value){const url=new URL(value,location.origin);if(window.aedSelectedCity)url.searchParams.set('city',window.aedSelectedCity);else url.searchParams.delete('city');return url.pathname+url.search+url.hash;};

window.aedAdminPages={coverage:'/admin/map',proposals:'/admin/new',reports:'/admin/reports',duplicates:'/admin/duplicates',data:'/admin/data'};
window.aedAdminHref=(section)=>window.aedWithCity(window.aedAdminPages[section]||window.aedAdminPages.coverage);
window.openAdminSection=section=>location.assign(window.aedAdminHref(section));
