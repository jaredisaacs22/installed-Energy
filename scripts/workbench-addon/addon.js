/* ── Atlas add-on: prices and the financial tabs ─────────────────────────────────────────────────────────────
   The Atlas build is published without unit prices (scripts/scrub-workbench.mjs). The team price book rides
   along encrypted (FIN_ENV) and the team passphrase unlocks it in the browser. Unlocked, the unit catalog and
   the Deal Economics defaults get their prices back, the billing-mode switcher returns, and the Tariffs & Bills,
   Revenue, Deal Economics and Summary tabs that this file has always carried are shown. Locked, this is exactly
   the kW-only build. Prices filled from the book are flagged (finCost) so a newer book can replace them and Lock
   can take them out again; a price a site file already carries is never overwritten. See docs/WORKBENCH.md. */
var FIN={on:false,book:null,key:null,env:FIN_ENV,remembered:false,edited:false,busy:false};
var FIN_KEY_STORE="sie_pricekey";
var FIN_TABS={tariffs:"Tariffs & Bills",revenue:"Revenue",economics:"Deal Economics",summary:"Summary"};

/* The kW-only rule of the locked build (restore() and Open call this). A billing mode the user chose is parked
   in tariffs.finMode and comes back on unlock. Returns true when it changed the mode. */
function finKwOnly(){
  var t=model&&model.tariffs;
  if(!t||FIN.on||t.mode==="peak-shave")return false;
  if(t.modeUserSet)t.finMode=t.mode;
  t.mode="peak-shave";return true;
}
function finModeBack(){var t=model&&model.tariffs;if(t&&t.finMode){t.mode=t.finMode;delete t.finMode;}}
/* Tariffs & Bills sits after Interval Data (the bills feed sizing); the money tabs follow the sizing tabs. */
function finSetTabs(on){
  var out=[];
  TABS.filter(function(t){return !FIN_TABS[t.id];}).forEach(function(t){
    out.push(t);if(on&&t.id==="interval")out.push({id:"tariffs",label:FIN_TABS.tariffs});});
  if(on)["revenue","economics","summary"].forEach(function(id){out.push({id:id,label:FIN_TABS[id]});});
  TABS.length=0;out.forEach(function(t){TABS.push(t);});
  if(!TABS.some(function(t){return t.id===activeTab;}))activeTab="sizing";
  for(var id in FIN_TABS){var p=panel(id);if(p)p.classList.toggle("active",on&&id===activeTab);}
  TABS.forEach(function(t){panel(t.id).classList.toggle("active",t.id===activeTab);});
}

/* ── prices ── */
function finEachUnit(fn){
  var n=0;
  [UNITS,SZ_UNITS,model.sizing&&model.sizing.units].forEach(function(list){
    if(Array.isArray(list))list.forEach(function(u){if(fn(u))n++;});});
  return n;
}
function finPriceUnit(u){
  if(!u||(u.cost!=null&&!u.finCost))return false;          /* a price the site file carries wins */
  var b=FIN.book,p=b&&b.units&&b.units[u.id],v;
  if(u.finCost==="new")v=(b&&b.new_unit_price!=null)?+b.new_unit_price:null;
  else v=(p&&p.price!=null)?+p.price:null;
  if(v==null){if(!u.finCost)return false;u.cost=null;delete u.finCost;return true;}
  if(u.cost===v)return false;
  u.cost=v;if(!u.finCost)u.finCost="book";return true;
}
/* install and O&M defaults: fill a blank (0) figure, or one still at the previous book's default */
function finDefaults(e,prev){
  var d=(FIN.book&&FIN.book.defaults)||{},pd=(prev&&prev.defaults)||{},ch=false;
  if(!e)return false;
  [["installCost","install_usd"],["omUSD","om_usd_per_yr"]].forEach(function(k){
    var v=d[k[1]],cur=+e[k[0]]||0;
    if(v==null)return;
    if((cur===0||(pd[k[1]]!=null&&cur===+pd[k[1]]))&&cur!==+v){e[k[0]]=+v;ch=true;}});
  if(ch)e.capexUSD=(+e.batteryCost||0)+(+e.installCost||0);
  return ch;
}
function finApply(prev){
  var n=finEachUnit(finPriceUnit);
  if(finDefaults(model.economics,prev))n++;
  return n>0;
}
/* the selected system as [{id,n}]: the hand-built mix, else the sized unit */
function finSystem(){
  var mx=sizeMixOf();
  if(mx)return mx.filter(function(m){return m&&szUnitExists(m.id);}).map(function(m){return {id:m.id,n:Math.max(1,Math.round(+m.n||1))};});
  var s=model.sizing||{};
  return (s.unit&&szUnitExists(s.unit))?[{id:s.unit,n:Math.max(1,Math.round(+s.nUnits||1))}]:[];
}
function finSystemCost(){
  var sys=finSystem(),c=0;if(!sys.length)return null;
  for(var i=0;i<sys.length;i++){var u=unitById(sys[i].id);if(!u||u.cost==null)return null;c+=u.cost*sys[i].n;}
  return c;
}
/* monthly service fee from the book's rental rates, while the deal has no fee of its own */
function finRentalFee(){
  var sys=finSystem(),fee=0;if(!FIN.on||!sys.length)return null;
  for(var i=0;i<sys.length;i++){var p=FIN.book.units&&FIN.book.units[sys[i].id];
    if(!p||p.rental_per_month==null)return null;fee+=p.rental_per_month*sys[i].n;}
  return fee;
}
function finRentalSync(){
  var e=model.economics;if(!FIN.on||!e)return;
  if(+e.monthlyRentalUSD>0&&!e.rentalFromBook)return;      /* a fee typed for this deal wins */
  var fee=finRentalFee();
  if(fee==null){if(e.rentalFromBook){e.monthlyRentalUSD=0;e.rentalFromBook=false;}return;}
  e.monthlyRentalUSD=fee;e.rentalFromBook=true;
}

