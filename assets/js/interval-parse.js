// Meter interval-file parsing and analysis, ported VERBATIM from the Site Analysis Workbench
// (its PARSE / DERIVE and XLSX modules). This is deliberately left in the workbench's own style and
// not reformatted, so any difference from the original can be found with a plain diff. Parity is
// checked against the workbench itself in a real browser, and tests/interval-ingest.test.mjs pins the
// behaviours its self-tests cover (units, multi-meter, split date/time, preamble, DST, multi-year).
//
// What changed from the original, and nothing else:
//   - the functions no longer read or write the workbench's globals (RAW, model, FILE, DET): buildRAW
//     returns RAW, deriveAnalysis takes RAW and returns the analysis, dedupRAWMonths takes RAW;
//   - the UI-only parts (alerts, tab changes, charts) are not here; see interval-ingest.js.
/* eslint-disable */

function lmOf(t){return ((((t.getFullYear()*12)+t.getMonth())*31+(t.getDate()-1))*1440)+t.getHours()*60+t.getMinutes();}
function lmTo(v){var mi=v%60;v=(v-mi)/60;var h=v%24;v=(v-h)/24;var d=v%31;v=(v-d)/31;var mo=v%12;var y=(v-mo)/12;
  return new Date(y,mo,d+1,h,mi,0,0);}
function edEncodeRaw(R){
  if(!R||!R.times||!R.times.length)return null;
  var n=R.times.length,b=lmOf(R.times[0]),runs=[],prev=b,cnt=0,cur=null;
  for(var i=1;i<n;i++){var v=lmOf(R.times[i]),dv=v-prev;prev=v;
    if(cur===null){cur=dv;cnt=1;}
    else if(dv===cur)cnt++;
    else{runs.push([cnt,cur]);cur=dv;cnt=1;}}
  if(cur!==null)runs.push([cnt,cur]);
  var kw=new Array(n);
  for(var j=0;j<n;j++){var x=+R.kw[j];kw[j]=isFinite(x)?Math.round(x*1e4)/1e4:0;}
  return {v:1,n:n,dt:R.intervalMin,b:b,r:runs,kw:kw};
}
function edDecodeRaw(o){
  if(!o||o.v!==1||!o.n||!o.kw||o.kw.length!==o.n)return null;
  var times=new Array(o.n),cur=o.b,k=0;
  times[0]=lmTo(cur);k=1;
  var runs=o.r||[];
  for(var i=0;i<runs.length;i++){var c=runs[i][0],dv=runs[i][1];
    for(var j=0;j<c&&k<o.n;j++){cur+=dv;times[k++]=lmTo(cur);}}
  if(k!==o.n)return null;                                  /* run lengths disagree with n -- reject rather than guess */
  for(var q=0;q<o.n;q++){if(!times[q]||isNaN(times[q].getTime()))return null;}
  return {times:times,kw:o.kw.slice(),intervalMin:o.dt||15};
}

function detectDelim(text){
  var line=text.split(/\r?\n/)[0]||"";
  var c={",":0,"\t":0,";":0};
  for(var i=0;i<line.length;i++){if(c[line[i]]!=null)c[line[i]]++;}
  var best=",",bn=-1;for(var k in c){if(c[k]>bn){bn=c[k];best=k;}}return best;
}
function parseCSV(text,delim){
  delim=delim||",";var rows=[],lines=text.split(/\r?\n/);
  for(var L=0;L<lines.length;L++){
    var line=lines[L];if(line==="")continue;
    var out=[],cur="",q=false;
    for(var i=0;i<line.length;i++){var ch=line[i];
      if(q){if(ch==='"'){if(line[i+1]==='"'){cur+='"';i++;}else q=false;}else cur+=ch;}
      else{if(ch==='"')q=true;else if(ch===delim){out.push(cur);cur="";}else cur+=ch;}
    }
    out.push(cur);rows.push(out);
  }
  return rows;
}
function parseDT(s){
  if(s==null)return null;
  if(s instanceof Date)return isNaN(s.getTime())?null:s;   /* canonical XLSX rows carry Dates */
  if(typeof s==="number")return null;                       /* bare numbers are values, not dates */
  s=String(s).replace(/ /g," ").trim();
  if(!s)return null;
  if(/^[\d\.,$ ]+$/.test(s))return null;                    /* "6.11" must not parse as June 11 */
  /* manual M/D/YYYY [H:MM[:SS]][AM/PM] — utility exports are US-ordered; handles "12:15AM" */
  var m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?\s*$/i);
  if(m){var yr=+m[3];if(yr<100)yr+=2000;
    var hh=+(m[4]||0);
    if(m[7]){var ap=m[7].toUpperCase();if(ap==="PM"&&hh<12)hh+=12;if(ap==="AM"&&hh===12)hh=0;}
    var d=new Date(yr,(+m[1])-1,+m[2],hh,+(m[5]||0),+(m[6]||0));
    return isNaN(d.getTime())?null:d;}
  /* ISO yyyy-mm-dd[ T]hh:mm[:ss] by hand: new Date("2025-01-01") is UTC midnight, i.e. 19:00 the PREVIOUS evening in a
     US time zone, which shifted every date-only ISO stamp back a day (and spawned a phantom December month) */
  var iso=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*$/);
  if(iso){var iM=+iso[2],iD=+iso[3],iH=+(iso[4]||0);
    if(iM<1||iM>12||iD<1||iD>31||iH>23)return null;
    var d3=new Date(+iso[1],iM-1,iD,iH,+(iso[5]||0),+(iso[6]||0));
    return isNaN(d3.getTime())?null:d3;}
  var d2=new Date(s);
  if(!isNaN(d2.getTime()))return d2;
  return null;
}
/* "12:15AM" / "0:15" / "00:15:00" / Excel fraction → minutes past midnight, or -1 */
function parseTimeOfDay(s){
  if(s==null)return -1;
  if(typeof s==="number"){return (s>=0&&s<1)?Math.round(s*1440):-1;}
  s=String(s).replace(/ /g," ").trim();
  var m=s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if(!m)return -1;
  var hh=+m[1],mi=+m[2];
  if(m[4]){var ap=m[4].toUpperCase();if(ap==="PM"&&hh<12)hh+=12;if(ap==="AM"&&hh===12)hh=0;}
  if(hh>23||mi>59)return -1;
  return hh*60+mi;
}
/* Excel date serial → local wall-clock Date (epoch 1899-12-30; keeps meter local time) */
function serialToDate(n){
  var ms=Math.round((n-25569)*86400000);
  var u=new Date(ms);
  return new Date(u.getUTCFullYear(),u.getUTCMonth(),u.getUTCDate(),u.getUTCHours(),u.getUTCMinutes(),u.getUTCSeconds());
}
function isNum(s){if(s==null)return false;var t=String(s).replace(/[\$, \s]/g,"");return t!==""&&isFinite(+t);}
function toNum(s){return +String(s).replace(/[\$, \s]/g,"");}

