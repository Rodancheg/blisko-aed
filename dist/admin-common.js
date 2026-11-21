const escapeText=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let map=null;
window.loadPoints=async()=>{};
window.aedShowOnMap=records=>{
 const points=records.filter(record=>Number.isFinite(Number(record?.lat))&&Number.isFinite(Number(record?.lon))).slice(0,2);
 if(!points.length)return;
 const url=new URL(window.aedAdminHref('coverage'),location.origin);
 points.forEach((record,index)=>{url.searchParams.set(index?'lat2':'lat',record.lat);url.searchParams.set(index?'lon2':'lon',record.lon);});
 location.assign(url.pathname+url.search);
};