/* ── hooks into the workbench ── */
/* syncUnitCost prices only a single unit (a hand-built mix fell back to catalog unit #0); price the mix too */
var finSyncUnitCost0=syncUnitCost;
syncUnitCost=function(){
  var mx=sizeMixOf(),e=model.economics;
  if(mx&&e){
    var cost=finSystemCost();
    if(cost!=null&&cost>0){e.batteryCost=cost;e.capexUSD=cost+(+e.installCost||0);}
  }else finSyncUnitCost0();
  finRentalSync();
};
var finAdopt0=adoptSaved;
adoptSaved=function(obj){
  var r=finAdopt0(obj);
  if(FIN.on){finModeBack();if(finApply()){try{computeSizing();}catch(e){}}}
  return r;
};
var finBlankEconomics0=blankEconomics;
blankEconomics=function(){var e=finBlankEconomics0();if(FIN.on)finDefaults(e);return e;};
var finOnEcon0=onEcon;
onEcon=function(field,v){
  if(field==="monthlyRentalUSD"&&model.economics)model.economics.rentalFromBook=false;
  return finOnEcon0(field,v);
};
var finOnUnitAdd0=onUnitAdd;
onUnitAdd=function(){
  finOnUnitAdd0();
  var u=SZ_UNITS&&SZ_UNITS[SZ_UNITS.length-1];
  if(FIN.on&&u&&u.cost==null&&FIN.book.new_unit_price!=null){u.finCost="new";finPriceUnit(u);szUnitsPersist();computeSizing();renderSizing();}
};
function finNote(id,cls,html){
  var host=panel(id);if(!host)return;
  var d=document.createElement("div");d.className="callout fin-note no-print"+(cls?" "+cls:"");d.innerHTML=html;
  host.insertBefore(d,host.firstChild);
}
function finAfterRender(id){
  if(!FIN.on)return;
  if(id==="economics"){
    var e=model.economics,parts=[];
    if(finSystemCost()!=null)parts.push("battery cost");
    if(+e.installCost)parts.push("install");
    if(+e.omUSD)parts.push("O&amp;M");
    if(e.rentalFromBook)parts.push("the monthly service fee");
    if(parts.length)finNote(id,"",'<p class="small" style="margin:0">Starting figures for '+
      (parts.length>1?parts.slice(0,-1).join(", ")+" and "+parts[parts.length-1]:parts[0])+' come from the team price book (updated '+
      esc(FIN.book.updated||"—")+(FIN.edited?', edited in this session':'')+'). Change any of them below for this deal.</p>');
  }
  if(model.tariffs&&model.tariffs.mode==="peak-shave")
    finNote(id,"warn",'<p class="small" style="margin:0"><b>No dollar savings yet.</b> This site is in peak-shave (kW only) mode. On '+
      '<a href="#" onclick="setTab(\'tariffs\');return false;">Tariffs &amp; Bills</a>, choose <b>$/kW — Demand charge</b> (or TOU) '+
      'and enter the monthly bills to value the savings.</p>');
}
["revenue","economics","summary"].forEach(function(id){
  var name="render"+id.charAt(0).toUpperCase()+id.slice(1),f0=window[name];
  window[name]=function(){var r=f0.apply(this,arguments);try{finAfterRender(id);}catch(e){}return r;};
});