var UNIT_HDR=/(^|[^a-z])(unit|units|uom)\s*$|unit of measure/;   /* a header that NAMES a unit column ("Usage Unit", "Demand Unit", "UOM"), not a value */
function detectCols(rows){
  if(!rows.length)return null;
  var ncol=0;rows.forEach(function(r){ncol=Math.max(ncol,r.length);});
  /* header? first row mostly non-numeric & not dates */
  var first=rows[0],fnum=0,fdate=0;
  for(var c=0;c<first.length;c++){if(isNum(first[c]))fnum++;if(parseDT(first[c]))fdate++;}
  var hasHeader=(fnum===0&&fdate===0)||(fnum<=1&&fdate<=1&&first.length>1);
  var hdr=hasHeader?first.map(function(x){return String(x||"").toLowerCase();}):[];
  var rawHdr=hasHeader?first.map(function(x){return String(x==null?"":x).trim();}):[];   /* original case: "mWh" (milli) and "MWh" (mega) must stay distinguishable */
  var data=hasHeader?rows.slice(1):rows;
  var sample=data.slice(0,Math.min(60,data.length));
  /* per-column date & number ratios */
  var dateScore=[],numScore=[];
  for(var col=0;col<ncol;col++){var dn=0,nn=0,tot=0;
    for(var i=0;i<sample.length;i++){var v=sample[i][col];if(v==null||v==="")continue;tot++;
      if(parseDT(v))dn++;if(isNum(v))nn++;}
    dateScore[col]=tot?dn/tot:0;numScore[col]=tot?nn/tot:0;
  }
  var dt=-1,dbest=0;for(var c2=0;c2<ncol;c2++){if(dateScore[c2]>dbest){dbest=dateScore[c2];dt=c2;}}
  /* an id column can parse as a "date" too (V8's legacy parser reads "M-1" as one) and a Meter column usually sits BEFORE
     Date, so it would win the tie and every row would get the same day. Among the columns tied for the best score, skip id-like headers. */
  var ID_HDR=/meter|account|service|premise|(^|[^a-z])id([^a-z]|$)/;
  if(dt>=0&&hasHeader&&ID_HDR.test(hdr[dt]||"")){
    for(var c2b=0;c2b<ncol;c2b++){if(dateScore[c2b]===dbest&&!ID_HDR.test(hdr[c2b]||"")){dt=c2b;break;}}}
  /* value column: prefer header kw (not kwh), then kwh, else best numeric != dt */
  var val=-1,valueType="kW",vsrc="";   /* vsrc: how the unit was inferred — "kw"/"kwh" = the header literally says it; "implied" = a keyword like usage/demand but no unit; "" = nothing at all */
  if(hasHeader){
    for(var h=0;h<hdr.length;h++){if(/kw/.test(hdr[h])&&!/kwh|kw[\-\s]?h|kvarh|kvar/.test(hdr[h])&&!UNIT_HDR.test(hdr[h])){val=h;valueType="kW";vsrc="kw";break;}}
    if(val<0)for(var h2=0;h2<hdr.length;h2++){if(/kwh|kw[\-\s]?h|usage|consum|energy/.test(hdr[h2])&&!UNIT_HDR.test(hdr[h2])){val=h2;valueType="kWh";vsrc=/kwh|kw[\-\s]?h/.test(hdr[h2])?"kwh":"implied";break;}}
    if(val<0)for(var h3=0;h3<hdr.length;h3++){if(/demand|load|power/.test(hdr[h3])&&!UNIT_HDR.test(hdr[h3])){val=h3;valueType="kW";vsrc="implied";break;}}
  }
  if(val<0){for(var c3=0;c3<ncol;c3++){if(c3===dt)continue;if(numScore[c3]>0.7){val=c3;break;}}}
  if(val<0)val=(dt===0?1:0);
  /* SEPARATE TIME-OF-DAY COLUMN. Many utility exports split the stamp ("Date" | "Start Time"). The date column alone
     is then midnight for every row — 96 "duplicate timestamps" a day, every interval stacked at 00:00. Pair it with the
     time column, but only when the date column carries no time of its own and a text column is all clock times. */
  var tm=-1,dateOnly=dt>=0;
  if(dt>=0)for(var s1=0;s1<sample.length&&dateOnly;s1++){var dd=dt<sample[s1].length?parseDT(sample[s1][dt]):null;if(dd&&(dd.getHours()||dd.getMinutes()||dd.getSeconds()))dateOnly=false;}
  if(dateOnly){
    var todCols=[];
    for(var tc=0;tc<ncol;tc++){if(tc===dt||tc===val)continue;var tn=0,tt=0;
      for(var s2=0;s2<sample.length;s2++){var tv=sample[s2][tc];if(tv==null||tv==="")continue;tt++;if(typeof tv==="string"&&/:/.test(tv)&&parseTimeOfDay(tv)>=0)tn++;}
      if(tt>0&&tn/tt>0.9)todCols.push(tc);}
    for(var tp=0;tp<todCols.length&&tm<0;tp++){if(/start/.test(hdr[todCols[tp]]||""))tm=todCols[tp];}                 /* "Start Time" beats "End Time" */
    for(var tq=0;tq<todCols.length&&tm<0;tq++){if(!/end|stop|finish/.test(hdr[todCols[tq]]||""))tm=todCols[tq];}
  }
  /* UNIT. Decide kW vs kWh (and a Wh/MWh/W/MW scale) from what the FILE says, in this order: a "Usage Unit"-style column
     that belongs to the value column, then a unit in the value header's brackets, then the header words. Anything the
     file does not state is reported, never silently defaulted. */
  var unitCol=-1,unitScale=1,unitSrc="",unitAmbig="";
  function vcol(ci){return rawHdr[ci]||("column "+colLetter(ci));}
  if(hasHeader&&val>=0){
    var ucs=[];
    for(var uh=0;uh<hdr.length;uh++){if(uh!==val&&uh!==dt&&UNIT_HDR.test(hdr[uh]))ucs.push(uh);}
    var vstem=(hdr[val]||"").replace(/[^a-z]/g,"");
    for(var uq=0;uq<ucs.length&&unitCol<0;uq++){   /* "Usage Unit" pairs with "Usage"; "Demand Unit" with "Peak Demand" */
      var ustem=hdr[ucs[uq]].replace(/unit of measure|units|unit|uom|[^a-z]/g,"");
      if(ustem&&vstem.indexOf(ustem)>=0)unitCol=ucs[uq];}
    if(unitCol<0&&ucs.length===1&&!hdr[ucs[0]].replace(/unit of measure|units|unit|uom|[^a-z]/g,""))unitCol=ucs[0];   /* a bare "Unit" column */
    if(unitCol<0&&ucs.length)unitAmbig="The file has unit column(s) ("+ucs.map(vcol).join(", ")+") but none can be matched to the value column \""+vcol(val)+"\" — unit NOT confirmed from the data.";
  }
  if(unitCol>=0){
    var uc={},unRec=0,unTot=0,unT=null;
    for(var ur=0;ur<data.length;ur++){var uv=data[ur][unitCol];if(uv==null)continue;uv=String(uv).trim();if(uv==="")continue;
      uc[uv]=(uc[uv]||0)+1;unTot++;}
    var ukeys=Object.keys(uc),utypes={},ubad=[];
    ukeys.forEach(function(k){var pu=parseUnitLabel(k);if(pu){utypes[pu.t+"|"+pu.k]=pu;}else ubad.push(k);});
    var utk=Object.keys(utypes);
    if(utk.length===1&&!ubad.length){
      unT=utypes[utk[0]];valueType=unT.t;unitScale=unT.k;
      unitSrc="the \""+vcol(unitCol)+"\" column says "+ukeys.join("/")+(unT.k!==1?" (×"+unT.k+" to "+unT.t+")":"");
      if((vsrc==="kw"&&unT.t!=="kW")||(vsrc==="kwh"&&unT.t!=="kWh"))
        unitAmbig="The header of \""+vcol(val)+"\" says "+(vsrc==="kw"?"kW":"kWh")+" but the \""+vcol(unitCol)+"\" column says "+ukeys.join("/")+" — the unit column was used; NOT confirmed, check the Value type override.";
    }else if(unTot>0){
      unitAmbig="The \""+vcol(unitCol)+"\" column holds "+(ukeys.length>1?"mixed":"unrecognised")+" units ("+ukeys.slice(0,6).map(function(k){return k+" ×"+uc[k];}).join(", ")+") — unit NOT confirmed; the value type below is only a guess from the header. Check it in the override.";
    }
  }
  if(unitCol<0&&hasHeader&&val>=0&&!unitAmbig){
    var bm=(rawHdr[val]||"").match(/[\(\[]\s*([A-Za-z][A-Za-z\s\/\-\._]{0,14})\s*[\)\]]/);
    var bu=bm?parseUnitLabel(bm[1]):null;
    if(bu){valueType=bu.t;unitScale=bu.k;unitSrc="the header \""+rawHdr[val]+"\" says "+bm[1].trim()+(bu.k!==1?" (×"+bu.k+" to "+bu.t+")":"");}
    else if(bm&&/^(kvar|kvarh|kva|kvah|mvar|mvarh)$/i.test(bm[1].replace(/[\s\-_.]/g,"")))
      unitAmbig="The header \""+rawHdr[val]+"\" is a reactive/apparent quantity, not kW or kWh — these values are NOT demand. Unit NOT confirmed.";
    else if(vsrc==="kw"||vsrc==="kwh")unitSrc="the header \""+rawHdr[val]+"\" says "+(vsrc==="kw"?"kW":"kWh");
  }
  if(!unitSrc&&!unitAmbig)
    unitAmbig=(vsrc==="implied"?"The unit of \""+vcol(val)+"\" is not stated in the file":"No unit or kW/kWh header was found for the value column")+" — assumed "+(valueType==="kWh"?"kWh per interval (converted to kW)":"kW (demand)")+". NOT confirmed: if that is wrong, change Value type in the override.";
  /* METER COLUMN (low-cardinality id column such as Meter / Account / Service Agreement). buildRAW decides what to keep. */
  var meterCol=-1;
  if(hasHeader)for(var mh=0;mh<hdr.length;mh++){if(mh===val||mh===dt||mh===tm||mh===unitCol)continue;
    if(/meter|account|service\s*(agreement|point)|premise/.test(hdr[mh])&&!/read|register|unit|date|time|type/.test(hdr[mh])){meterCol=mh;break;}}
  /* interval minutes: median consecutive diff on the timestamp */
  var times=[];for(var i2=0;i2<sample.length&&times.length<40;i2++){var d=rowStamp(sample[i2],dt,tm);if(d)times.push(d.getTime());}
  var diffs=[];for(var t=1;t<times.length;t++){var dm=(times[t]-times[t-1])/60000;if(dm>0)diffs.push(dm);}
  diffs.sort(function(a,b){return a-b;});
  var im=diffs.length?diffs[Math.floor(diffs.length/2)]:15;
  [5,10,15,30,60].forEach(function(std){if(Math.abs(im-std)<=2)im=std;});
  im=Math.max(1,Math.round(im));
  return {dt:dt,val:val,valueType:valueType,intervalMin:im,hasHeader:hasHeader,ncol:ncol,headers:hdr,
    tm:tm,unitCol:unitCol,unitScale:unitScale,unitSrc:unitSrc,unitAmbig:unitAmbig,meterCol:meterCol,rawHeaders:rawHdr,
    warnings:unitAmbig?[unitAmbig]:[]};
}
/* One-line, plain-language account of how a CSV was read — shown on the Interval tab so nothing is silent */
function csvNoteOf(det){
  if(!det||det.dt==null||det.dt<0)return "";
  function nm(ci){var h=(det.rawHeaders||[])[ci];return "col "+colLetter(ci)+(h?' ("'+h+'")':"");}
  var im=det.intervalMin,p=["Timestamp: "+nm(det.dt)+(det.tm>=0?" + "+nm(det.tm):"")];
  p.push("Value: "+nm(det.val)+" as "+(det.valueType==="kWh"?"energy per "+im+"-min interval (kWh), converted to kW (× "+(60/im)+")":"kW demand"));
  if(det.unitSrc)p.push("Unit: "+det.unitSrc);
  else if(det.unitAmbig)p.push("Unit NOT confirmed (see warning)");
  if(det.meterNote)p.push(det.meterNote);
  if(det.preamble>0)p.push("Skipped "+det.preamble+" preamble line(s) above the header");
  return p.join(" · ");
}
/* Unit label -> {t:"kWh"|"kW", k:multiplier into kWh/kW}, or null when it is not an energy/power unit we can convert.
   Case/spacing-insensitive, EXCEPT a leading lowercase "m" (mWh/mW = milli, MWh/MW = mega): that is ambiguous in
   lower case, so it is refused rather than guessed. kVARh/kVAh/kVA are reactive/apparent, not demand: unrecognised. */
