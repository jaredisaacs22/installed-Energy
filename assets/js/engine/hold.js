// The Site Analysis Workbench's dispatch core, ported so the Savings tab can show the workbench's own
// figures: the lowest peak a battery holds on EVERY day of a month ("sustainable hold"), with the
// workbench's options (reserve capacity, a fixed dispatch schedule, charge carried across days, deeper
// discharge on lighter days).
//
// The algorithms are the workbench's, kept in its style so they can be diffed against the original:
// dispatchProfileFrom / dispatchAchievedFrom (greedy state-of-charge simulation), robustHold (binary
// search, rounded up to the next 0.5 kW and verified, because the energy balance has a cliff),
// robustHoldSequential (carry), monthSustainCheck, maxDischargeCapFor, schedForDate. What changed:
// they take their settings as arguments instead of reading the workbench's global model, and a day
// profile is [{h: hour of day, kW, d: "Y-M-D"}] built from the Atlas interval structure.
//
// A "unit" here is the workbench's effective battery: { kw, chargeKw, usableKwh (stored energy), effC,
// effD, reserve (fraction 0-0.9 of usableKwh never discharged for shaving) }.
/* eslint-disable */

export function reserveFracOf(v){var x=+v;return (isFinite(x)&&x>0)?Math.min(0.9,x):0;}
export function reserveFloorKwh(u){return (u.usableKwh||0)*reserveFracOf(u.reserve);}

/* ---- dispatch schedule: discharge window, optional charge window, which months / days it governs ---- */
export function schedInWin(h,a,b){a=+a;b=+b;if(a===b)return false;return a<b?(h>=a&&h<b):(h>=a||h<b);}
export function winLenHrs(a,b){a=+a;b=+b;if(a===b)return 0;return a<b?(b-a):(24-a+b);}
function schedSummer(m){return m>=5&&m<=8;} /* Jun-Sep */
/* does the schedule govern a day with this month (0-11) / day-of-week? */
export function schedAppliesDM(sc,mo,dow){
  if(!sc)return false;
  if(sc.months==="summer"&&mo!=null&&!schedSummer(mo))return false;
  if(sc.months==="winter"&&mo!=null&&schedSummer(mo))return false;
  if(sc.days==="weekdays"&&dow!=null&&(dow===0||dow===6))return false;
  return true;
}
/* resolve for a "YYYY-M-D" day key -> the schedule when it governs that day, else null */
export function schedForDate(sc,dstr){
  if(!sc)return null;
  var mo=null,dow=null;
  if(dstr){var p=String(dstr).split("-");
    if(p.length===3){var dd=new Date(+p[0],+p[1]-1,+p[2]);if(!isNaN(dd.getTime())){mo=dd.getMonth();dow=dd.getDay();}}}
  return schedAppliesDM(sc,mo,dow)?sc:null;
}

/* Generalized SOC dispatch over any day profile at a given cap. Battery starts full (or at startSOC);
   discharges to hold load<=cap (power + energy/SOC limited), recharges when load<cap. */
