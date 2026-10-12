/* Price-book crypto, the browser half of scripts/pricebook.mjs: AES-GCM-256, key from the team passphrase via
   PBKDF2-SHA256, binary fields written as letters a-p (4 bits each). Pure functions of their arguments, so
   tests/pricebook.test.mjs can run them outside the workbench. */
function finBytes(s){
  if(typeof s!=="string"||s.length%2||/[^a-p]/.test(s))throw new Error("malformed price book");
  var o=new Uint8Array(s.length/2);
  for(var i=0;i<o.length;i++)o[i]=((s.charCodeAt(2*i)-97)<<4)|(s.charCodeAt(2*i+1)-97);
  return o;
}
function finLetters(b){var s="";for(var i=0;i<b.length;i++)s+=String.fromCharCode(97+(b[i]>>4),97+(b[i]&15));return s;}
function finDerive(pass,env){
  var c=crypto.subtle;
  return c.importKey("raw",new TextEncoder().encode(pass),"PBKDF2",false,["deriveKey"]).then(function(base){
    return c.deriveKey({name:"PBKDF2",hash:"SHA-256",salt:finBytes(env.salt),iterations:env.iterations},base,
      {name:"AES-GCM",length:256},true,["encrypt","decrypt"]);});
}
function finOpen(env,key){
  return crypto.subtle.decrypt({name:"AES-GCM",iv:finBytes(env.iv)},key,finBytes(env.data)).then(function(buf){
    return JSON.parse(new TextDecoder().decode(buf));});
}
/* re-seal with the same key (same passphrase and salt) and a fresh IV */
function finSeal(book,key,env){
  var iv=crypto.getRandomValues(new Uint8Array(12));
  return crypto.subtle.encrypt({name:"AES-GCM",iv:iv},key,new TextEncoder().encode(JSON.stringify(book))).then(function(ct){
    return {format:"atlas-pricebook",kdf:"PBKDF2-SHA256",iterations:env.iterations,cipher:"AES-GCM-256",
      salt:env.salt,iv:finLetters(iv),data:finLetters(new Uint8Array(ct))};});
}