function parseUnitLabel(s){
  var raw=String(s==null?"":s).trim().replace(/[\s_\-\.\/]/g,"");
  if(!raw||/^m[wW]|^milli/.test(raw))return null;
  var T={kwh:["kWh",1],kwhr:["kWh",1],kwhrs:["kWh",1],kilowatthour:["kWh",1],kilowatthours:["kWh",1],
         wh:["kWh",0.001],watthour:["kWh",0.001],watthours:["kWh",0.001],
         mwh:["kWh",1000],megawatthour:["kWh",1000],megawatthours:["kWh",1000],
         kw:["kW",1],kilowatt:["kW",1],kilowatts:["kW",1],
         w:["kW",0.001],watt:["kW",0.001],watts:["kW",0.001],
         mw:["kW",1000],megawatt:["kW",1000],megawatts:["kW",1000]};
  var k=raw.toLowerCase();
  return T.hasOwnProperty(k)?{t:T[k][0],k:T[k][1]}:null;
}
/* timestamp of one row: the date/time column, plus a separate time-of-day column when the export splits them */
function rowStamp(row,dt,tm){
  var d=parseDT(row[dt]);
  if(!d||tm==null||tm<0)return d;
  var mins=parseTimeOfDay(row[tm]);
  if(mins<0)return null;
  return new Date(d.getFullYear(),d.getMonth(),d.getDate(),0,mins,0);
}
/* utility CSV exports bury the header under a preamble (Name / Address / Account Number ...). Find it the way the XLSX
   path does (best keyword-scoring row in the first 60) but only act when it is BELOW row 0, so a file whose header is
   its first row takes exactly the legacy path. Returns the number of preamble rows to drop. */