export function dispatchProfileFrom(prof,cap,u,dt,sched,startSOC){
  var E=u.usableKwh,P=u.kw,Pc=u.chargeKw||u.kw,effD=u.effD||1,effC=u.effC||1;
  var floor=reserveFloorKwh(u);                            /* reserve capacity: never discharge below this */
  var soc=(startSOC==null)?E:Math.max(0,Math.min(E,startSOC));
  var orig=[],shaved=[],socS=[],maxDis=0,eDis=0,eChg=0,minSOC=soc,achieved=0;
  var chgWin=!!(sched&&sched.chgMode==="window");
  for(var i=0;i<prof.length;i++){var h=prof[i].h,load=prof[i].kW,need=load-cap,la=load;
    var okD=!sched||schedInWin(h,sched.disStart,sched.disEnd);       /* W1: discharge window */
    var okC=!chgWin||schedInWin(h,sched.chgStart,sched.chgEnd);      /* W1: charge window */
    if(need>0){var dis=okD?Math.min(need,P,Math.max(0,soc-floor)*effD/dt):0;la=load-dis;soc-=dis/effD*dt;eDis+=dis*dt;if(dis>maxDis)maxDis=dis;}
    else{var chg=okC?Math.min(-need,Pc,(E-soc)/dt):0;la=load+chg;soc+=chg*effC*dt;eChg+=chg*dt;}
    if(soc<minSOC)minSOC=soc;if(la>achieved)achieved=la;
    orig.push([h,load]);shaved.push([h,la]);socS.push([h,soc]);
  }
  return {orig:orig,shaved:shaved,soc:socS,maxDis:maxDis,eDis:eDis,eChg:eChg,minSOC:minSOC,achieved:achieved,cap:cap,E:E,P:P,held:achieved<=cap+0.5,socEnd:soc,floor:floor,effD:effD};
}
export function dispatchProfile(prof,cap,u,dt,sched){return dispatchProfileFrom(prof,cap,u,dt,sched,null);}
/* Fast dispatch: only the achieved (max shaved) peak and the ending SOC, no per-interval arrays. */
export function dispatchAchievedFrom(prof,cap,u,dt,sched,startSOC){
  var E=u.usableKwh,P=u.kw,Pc=u.chargeKw||u.kw,effD=u.effD||1,effC=u.effC||1;
  var floor=reserveFloorKwh(u);                             /* reserve capacity: never discharge below this */
  var soc=(startSOC==null)?E:Math.max(0,Math.min(E,startSOC)),achieved=0;
  var chgWin=!!(sched&&sched.chgMode==="window");
  for(var i=0;i<prof.length;i++){var h=prof[i].h,load=prof[i].kW,need=load-cap,la=load;
    if(need>0){var dis=(!sched||schedInWin(h,sched.disStart,sched.disEnd))?Math.min(need,P,Math.max(0,soc-floor)*effD/dt):0;la=load-dis;soc-=dis/effD*dt;}
    else if(!chgWin||schedInWin(h,sched.chgStart,sched.chgEnd)){var chg=Math.min(-need,Pc,(E-soc)/dt);soc+=chg*effC*dt;}
    if(la>achieved)achieved=la;}
  return {achieved:achieved,socEnd:soc};
}
export function dispatchAchieved(prof,cap,u,dt,sched){return dispatchAchievedFrom(prof,cap,u,dt,sched,u.usableKwh).achieved;}
/* Sequential month evaluator for the carry-SOC option: each day's ending SOC is the next day's start. */
export function robustHoldSequential(days,u,dt,scheds,cap){
  var soc=u.usableKwh,worst=0;
  for(var j=0;j<days.length;j++){
    var r=dispatchAchievedFrom(days[j],cap,u,dt,scheds?scheds[j]:null,soc);
    soc=r.socEnd;if(r.achieved>worst)worst=r.achieved;
  }
  return worst;
}
/* Lowest peak the battery RELIABLY holds across a set of day-profiles. Binary-searches the hold
   threshold, then rounds UP to the next 0.5 kW and verifies: the energy balance has a cliff (a target 0.1 kW
   too low can flip the battery from "just holds" to "depletes and overshoots"), so we land on the safe side. */
export function robustHold(profs,u,dt,scheds,carry){
  if(!profs||!profs.length)return null;
  var peak=0;profs.forEach(function(d){for(var i=0;i<d.length;i++)if(d[i].kW>peak)peak=d[i].kW;});
  function achievedAt(mid){
    if(carry)return robustHoldSequential(profs,u,dt,scheds,mid);
    var w=0;for(var j=0;j<profs.length;j++){var a=dispatchAchieved(profs[j],mid,u,dt,scheds?scheds[j]:null);if(a>w)w=a;}
    return w;
  }
  var lo=0,hi=peak;
  /* hold test needs a tolerance: while holding, grid draw is load - (load - cap), which floating point returns
     as cap +/- 1 ulp, so a bare `achieved > mid` would call a cap that HOLDS "not held" at random. */
  for(var it=0;it<24;it++){var mid=(lo+hi)/2;if(achievedAt(mid)>mid+1e-6)lo=mid;else hi=mid;}
  var T=Math.ceil(hi*2)/2;                                   /* safe side of the cliff (next 0.5 kW) */
  for(var g=0;g<10;g++){if(achievedAt(T)<=T+0.05)break;T+=0.5;}
  return Math.round(T*10)/10;
}
/* Lowest peak the battery can hold on a single day-profile (worst-day estimate when no full file). */
export function minAchievablePeak(prof,u,dt,sched){return (prof&&prof.length)?robustHold([prof],u,dt,sched?[sched]:null):null;}
/* Sustainable target of one month: the lowest peak held on EVERY day (days = chronological day profiles). */
export function monthSustainTarget(days,u,dt,sc,carry){
  if(!days||!days.length)return null;
  var scheds=sc?days.map(function(d){return schedForDate(sc,d[0]?d[0].d:null);}):null;   /* resolve per day */
  return robustHold(days,u,dt,scheds,!!carry);
}
/* At a chosen target, the highest shaved peak across all days of the month, and which day binds. */
export function monthSustainCheck(days,target,u,dt,sc,carry){
  if(!days||!days.length)return null;
  var worst=0,bind=null,soc=carry?u.usableKwh:null;
  for(var j=0;j<days.length;j++){var sd=sc?schedForDate(sc,days[j][0]?days[j][0].d:null):null;
    var r=dispatchAchievedFrom(days[j],target,u,dt,sd,carry?soc:u.usableKwh);
    if(carry)soc=r.socEnd;
    if(r.achieved>worst){worst=r.achieved;bind=days[j][0]?days[j][0].d:null;}}
  return {days:days.length,worstAfter:Math.round(worst*10)/10,holdsAll:worst<=target+0.5,bindingDate:bind};
}
/* "Maximize discharge on lighter days": never deeper than the day's own sustainable hold, never past the
   monthly target; off, or while carry is on, it returns the monthly target unchanged. */