/* ── lock / unlock ── */
function finStart(book,key){
  FIN.book=book;FIN.key=key;FIN.on=true;
  finModeBack();finApply();finSetTabs(true);
  try{computeSizing();}catch(e){}
  try{syncUnitCost();}catch(e){}
  renderAll();finButton();
}
function finLock(){
  var e=model.economics,b=FIN.book,d=(b&&b.defaults)||{};
  if(e){
    var sys=finSystemCost();
    if(sys!=null&&+e.batteryCost===sys)e.batteryCost=0;
    if(d.install_usd!=null&&+e.installCost===+d.install_usd)e.installCost=0;
    if(d.om_usd_per_yr!=null&&+e.omUSD===+d.om_usd_per_yr)e.omUSD=0;
    if(e.rentalFromBook){e.monthlyRentalUSD=0;e.rentalFromBook=false;}
    e.capexUSD=(+e.batteryCost||0)+(+e.installCost||0);
  }
  finEachUnit(function(u){if(u&&u.finCost){u.cost=null;delete u.finCost;return true;}return false;});
  finForget();
  FIN.on=false;FIN.book=null;FIN.key=null;FIN.edited=false;FIN.env=FIN_ENV;
  finKwOnly();finSetTabs(false);
  try{computeSizing();}catch(e2){}
  renderAll();finClose();finButton();
}
function finRemember(key){
  var salt=FIN.env.salt;
  crypto.subtle.exportKey("raw",key).then(function(raw){
    try{localStorage.setItem(FIN_KEY_STORE,JSON.stringify({salt:salt,k:finLetters(new Uint8Array(raw))}));FIN.remembered=true;}catch(e){}});
}
function finForget(){try{localStorage.removeItem(FIN_KEY_STORE);}catch(e){}FIN.remembered=false;}
function finAutoUnlock(){
  var s=null;
  try{s=JSON.parse(localStorage.getItem(FIN_KEY_STORE)||"null");}catch(e){}
  if(!s||!s.k||s.salt!==FIN.env.salt||!window.crypto||!crypto.subtle)return;
  crypto.subtle.importKey("raw",finBytes(s.k),{name:"AES-GCM"},true,["encrypt","decrypt"]).then(function(key){
    return finOpen(FIN.env,key).then(function(book){FIN.remembered=true;finStart(book,key);});
  }).catch(function(){finForget();});
}
function finTryUnlock(){
  var pass=document.getElementById("finPass").value,rem=document.getElementById("finRemember").checked;
  if(FIN.busy)return;
  if(!pass){finMsg("Enter the passphrase.",true);return;}
  if(!window.crypto||!crypto.subtle){finMsg("This browser cannot decrypt here: open the page over https or as a local file.",true);return;}
  FIN.busy=true;finMsg("Unlocking…");
  var env=FIN.env,key=null;
  finDerive(pass,env).then(function(k){key=k;return finOpen(env,k);}).then(function(book){
    FIN.busy=false;
    if(rem)finRemember(key);else finForget();
    finClose();finStart(book,key);
  },function(){
    FIN.busy=false;finMsg("That passphrase does not open this price book.",true);
    var p=document.getElementById("finPass");if(p)p.select();
  });
}
function finLoadFile(file){
  if(!file)return;
  var r=new FileReader();
  r.onload=function(){
    try{
      var env=JSON.parse(r.result);
      if(!env||env.format!=="atlas-pricebook"||!env.salt||!env.iv||!env.data||!(env.iterations>0))throw new Error("format");
      finBytes(env.salt);finBytes(env.iv);finBytes(env.data);
      FIN.env=env;finMsg("Loaded "+file.name+". Enter its passphrase to unlock it.");
    }catch(e){finMsg(file.name+" is not an Atlas price book.",true);}
  };
  r.readAsText(file);
}