function findHeaderRow(rows){
  var KEY=/^(start|date|time|end|kwh|kw\b|demand|usage|consum|energy|interval|meter|account|hour|period|reading|season|week)/i;
  var hr=-1,hbest=1;
  for(var r=0;r<Math.min(60,rows.length);r++){
    var sc=0;
    rows[r].forEach(function(c){if(typeof c==="string"&&c.trim()&&KEY.test(c.trim()))sc++;});
    if(sc>=2&&sc>hbest){hbest=sc;hr=r;}
  }
  return hr>0?hr:0;
}
/* MULTI-METER: when one export interleaves several meters (an id column with >1 distinct values) mixing them corrupts
   every peak, so keep ONE meter and say which — the same rule the XLSX path applies. Most rows wins; a tie goes to the
   meter carrying the most energy: a dormant all-zero meter can tie a live one on row count, and picking it would zero
   the whole analysis. ids/vals are parallel arrays. */
function pickDominantMeter(ids,vals){
  var n={},e={},order=[],i,id;
  for(i=0;i<ids.length;i++){id=ids[i];if(id==null||id==="")continue;
    if(n[id]==null){n[id]=0;e[id]=0;order.push(id);}n[id]++;e[id]+=Math.abs(vals[i]);}
  var best=order.length?order[0]:null,total=0,etot=0;
  order.forEach(function(k){total+=n[k];etot+=e[k];if(n[k]>n[best]||(n[k]===n[best]&&e[k]>e[best]))best=k;});
  return {ids:order,best:best,rows:n,energy:e,total:total,etotal:etot};
}

function colLetter(i){var s="";i=+i;do{s=String.fromCharCode(65+(i%26))+s;i=Math.floor(i/26)-1;}while(i>=0);return s;}

/* build RAW (times[], kw[]) from FILE.rows using chosen columns */
function buildRAW(rows,det){
  var RAW;
  var data=det.hasHeader?rows.slice(1):rows;
  var times=[],kw=[],ids=[],ih=det.intervalMin/60,usc=det.unitScale||1,
      mc=(det.meterCol!=null&&det.meterCol>=0&&det.meterCol!==det.val&&det.meterCol!==det.dt&&det.meterCol!==det.tm)?det.meterCol:-1,bad=0;
  for(var i=0;i<data.length;i++){
    var d=rowStamp(data[i],det.dt,det.tm);var raw=data[i][det.val];
    if(!d||!isNum(raw)){if(data[i].some(function(c){return c!=null&&String(c).trim()!=="";}))bad++;continue;}
    var v=toNum(raw)*usc;                   /* Wh/MWh/W/MW → kWh/kW (×1 when the unit is already kWh/kW) */
    if(det.valueType==="kWh")v=v/ih;        /* energy → average kW over the interval */
    times.push(d);kw.push(v);if(mc>=0)ids.push(String(data[i][mc]==null?"":data[i][mc]).trim());
  }
  /* this call's own notes/warnings are rebuilt on every run (Re-process used to stack duplicates of them) */
  det.warnings=(det.warnings||[]).filter(function(w){return !det._bw||det._bw.indexOf(w)<0;});
  var baseN=det.warnings.length;det.meterNote="";
  if(mc>=0&&times.length){
    var pm=pickDominantMeter(ids,kw);
    if(pm.ids.length>25){/* not an id column (a counter / reading) — leave the data alone */}
    else if(pm.ids.length===1)det.meterNote="Meter/account: "+pm.best+" (the only one in the file)";
    else if(pm.ids.length>1){
      var kt=[],kk=[],dropBlank=0;
      for(var mi=0;mi<times.length;mi++){if(ids[mi]===pm.best){kt.push(times[mi]);kk.push(kw[mi]);}else if(ids[mi]==="")dropBlank++;}
      var others=pm.ids.filter(function(k){return k!==pm.best;}).map(function(k){return k+" ("+pm.rows[k]+" rows, "+(pm.etotal?Math.round(100*pm.energy[k]/pm.etotal):0)+"% of the usage)";});
      det.meterNote="Meter/account: "+pm.best+" (kept) of "+pm.ids.length+" in the file";
      det.warnings.push("Multiple meters/accounts in file — using "+pm.best+" ("+pm.rows[pm.best]+" of "+pm.total+" rows, "+(pm.etotal?Math.round(100*pm.energy[pm.best]/pm.etotal):0)+"% of the usage). Not used: "+others.join("; ")+". Other meters are NOT added to the load — import them separately."+(dropBlank?" "+dropBlank+" row(s) with no meter id were dropped.":""));
      times=kt;kw=kk;
    }
  }
  if(bad>0&&bad>data.length*0.02)det.warnings.push(bad+" rows skipped (missing or invalid timestamp/value).");
  /* sort by time (some exports are unordered) */
  var idx=times.map(function(_,i){return i;});
  idx.sort(function(a,b){return times[a]-times[b];});
  RAW={times:idx.map(function(i){return times[i];}),kw:idx.map(function(i){return kw[i];}),intervalMin:det.intervalMin};
  dedupRAWMonths(RAW);                                /* A3: multi-year files blend month-of-year buckets */
  /* cadence integrity — the kWh→kW conversion and daily averages assume a uniform cadence.
     Thresholds allow one DST transition: spring-forward = 1 gap, fall-back = one repeated
     hour of duplicate stamps. Anything beyond that is flagged honestly, never auto-fixed. */
  det.warnings=det.warnings||[];
  var step=det.intervalMin*60000,dup=0,gaps=0,gapMax=0,mixed=0,mixedEx=null,shortFillable=0;
  for(var g=1;g<RAW.times.length;g++){
    var dms=RAW.times[g]-RAW.times[g-1];
    if(dms===0){dup++;continue;}
    if(dms>step*1.5){
      gaps++;if(dms>gapMax)gapMax=dms;
      var missing=Math.round(dms/step)-1;            /* intervals absent in this gap */
      if(missing>0&&missing<=4)shortFillable+=missing;/* ≤4 intervals ≈ ≤1 h at 15-min */
      continue;
    }
    if(Math.abs(dms-step)>step*0.1){mixed++;if(mixedEx==null)mixedEx=Math.round(dms/60000);}
  }
  /* structured summary for the Detection Summary table (honest: counts only, nothing auto-fixed) */
  det.summary={
    rowsParsed:RAW.times.length,
    duplicates:dup,
    gaps:gaps,
    gapMaxH:gapMax/3600000,
    shortFillable:shortFillable,
    mixed:mixed,
    mixedEx:mixedEx
  };
  if(RAW.trimNote)det.warnings.push(RAW.trimNote);
  if(mixed>0)det.warnings.push("Mixed interval lengths: "+mixed+" interval(s) differ from the detected "+det.intervalMin+"-min cadence (e.g. "+mixedEx+" min). kWh→kW conversion and daily averages assume a uniform cadence — verify the export.");
  if(dup>Math.ceil(60/det.intervalMin))det.warnings.push(dup+" duplicate timestamps (more than a DST fall-back hour explains) — possibly a multi-meter export. Each reading is kept as its own interval; peaks may be understated if meters should be summed.");
  if(gaps>1)det.warnings.push(gaps+" gaps in the record (largest ≈ "+(gapMax/3600000).toFixed(1)+" h). Stats cover recorded intervals only.");
  det._bw=det.warnings.slice(baseN);                 /* remembered so the next buildRAW (Re-process) replaces rather than stacks them */
  return RAW;
}

