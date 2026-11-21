/* Unknown formats remain unknown; this does not assert that a device is operational. */
window.aedAvailability=function(hours,when=new Date()){
  const text=String(hours||'').trim();if(/^24\s*\/\s*7$/i.test(text))return 'open';
  if(!text||/\b(PH|SH|off|closed|sunrise|sunset)\b/i.test(text))return 'unknown';
  const match=text.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?\s+(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if(!match)return 'unknown';const days=['Mo','Tu','We','Th','Fr','Sa','Su'];let first=days.indexOf(match[1]),last=days.indexOf(match[2]||match[1]);if(first>last)return 'unknown';const start=+match[3]*60+(+match[4]),end=+match[5]*60+(+match[6]);if(+match[3]>23||+match[4]>59||+match[5]>23||+match[6]>59||end<=start)return 'unknown';
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Warsaw',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(when);const get=t=>parts.find(p=>p.type===t)?.value,day=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(get('weekday')),minutes=+get('hour')*60+(+get('minute'));return day>=first&&day<=last&&minutes>=start&&minutes<end?'open':'closed';
};
