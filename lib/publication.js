'use strict';

// A source publisher and an administrator are not the accountable provider
// of the compiled dataset. Assignment is an explicit local declaration.
function responsibility(settings={}) {
  const organization=settings.responsibilityAccepted===true&&typeof settings.publisher==='string'?settings.publisher.trim():'';
  return {
    status:organization?'declared':'unassigned',
    organization:organization||null,
    label:organization||'Nie wyznaczono',
    provider_identifier:organization&&settings.providerIdentifier||null,
    portal_connected:false
  };
}

function publicationStatus(settings={}) {
  const provider=responsibility(settings),missing=[];
  if(provider.status==='unassigned')missing.push('Odpowiedzialny dostawca zbioru nie został wyznaczony.');
  if(!settings.publicBaseUrl)missing.push('Brak publicznego adresu HTTPS aplikacji.');
  if(!provider.provider_identifier)missing.push('Brak identyfikatora profilu dostawcy w dane.gov.pl.');
  return {responsibility:provider,export_ready:missing.length===0,missing,connected:false};
}

module.exports={responsibility,publicationStatus};
