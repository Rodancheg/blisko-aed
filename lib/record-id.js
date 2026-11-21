'use strict';
const crypto=require('node:crypto');
function registryId(source,id){
  const namespace=Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex');
  const bytes=crypto.createHash('sha1').update(namespace).update(source+'/'+id).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.toString('hex');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
module.exports={registryId};