/* ── the Prices button and dialog ── */
function finButton(){
  var b=document.getElementById("finBtn");
  if(!b){
    var bar=document.querySelector(".toolbtns");if(!bar)return;
    b=document.createElement("button");b.id="finBtn";b.type="button";b.className="btn ghost fin-btn";b.onclick=finDialog;
    bar.insertBefore(b,bar.querySelector('[onclick^="openHelp"]'));
  }
  b.classList.toggle("on",FIN.on);
  b.innerHTML=FIN.on?'<span class="fin-dot" aria-hidden="true"></span>Prices on':'Unlock prices';
  b.title=FIN.on?"Team price book unlocked: view, edit or lock it":"Enter the team passphrase to turn on prices and the financial tabs";
}
function finModal(){
  var m=document.getElementById("fin-modal");
  if(!m){
    m=document.createElement("div");m.id="fin-modal";m.className="help-modal fin-modal no-print";
    m.setAttribute("role","dialog");m.setAttribute("aria-modal","true");m.setAttribute("aria-labelledby","finTitle");
    m.addEventListener("click",function(ev){if(ev.target===m)finClose();});
    m.addEventListener("keydown",function(ev){if(ev.key==="Escape")finClose();});
    document.body.appendChild(m);
  }
  return m;
}
function finClose(){
  var m=document.getElementById("fin-modal");
  if(m&&m.classList.contains("open")){m.classList.remove("open");document.body.style.overflow="";
    var b=document.getElementById("finBtn");if(b)b.focus();}
}
function finMsg(t,bad){var el=document.getElementById("finMsg");if(el){el.textContent=t;el.classList.toggle("bad",!!bad);}}
function finHead(title){
  return '<div class="fin-head"><h2 id="finTitle">'+title+'</h2><button class="help-close" type="button" aria-label="Close" onclick="finClose()">&times;</button></div>';
}
function finDialog(){
  var m=finModal();
  m.innerHTML='<div class="help-inner">'+(FIN.on?finEditorHTML():finUnlockHTML())+'</div>';
  m.classList.add("open");document.body.style.overflow="hidden";
  if(FIN.on){var f=m.querySelector("input");if(f)f.focus();return;}
  m.querySelector("form").addEventListener("submit",function(ev){ev.preventDefault();finTryUnlock();});
  m.querySelector("#finFile").addEventListener("change",function(ev){finLoadFile(ev.target.files[0]);ev.target.value="";});
  m.querySelector("#finPass").focus();
}
function finUnlockHTML(){
  return finHead("Unlock prices")+
    '<p class="hint">Unit prices are kept in an encrypted price book inside this page. The team passphrase turns on prices, '+
    'rental and purchase economics, and the Tariffs &amp; Bills, Revenue, Deal Economics and Summary tabs.</p>'+
    '<form autocomplete="off">'+
      '<label class="fin-lbl" for="finPass">Team passphrase</label>'+
      '<input id="finPass" type="password" autocomplete="current-password" spellcheck="false"/>'+
      '<label class="fin-check"><input id="finRemember" type="checkbox" checked/> Remember on this device (not on a shared computer)</label>'+
      '<div class="fin-actions"><button class="btn solid" type="submit">Unlock</button>'+
      '<span class="fin-msg" id="finMsg" role="status" aria-live="polite"></span></div>'+
    '</form>'+
    '<details class="fin-more"><summary>Use a different price book file</summary>'+
      '<p class="hint">To try a new price book before it is published: choose its <code>pricebook.enc.json</code>, then unlock it with its passphrase. '+
      'It applies until the page is reloaded.</p><input type="file" id="finFile" accept=".json,application/json"/></details>';
}
function finNum(v){return v==null?"":String(v);}
function finInput(k,v,label,step){
  return '<input type="number" min="0" step="'+(step||1)+'" data-k="'+k+'" aria-label="'+esc(label)+'" value="'+esc(finNum(v))+'"/>';
}
function finEditorHTML(){
  var b=FIN.book,units=b.units||{},ids=[],d=b.defaults||{};
  UNITS.forEach(function(u){ids.push(u.id);});
  Object.keys(units).forEach(function(id){if(ids.indexOf(id)<0)ids.push(id);});
  var rows=ids.map(function(id){
    var u=units[id]||{},cat=null;UNITS.forEach(function(x){if(x.id===id)cat=x;});
    var name=cat?cat.label:id;
    return '<tr data-id="'+esc(id)+'"><td>'+esc(name)+(cat?'':' <span class="small muted">(not in this catalog)</span>')+'</td>'+
      '<td class="num">'+finInput("price",u.price,name+" price",100)+'</td>'+
      '<td class="num">'+finInput("trailer_price",u.trailer_price,name+" trailer-mounted price",100)+'</td>'+
      '<td class="num">'+finInput("rental_per_month",u.rental_per_month,name+" monthly rental",10)+'</td></tr>';
  }).join("");
  return finHead("Price book")+
    '<p class="hint">Updated '+esc(b.updated||"—")+(FIN.edited?', edited in this session':'')+'. '+
      'Prices fill the unit catalog and the Deal Economics starting figures; a price a site file already carries is kept. '+
      'Rental rates set the monthly service fee until one is typed for the deal. Leave a box blank for no price. '+
      (FIN.remembered?'Unlocked on this device until you lock it.':'Unlocked until this page is closed.')+'</p>'+
    '<div class="fin-scroll"><table class="tbl fin-tbl"><thead><tr><th>Unit</th><th class="num">Price ($)</th>'+
      '<th class="num">Trailer-mounted ($)</th><th class="num">Rental ($/mo)</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
    '<p class="small muted" style="margin:6px 0 0">Trailer-mounted prices are for reference: type one into Deal Economics → Battery unit cost when the deal uses that option.</p>'+
    '<div class="dgrid fin-defaults" data-defaults="1">'+
      '<div class="field"><label>Install cost ($)</label>'+finInput("install_usd",d.install_usd,"Install cost default",100)+'</div>'+
      '<div class="field"><label>O&amp;M ($/yr)</label>'+finInput("om_usd_per_yr",d.om_usd_per_yr,"O&M default",50)+'</div>'+
      '<div class="field"><label>New unit type ($)</label>'+finInput("new_unit_price",b.new_unit_price,"Price of a newly added unit type",100)+'</div>'+
    '</div>'+
    '<div class="fin-actions"><button class="btn solid" type="button" onclick="finApplyEdits()">Apply</button>'+
      '<button class="btn" type="button" onclick="finDownload()">Download encrypted price book</button>'+
      '<span class="fin-spacer"></span><button class="btn" type="button" onclick="finLock()">Lock</button></div>'+
    '<p class="fin-msg" id="finMsg" role="status" aria-live="polite"></p>'+
    '<p class="hint">Apply changes prices in this browser until the page is reloaded. To change them for the team, download the encrypted price book '+
      '(it opens with the same passphrase) and replace <code>assets/workbench/pricebook.enc.json</code> in the repository (docs/WORKBENCH.md).</p>';
}
/* the editor's figures as a new book, or null if a box holds something other than a blank or a number ≥ 0 */
function finReadEditor(){
  var m=document.getElementById("fin-modal"),b=JSON.parse(JSON.stringify(FIN.book)),bad=false;
  b.units=b.units||{};b.defaults=b.defaults||{};
  function val(inp){
    var s=inp.value.trim(),n=+s;
    if(s==="")return null;
    if(!isFinite(n)||n<0){bad=true;inp.classList.add("bad");return null;}
    inp.classList.remove("bad");return n;
  }
  m.querySelectorAll("tr[data-id]").forEach(function(tr){
    var id=tr.getAttribute("data-id"),u=b.units[id]||(b.units[id]={price:null,rental_per_month:null});
    tr.querySelectorAll("input[data-k]").forEach(function(inp){
      var k=inp.getAttribute("data-k"),n=val(inp);
      if(n==null&&k==="trailer_price")delete u[k];else u[k]=n;});
  });
  m.querySelectorAll("[data-defaults] input[data-k]").forEach(function(inp){
    var k=inp.getAttribute("data-k"),n=val(inp);
    if(k==="new_unit_price")b.new_unit_price=n;else b.defaults[k]=n;});
  return bad?null:b;
}
function finApplyEdits(){
  var b=finReadEditor();
  if(!b){finMsg("Each box must be blank or a number of 0 or more.",true);return false;}
  if(JSON.stringify(b)===JSON.stringify(FIN.book)){finMsg("No changes to apply.");return true;}
  var prev=FIN.book;
  b.updated=new Date().toISOString().slice(0,10);
  FIN.book=b;FIN.edited=true;
  finApply(prev);
  try{computeSizing();}catch(e){}
  try{syncUnitCost();}catch(e){}
  renderAll();
  finMsg("Applied to this session.");
  return true;
}
function finDownload(){
  if(!finApplyEdits())return;
  finSeal(FIN.book,FIN.key,FIN.env).then(function(env){
    var blob=new Blob([JSON.stringify(env,null,2)+"\n"],{type:"application/json"});
    var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="pricebook.enc.json";
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){URL.revokeObjectURL(a.href);},2000);
    finMsg("Downloaded pricebook.enc.json.");
  },function(){finMsg("Could not encrypt the price book in this browser.",true);});
}

finButton();
finAutoUnlock();