/* A3 — the monthly analysis and CA sim key months 0-11, so a file spanning >12 months would
   blend e.g. Jan-2024 with Jan-2025 (mixed peaks, doubled energy, wrong worst days). Keep only
   the most complete (year,month) instance of each calendar month; ties prefer the newer year.
   No-op (returns 0) for files within a single year of data. Sets RAW.trimNote when it trims. */
function dedupRAWMonths(RAW){
  if(!RAW||!RAW.times.length)return 0;
  RAW.trimNote=null;
  var cnt={},t,k;
  for(t=0;t<RAW.times.length;t++){k=RAW.times[t].getFullYear()*12+RAW.times[t].getMonth();cnt[k]=(cnt[k]||0)+1;}
  var best={},multi=false;
  for(k in cnt){var mo=k%12;
    if(best[mo]==null)best[mo]=+k;
    else{multi=true;if(cnt[k]>cnt[best[mo]]||(cnt[k]===cnt[best[mo]]&&+k>best[mo]))best[mo]=+k;}}
  if(!multi)return 0;
  var keepT=[],keepK=[],removed=0;
  for(t=0;t<RAW.times.length;t++){var d=RAW.times[t];
    if(best[d.getMonth()]===d.getFullYear()*12+d.getMonth()){keepT.push(d);keepK.push(RAW.kw[t]);}
    else removed++;}
  if(removed>0){RAW.times=keepT;RAW.kw=keepK;
    RAW.trimNote="Multi-year file: kept the most complete year of data for each calendar month; "+removed+" intervals from repeated months excluded so monthly peaks and the CA simulation are not blended across years.";}
  return removed;
}

function dayKey(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}

function blankAnalysis(){return {source:"",rows:0,intervalMin:15,valueType:"kW",cols:{dt:0,val:1},
  peakKW:null,avgKW:null,loadFactor:null,energyKWh:null,peakMinusAvg:null,rangeStart:"",rangeEnd:"",
  monthly:[],loadDuration:[],worstDay:null,heat:null,heatMax:null,daily:[],synthetic:false};}

/* derive the analysis block from RAW */
function deriveAnalysis(RAW,opt){
  opt=opt||{};
  var a=blankAnalysis();
  if(!RAW||!RAW.kw.length)return a;
  var kw=RAW.kw,tm=RAW.times,n=kw.length,ih=RAW.intervalMin/60;
  a.rows=n;a.intervalMin=RAW.intervalMin;a.valueType=opt.valueType||"kW";
  a.cols=opt.cols||{dt:0,val:1};a.source=opt.source||"";a.synthetic=!!opt.synthetic;
  var sum=0,peak=-Infinity,energy=0,gpk=-Infinity,gpkDay="";
  /* per-month: track peak value + its RAW index (for peak time), energy, and the worst day
     (= the calendar day that CONTAINS the month's single highest interval, matching V2). */
  var mAgg=[];for(var m=0;m<12;m++)mAgg[m]={sum:0,n:0,energy:0,peak:-Infinity,peakIdx:-1,peakDay:""};
  var dayFirstIdx={},dayLastIdx={};   /* RAW index of each day's first/last interval (RAW is time-sorted) */
  var dMax={},dMin={},dSum={},dCnt={},dayOrder=[];
  var hm=[],hmn=[];for(var mm=0;mm<12;mm++){hm[mm]=[];hmn[mm]=[];for(var hh=0;hh<24;hh++){hm[mm][hh]=0;hmn[mm][hh]=0;}}
  for(var i=0;i<n;i++){var v=kw[i],d=tm[i],mo=d.getMonth(),hr=d.getHours(),dk=dayKey(d);
    sum+=v;energy+=v*ih;if(v>peak)peak=v;
    var ma=mAgg[mo];ma.sum+=v;ma.n++;ma.energy+=v*ih;
    if(v>ma.peak){ma.peak=v;ma.peakIdx=i;ma.peakDay=dk;}   /* i = RAW index of the month's peak interval */
    if(dMax[dk]==null){dayOrder.push(dk);dMax[dk]=v;dMin[dk]=v;dSum[dk]=v;dCnt[dk]=1;dayFirstIdx[dk]=i;dayLastIdx[dk]=i;}
    else{if(v>dMax[dk])dMax[dk]=v;if(v<dMin[dk])dMin[dk]=v;dSum[dk]+=v;dCnt[dk]++;dayLastIdx[dk]=i;}
    hm[mo][hr]+=v;hmn[mo][hr]++;
    if(v>gpk){gpk=v;gpkDay=dk;}
  }
  /* daily envelope (RAW is time-sorted, so dayOrder is chronological). Full precision on
     purpose: the peak day's max must be the SAME float as a.peakKW so the chart's marker,
     line and y-scale agree exactly — round only at display time */
  a.daily=dayOrder.map(function(dk2){return {d:dk2,min:dMin[dk2],
    avg:dSum[dk2]/dCnt[dk2],max:dMax[dk2]};});
  a.peakKW=peak;a.avgKW=sum/n;a.loadFactor=a.avgKW/peak;a.energyKWh=energy;
  a.peakMinusAvg=peak-a.avgKW;
  a.rangeStart=dayKey(tm[0]);a.rangeEnd=dayKey(tm[n-1]);
  /* monthly */
  /* monthly — chronological; each entry carries peak timestamp, energy, and a sliced worst-day profile.
     The worst day is the calendar day containing the month's single peak interval (V2 parity). */
  for(var m2=0;m2<12;m2++){var ma2=mAgg[m2];if(ma2.n<=0)continue;
    var wdk=ma2.peakDay,fi=dayFirstIdx[wdk],li=dayLastIdx[wdk];
    var wprof=[],wpeak=-Infinity,wsum=0,wcnt=0,wpkH=null;
    for(var wi=fi;wi<=li;wi++){var wt=tm[wi],wv=kw[wi];
      wprof.push({h:wt.getHours()+wt.getMinutes()/60,kW:wv});
      wsum+=wv;wcnt++;if(wv>wpeak){wpeak=wv;wpkH=wt.getHours()+wt.getMinutes()/60;}}
    var pkt=tm[ma2.peakIdx];
    a.monthly.push({
      m:m2,
      year:pkt.getFullYear(),                              /* for "Jan 2018" labels */
      peakKW:ma2.peak,
      peakTime:pkt,                                        /* Date of the month's peak interval */
      avgKW:ma2.sum/ma2.n,
      energyKWh:ma2.energy,
      worstDay:wdk,                                        /* "YYYY-MM-DD" (kept: existing table/sizing read this) */
      worstPeak:ma2.peak,                                  /* kept for back-compat */
      worst:{date:wdk,peak:wpeak,avgKW:wcnt?wsum/wcnt:null,energyKWh:wsum*ih,peakH:wpkH,profile:wprof}
    });}
  /* load duration (sample ~80 pts of sorted-desc) */
  var sorted=kw.slice().sort(function(x,y){return y-x;});var P=80;
  for(var p=0;p<P;p++){var ix=Math.round(p/(P-1)*(sorted.length-1));a.loadDuration.push({p:p/(P-1)*100,kW:sorted[ix]});}
  /* worst day profile (global peak day) */
  var prof=[];for(var w=0;w<n;w++){if(dayKey(tm[w])===gpkDay)prof.push({h:tm[w].getHours()+tm[w].getMinutes()/60,kW:kw[w]});}
  prof.sort(function(x,y){return x.h-y.h;});
  a.worstDay={date:gpkDay,profile:prof};
  /* heat grid + max */
  var grid=[],hmax=0;for(var g=0;g<12;g++){grid[g]=[];for(var c=0;c<24;c++){var val=hmn[g][c]?hm[g][c]/hmn[g][c]:null;grid[g][c]=val;if(val!=null&&val>hmax)hmax=val;}}
  a.heat=grid;a.heatMax=hmax;
  return a;
}