export function maxDischargeCapFor(prof,u,dt,sched,monthlyTarget,opts){
  if(!(opts&&opts.maxDaily))return monthlyTarget;
  if(opts&&opts.carry)return monthlyTarget;
  var own=minAchievablePeak(prof,u,dt,sched);
  return (own!=null&&own<monthlyTarget)?own:monthlyTarget;
}

/* ---- adapters from the Atlas data structures ---- */

/** Day profiles of one month (1-12) from buildInterval output, chronological: [[{h, kW, d}]]. */
export function daysOfMonth(interval,m){
  var md=interval&&interval.months&&interval.months[m];
  if(!md||!md.days||!md.days.length)return null;
  var dt=interval.dtHours;
  return md.days.map(function(day){
    var p=day.date.split("-"),dk=(+p[0])+"-"+(+p[1])+"-"+(+p[2]),out=[];
    for(var i=0;i<day.kw.length;i++){var v=day.kw[i];if(Number.isFinite(v))out.push({h:i*dt,kW:v,d:dk});}
    return out;
  });
}

/** The workbench's effective battery for an Atlas configuration (simBatteryOf) plus a reserve fraction. */
export function holdUnitOf(battery,reserve){
  return {kw:battery.kw,chargeKw:battery.chargeKw||battery.kw,usableKwh:battery.storedKwh,effC:battery.effCharge||1,effD:battery.effDischarge||1,reserve:reserveFracOf(reserve)};
}

/**
 * Sustainable hold for each month: { [m 1-12]: { peak, achievable } }. Uses every day of the month when
 * interval data covers it; otherwise the design day (a single profile {kw, dtHours}) as a worst-day estimate.
 * opts = { sched, carry }. monthPeaks (optional) = { [m]: kW } scales the design day to that month's peak
 * (billed demand read off the customer's bills) for months the interval data does not cover.
 */
export function monthlyHolds(interval,designProfile,u,opts,monthPeaks){
  opts=opts||{};
  var out={};
  for(var m=1;m<=12;m++){
    var days=daysOfMonth(interval,m);
    if(days){
      var peak=interval.months[m].peak;
      out[m]={peak:peak,achievable:monthSustainTarget(days,u,interval.dtHours,opts.sched,opts.carry),days:days.length,basis:"interval"};
    }else if(designProfile){
      var dt=designProfile.dtHours,pk0=Math.max.apply(null,designProfile.kw);
      var want=monthPeaks&&+monthPeaks[m]>0?+monthPeaks[m]:null,f=(want&&pk0>0)?want/pk0:1;
      var prof=designProfile.kw.map(function(v,i){return {h:i*dt,kW:v*f,d:null};});
      out[m]={peak:pk0*f,achievable:minAchievablePeak(prof,u,dt,opts.sched||null),days:null,basis:"design",profile:prof};
    }
  }
  return out;
}

/**
 * The dispatch settings stored on a site (site.dispatch), as the engine reads them:
 * { reserve (fraction), carry, maxDaily, sched (null unless enabled), targets {month: kW} }.
 * Carry and "maximize on lighter days" are mutually exclusive, and carry wins, as in the workbench.
 */
export function dispatchOptionsOf(site){
  var d=(site&&site.dispatch)||{};
  var carry=!!d.carry;
  var sc=d.sched&&d.sched.enabled?d.sched:null;
  return {reserve:reserveFracOf((+d.reserve_pct||0)/100),carry:carry,maxDaily:!!d.max_daily&&!carry,sched:sc,targets:d.month_targets||{}};
}