/* CSV/TSV text -> {delim, rows (preamble above the header already dropped), preamble (count), det}. Shared by ingestText and the self-tests. */
function readIntervalCSV(text){
  var delim=detectDelim(text);
  var rows=parseCSV(text,delim);
  var pre=findHeaderRow(rows);
  if(pre>0)rows=rows.slice(pre);
  var det=detectCols(rows);
  if(det)det.preamble=pre;
  return {delim:delim,rows:rows,preamble:pre,det:det};
}

function xmlDec(s){return String(s==null?"":s)
  .replace(/&#x([0-9a-f]+);/gi,function(_,h){return String.fromCharCode(parseInt(h,16));})
  .replace(/&#(\d+);/g,function(_,d){return String.fromCharCode(+d);})
  .replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");}
function colIdx(ref){var n=0;for(var i=0;i<ref.length;i++){n=n*26+(ref.charCodeAt(i)-64);}return n-1;}

function zipEntries(buf){
  var dv=new DataView(buf),len=buf.byteLength,eocd=-1;
  for(var i=len-22;i>=Math.max(0,len-65557);i--){if(dv.getUint32(i,true)===0x06054b50){eocd=i;break;}}
  if(eocd<0)throw new Error("Not a valid .xlsx file (zip directory not found).");
  var count=dv.getUint16(eocd+10,true),ofs=dv.getUint32(eocd+16,true),p=ofs,out={};
  for(var k=0;k<count;k++){
    if(dv.getUint32(p,true)!==0x02014b50)break;
    var method=dv.getUint16(p+10,true),csize=dv.getUint32(p+20,true),
        nl=dv.getUint16(p+28,true),el=dv.getUint16(p+30,true),cl=dv.getUint16(p+32,true),
        lho=dv.getUint32(p+42,true),
        name=new TextDecoder().decode(new Uint8Array(buf,p+46,nl));
    out[name]={method:method,csize:csize,lho:lho};
    p+=46+nl+el+cl;
  }
  return out;
}
async function zipRead(buf,entries,name){
  var e=entries[name];if(!e)return null;
  var dv=new DataView(buf);
  if(dv.getUint32(e.lho,true)!==0x04034b50)throw new Error("Corrupt zip entry: "+name);
  var nl=dv.getUint16(e.lho+26,true),el=dv.getUint16(e.lho+28,true);
  var start=e.lho+30+nl+el,raw=buf.slice(start,start+e.csize);
  if(e.method===0)return new TextDecoder().decode(raw);
  if(e.method!==8)throw new Error("Unsupported zip compression in "+name);
  if(typeof DecompressionStream==="undefined")throw new Error("This browser cannot unzip .xlsx (needs Chrome/Edge 80+). Export the data as CSV instead.");
  var ds=new DecompressionStream("deflate-raw");
  var resp=new Response(new Blob([raw]).stream().pipeThrough(ds));
  return new TextDecoder().decode(await resp.arrayBuffer());
}
function parseShared(xml){
  var out=[],re=/<si>([\s\S]*?)<\/si>/g,m;
  if(!xml)return out;
  while((m=re.exec(xml))){var s="",tre=/<t[^>]*>([\s\S]*?)<\/t>/g,tm;
    while((tm=tre.exec(m[1])))s+=xmlDec(tm[1]);
    out.push(s);}
  return out;
}
function sheetRows(xml,ss){
  /* single-pass native splits — large utility sheets (10-40 MB XML) parse ~10× faster
     than a lazy-regex scan, which read as "file not accepted" on big NY exports */
  var rows=[],parts=xml.split("<row ");
  for(var p=1;p<parts.length;p++){
    var chunk=parts[p],end=chunk.indexOf("</row>");
    if(end<0){rows.push([]);continue;}                 /* self-closing empty row */
    var gt0=chunk.indexOf(">");
    var body=chunk.slice(gt0+1,end);
    var cells=[],last=-1,cparts=body.split("<c ");
    for(var q=1;q<cparts.length;q++){
      var cc=cparts[q],hgt=cc.indexOf(">");
      if(hgt<0)continue;
      var attrs=cc.slice(0,hgt);
      var self=attrs.charAt(attrs.length-1)==="/";
      if(self)attrs=attrs.slice(0,-1);
      var rm=/r="([A-Z]+)\d+"/.exec(attrs);
      var ci=rm?colIdx(rm[1]):last+1;last=ci;
      if(self){cells[ci]=null;continue;}
      var inner=cc.slice(hgt+1);
      var t=(/t="([^"]+)"/.exec(attrs)||[])[1]||"";
      var v=null;
      if(t==="inlineStr"){var im=/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);v=im?xmlDec(im[1]):"";}
      else{var vi=inner.indexOf("<v>");
        if(vi>=0){var ve=inner.indexOf("</v>",vi);
          if(ve>=0){var rv=xmlDec(inner.slice(vi+3,ve));
            if(t==="s")v=ss[+rv]!=null?ss[+rv]:"";
            else if(t==="str")v=rv;
            else if(t==="b")v=+rv?1:0;
            else if(t==="e")v=null;
            else v=+rv;}}}
      cells[ci]=v;
    }
    rows.push(cells);
  }
  return rows;
}

/* canonize: any utility sheet → {canon:[[Date,val]], valueType, intervalMin, warnings, note}
   hints (optional): {dtCol, dateCol, timeCol, valCol, valueType} — from user override */
function canonize(rows,sheetName,hints){
  hints=hints||{};
  var warnings=[];
  rows=rows.filter(function(r){return r&&r.some(function(c){return c!=null&&c!=="";});});
  if(rows.length<3)throw new Error('Sheet "'+sheetName+'" has too few rows.');
  /* pivot / average-day summaries hide the true peaks sizing depends on — refuse honestly */
  var head=rows.slice(0,15).map(function(r){return r.map(function(c){return typeof c==="string"?c.toLowerCase():"";}).join(" | ");}).join("\n");
  if(/average of/.test(head))
    throw new Error('"'+sheetName+'" looks like a pivot / average-day summary ("Average of …" headers), not raw interval data. Averages hide the true demand peaks that ratchet sizing depends on — export the raw 15-minute meter intervals instead.');
  /* header row: best keyword-scoring row in the first 60 (utility files bury it under a preamble) */
  var KEY=/^(start|date|time|end|kwh|kw\b|demand|usage|consum|energy|interval|meter|account|hour|period|reading|season|week)/i;
  var hr=-1,hbest=1;
  for(var r=0;r<Math.min(60,rows.length);r++){
    var sc=0;
    rows[r].forEach(function(c){if(typeof c==="string"&&c.trim()&&KEY.test(c.trim()))sc++;});
    if(sc>=2&&sc>hbest){hbest=sc;hr=r;}
  }
  var headers=hr>=0?rows[hr].map(function(c){return typeof c==="string"?c.trim():"";}):[];
  var data=rows.slice(hr>=0?hr+1:0);
  if(data.length<2)throw new Error("No data rows found below the header in "+sheetName+".");
  var ncol=0;data.forEach(function(r){if(r.length>ncol)ncol=r.length;});
  /* column stats over a spread sample */
  var N=data.length,stride=Math.max(1,Math.floor(N/600)),S=[];
  for(var c=0;c<ncol;c++)S[c]={cnt:0,num:0,ser:0,serInt:0,frac:0,dstr:0,tvar:{},tstr:0};
  for(var i=0;i<N;i+=stride){var row=data[i];
    for(var c2=0;c2<ncol;c2++){var v=row[c2];if(v==null||v==="")continue;var st=S[c2];st.cnt++;
      if(typeof v==="number"){st.num++;
        if(v>=20000&&v<80000){st.ser++;if(v===Math.floor(v))st.serInt++;else st.tvar[Math.round((v%1)*1440)]=1;}
        else if(v>=0&&v<1)st.frac++;
      }else if(typeof v==="string"){
        var d=parseDT(v);
        if(d){st.dstr++;st.tvar[d.getHours()*60+d.getMinutes()]=1;}
        else if(parseTimeOfDay(v)>=0)st.tstr++;
      }
    }
  }
  function ratio(c,k){return (c<S.length&&S[c].cnt)?S[c][k]/S[c].cnt:0;}
  function tvarN(c){return c<S.length?Object.keys(S[c].tvar).length:0;}
  /* timestamp strategy: hints override auto-detection; fallback = full datetime col or date+time pair */
  var dtCol=-1,dateCol=-1,timeCol=-1,cands=[];
  if(hints.dtCol>=0){dtCol=hints.dtCol;}
  else if(hints.dateCol>=0||hints.timeCol>=0){dateCol=hints.dateCol>=0?hints.dateCol:-1;timeCol=hints.timeCol>=0?hints.timeCol:-1;}
  else{
    for(var c3=0;c3<ncol;c3++){
      if(ratio(c3,"ser")>0.9&&tvarN(c3)>4)cands.push(c3);
      else if(ratio(c3,"dstr")>0.9&&tvarN(c3)>4)cands.push(c3);
    }
    if(cands.length){
      var pick=null;
      /* priority: "start" > date|time (not revision) > non-revision > last resort */
      for(var p1=0;p1<cands.length;p1++){if(/start/i.test(headers[cands[p1]]||"")){pick=cands[p1];break;}}
      if(pick==null)for(var p2=0;p2<cands.length;p2++){var hc2=headers[cands[p2]]||"";if(/date|time/i.test(hc2)&&!/revision/i.test(hc2)){pick=cands[p2];break;}}
      if(pick==null)for(var p3=0;p3<cands.length;p3++){if(!/revision/i.test(headers[cands[p3]]||"")){pick=cands[p3];break;}}
      if(pick==null)pick=cands[0];
      /* if the only option is a revision column, try a date-only + time-fraction pair instead */
      if(/revision/i.test(headers[pick]||"")){
        var fb1=-1,fb2=-1;
        for(var fi1=0;fi1<ncol;fi1++){if((ratio(fi1,"ser")>0.9&&ratio(fi1,"serInt")>0.9)||ratio(fi1,"dstr")>0.9){fb1=fi1;break;}}
        for(var fi2=0;fi2<ncol;fi2++){if(fi2===fb1)continue;
          if(/time|hour/i.test(headers[fi2]||"")&&(ratio(fi2,"frac")>0.9||ratio(fi2,"tstr")>0.9)){fb2=fi2;break;}}
        if(fb1>=0&&fb2>=0){dateCol=fb1;timeCol=fb2;}else{dtCol=pick;}
      }else{dtCol=pick;}
    }else{
      for(var c4=0;c4<ncol;c4++){
        if((ratio(c4,"ser")>0.9&&ratio(c4,"serInt")>0.9)||ratio(c4,"dstr")>0.9){dateCol=c4;break;}
      }
      for(var c5=0;c5<ncol;c5++){if(c5===dateCol)continue;
        if(/time|hour/i.test(headers[c5]||"")&&(ratio(c5,"frac")>0.9||ratio(c5,"tstr")>0.9)){timeCol=c5;break;}
      }
      if(dateCol<0)throw new Error("No date/time column found in "+sheetName+". If this workbook is a summary or pivot, export the raw interval data instead.");
      if(timeCol<0)warnings.push("Timestamps are date-only (no intraday detail) — demand peaks will be understated. Use a 15-minute interval export for sizing.");
    }
  }
  /* value column: hints override; else kW preferred over kWh */
  var valCol=-1,valueType=hints.valueType||"kW",kwCol=-1,kwhCol=-1;
  if(hints.valCol>=0){valCol=hints.valCol;valueType=hints.valueType||"kW";}else{
    for(var h2=0;h2<headers.length&&h2<ncol;h2++){var hl=(headers[h2]||"").toLowerCase();
      if(!hl)continue;
      if(kwCol<0&&(/(^|[^a-z])kw([^a-z]|$)/.test(hl)||/demand/.test(hl))&&!/kwh|kvarh|kvar/.test(hl)&&ratio(h2,"num")>0.6)kwCol=h2;
      if(kwhCol<0&&/kwh|usage|consum|energy/.test(hl)&&!/kvarh/.test(hl)&&ratio(h2,"num")>0.6)kwhCol=h2;
    }
    if(kwCol>=0){valCol=kwCol;valueType="kW";}
    else if(kwhCol>=0){valCol=kwhCol;valueType="kWh";}
    else{for(var c6=0;c6<ncol;c6++){if(c6===dtCol||c6===dateCol||c6===timeCol)continue;
      if(ratio(c6,"num")>0.8&&ratio(c6,"ser")<0.5&&ratio(c6,"frac")<0.5){valCol=c6;break;}}}
    if(valCol<0)throw new Error("No kW / kWh value column found in "+sheetName+".");
  }
  /* multi-meter guard: mixing meters corrupts peaks — keep the dominant one, say so */
  var mCol=-1;
  for(var h3=0;h3<headers.length&&h3<ncol;h3++){if(/meter|account/i.test(headers[h3]||"")){mCol=h3;break;}}
  if(mCol>=0&&mCol!==valCol){
    var ids={},bestId=null,bn=0,total=0;
    data.forEach(function(r2){var id=r2[mCol];if(id==null||id==="")return;total++;ids[id]=(ids[id]||0)+1;if(ids[id]>bn){bn=ids[id];bestId=id;}});
    if(Object.keys(ids).length>1){
      data=data.filter(function(r3){return r3[mCol]===bestId;});
      warnings.push("Multiple meters/accounts in file — using "+bestId+" ("+bn+" of "+total+" rows). Import other meters separately.");
    }
  }
  /* build canonical [[Date, value]] */
  var canon=[],dropped=0;
  for(var i2=0;i2<data.length;i2++){var row2=data[i2],ts=null;
    if(dtCol>=0){var tv=row2[dtCol];
      if(typeof tv==="number")ts=serialToDate(tv);
      else if(typeof tv==="string")ts=parseDT(tv);
    }else{
      var dvv=row2[dateCol],base=null;
      if(typeof dvv==="number")base=serialToDate(dvv);
      else if(typeof dvv==="string")base=parseDT(dvv);
      if(base){var mins=0;
        if(timeCol>=0){mins=parseTimeOfDay(row2[timeCol]);if(mins<0){dropped++;continue;}}
        ts=new Date(base.getFullYear(),base.getMonth(),base.getDate(),0,mins,0);
      }
    }
    var val=row2[valCol];
    if(typeof val==="string"&&isNum(val))val=toNum(val);
    if(!ts||isNaN(ts.getTime())||typeof val!=="number"||!isFinite(val)){dropped++;continue;}
    canon.push([ts,val]);
  }
  if(canon.length<2)throw new Error("Could not assemble timestamped values from "+sheetName+".");
  if(dropped>canon.length*0.02)warnings.push(dropped+" rows skipped (missing or invalid timestamp/value).");
  /* interval = median consecutive diff over the whole (sorted) file */
  var ts2=canon.map(function(r4){return r4[0].getTime();}).sort(function(a,b){return a-b;});
  var diffs=[];for(var t2=1;t2<ts2.length&&diffs.length<3000;t2++){var dm=(ts2[t2]-ts2[t2-1])/60000;if(dm>0)diffs.push(dm);}
  diffs.sort(function(a,b){return a-b;});
  var im=diffs.length?diffs[Math.floor(diffs.length/2)]:15;
  [1,5,10,15,30,60].forEach(function(stdv){if(Math.abs(im-stdv)<=2)im=stdv;});
  im=Math.max(1,Math.round(im));
  /* kW ↔ kWh unit cross-check when both columns exist */
  if(kwCol>=0&&kwhCol>=0){
    var rs=[];
    for(var i3=0;i3<data.length&&rs.length<200;i3++){var av=data[i3][kwCol],bv=data[i3][kwhCol];
      if(typeof av==="number"&&typeof bv==="number"&&bv>0.01)rs.push(av/bv);}
    if(rs.length>20){rs.sort(function(x,y){return x-y;});var med=rs[Math.floor(rs.length/2)],expR=60/im;
      if(Math.abs(med-expR)/expR>0.08)warnings.push("kW column does not equal kWh × "+expR.toFixed(0)+" (median ratio "+med.toFixed(2)+") — verify units; using the kW column as-is.");}
  }
  var note="Timestamp: "+(dtCol>=0?('col '+colLetter(dtCol)+(headers[dtCol]?' ("'+headers[dtCol]+'")':""))
        :('col '+colLetter(dateCol)+(headers[dateCol]?' ("'+headers[dateCol]+'")':"")+(timeCol>=0?' + col '+colLetter(timeCol)+(headers[timeCol]?' ("'+headers[timeCol]+'")':""):" (date only)")))+
      " · Value: col "+colLetter(valCol)+(headers[valCol]?' ("'+headers[valCol]+'")':"")+" as "+valueType;
  return {canon:canon,valueType:valueType,intervalMin:im,warnings:warnings,note:note};
}

export {
  lmOf, lmTo, edEncodeRaw, edDecodeRaw, detectDelim, parseCSV, parseDT, parseTimeOfDay, serialToDate, isNum, toNum,
  detectCols, csvNoteOf, parseUnitLabel, rowStamp, findHeaderRow, pickDominantMeter, colLetter,
  buildRAW, dedupRAWMonths, dayKey, blankAnalysis, deriveAnalysis, readIntervalCSV,
  xmlDec, colIdx, zipEntries, zipRead, parseShared, sheetRows, canonize,
};
