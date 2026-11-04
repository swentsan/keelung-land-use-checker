import registry from './rules.json' with {type:'json'};
export const REGISTRY=registry, PLANS=registry.plans;
const CATALOG=Object.fromEntries(registry.catalog.map(x=>[x.code,x]));
const clone=x=>structuredClone(x), NUMS={'一':'1','二':'2','三':'3','四':'4','五':'5','六':'6'};
export const GEO='Utilities/Geometry/GeometryServer/';
export const collection=geometries=>JSON.stringify({geometryType:'esriGeometryPolygon',geometries});
export function zoneKey(value){
 const z=value.normalize('NFKC').replace(/\s+/g,'').replaceAll('之1','之一').replaceAll('之2','之二');
 for(const [prefix,head] of [['住宅區','R'],['商業區','C'],['特種住宅區','SR'],['特別住宅區','SR'],['漁港專用區','F'],['乙種工業區','I'],['倉儲區','W']]){
  if(z===prefix&&['R','C'].includes(head))return head;
  const m=z.match(new RegExp('^'+prefix+'\\((?:住|商|特住|漁專|乙工|倉儲|倉)?([一二三四五六])(?:之([一二]))?\\)$'));
  if(m)return head+NUMS[m[1]]+(m[2]?'-'+NUMS[m[2]]:'');
 }
 return z;
}
export const excluded=z=>['道路','人行步道','高速公路','快速公路','河道','河川','水域','海堤','保護區','農業區'].some(x=>z.includes(x));
const classify=z=>z.includes('住宅')?'residential':z.includes('商業')?'commercial':/工業|倉儲/.test(z)?'industrial':z.endsWith('用地')||z.includes('用地(')?'public':'other';
export function selectRule(planId,zone){
 planId=String(planId);const p=PLANS[planId]||{},k=zoneKey(zone),rates=p.rates||{},kind=classify(zone),setbacks=p.setbacks||{};
 let alias=k;
 if(!(k in rates)&&k.startsWith('學校用地(')&&'學校用地' in rates)alias='學校用地';
 const explicit={'306':{'機關用地(供環保局使用)':'機關用地'},'75':{'醫護特定專用區':'醫護專用區'},'247':{'住宅區(整體開發)':'R'},'164':{'果菜批發市場用地':'批發市場用地'}};
 alias=explicit[planId]?.[k]||alias;const pair=rates[alias];
 let sb=setbacks[k]||setbacks[kind]||(kind==='commercial'?setbacks.residential:null)||setbacks.all;
 if(zone.includes('市場用地')&&['290','296','302','309','322','335','369'].includes(planId))sb=setbacks.residential;
 if(kind==='industrial'&&planId==='263')sb=setbacks.industrial||sb;
 return {planId,zoneKey:k,supported:!!pair,bcr:pair?pair[0]:null,far:pair?pair[1]:null,excluded:excluded(zone),source:p.source||'https://upgis.klcg.gov.tw/KL_LAND/uplan/View.asp?ID='+planId,pageRefs:p.pageRefs||[],note:p.note||'',setback:sb?clone(sb):{distances:[],text:'本資料尚未確認可直接數值化的退縮條件；不等於退縮0m。'},status:excluded(zone)?'道路／非一般可建基地，排除面積情境':pair?'已配對數值':'此分區數值或適用條件待核對'};
}
export async function assign(zones,blockInfo){
 for(const z of zones){
  const a=z.attributes,code=a.LCODEB||'',c=CATALOG[code]||{},block=a.BLOCK_DEF||'';let pid='',err='';
  try{const ids=await blockInfo(block);if(ids.length===1)pid=ids[0];else err='街廓現行計畫回應不唯一；不以相交歷程猜選計畫。'}catch{err='街廓現行計畫查詢失敗；本次不套用快照的數值規則。'}
  const base=pid,override={'B0062':'387','B0045':'387','B0067':'376','B0068':'377'},accepted={'B0062':['347','387'],'B0045':['347','387'],'B0067':['105','376'],'B0068':['377']};
  if(override[code]&&accepted[code].includes(pid)){const newer=override[code];if(pid!==newer)err=`圖台街廓回傳案號${pid}；此範圍另依已核對的發布案${newer}處理。版本核對日2026-11-02。`;pid=newer}
  if(code==='B0063'&&a.LUSE==='倉儲區(五)')pid=pid?'375':'';
  const r=selectRule(pid,a.LUSE||'');Object.assign(r,{planName:c.name||'',detailCode:code,block,matchingNote:err,officialBasePlanId:base});
  if(code==='B0069'&&pid==='380'){r.planName='學校用地恢復原分區案（圖台B0069標題有誤）';r.matchingNote='細計範圍標題與街廓現行案不一致；依現行案380核對，不套用獅球嶺388。'}
  const required=PLANS[pid]?.requiredBasePlan;
  if(required&&![required,pid].includes(base))Object.assign(r,{supported:false,bcr:null,far:null,status:'密度轉接所需原計畫不符，保留待核對'});
  if(!pid)r.status=err||'無法確認現行計畫';z.rule=r;
 }
 return zones;
}
export async function difference(rest,geoms,cutter){
 const out=await rest(GEO+'difference',{sr:3828,geometries:collection(geoms),geometry:JSON.stringify({geometryType:'esriGeometryPolygon',geometry:cutter})});
 if(out.geometries?.length!==geoms.length)throw Error('退縮裁切回應不完整');return out.geometries;
}
export async function spatialOverrides(zones,cases,rest,area){
 for(const c of cases){
  if(String(c.attributes.PLANNO)!=='388'||!c.geometry)continue;
  const clips=(await rest(GEO+'intersect',{sr:3828,geometries:collection(zones.map(z=>z.intersection)),geometry:JSON.stringify({geometryType:'esriGeometryPolygon',geometry:c.geometry})})).geometries||[];
  if(clips.length!==zones.length)throw Error('新發布計畫範圍交集不完整');const updated=[];
  for(let i=0;i<zones.length;i++){
   const z=zones[i],g=clips[i],value=area(g);if(value<=.01){updated.push(z);continue}
   const inside=clone(z);Object.assign(inside,{intersection:g,overlapArea:value});
   inside.rule={...selectRule('388',z.attributes.LUSE),planName:c.attributes.PLANNAME,detailCode:z.attributes.LCODEB||'',block:z.attributes.BLOCK_DEF||'',officialBasePlanId:z.rule.officialBasePlanId||'',matchingNote:'依官方發布案388的實際空間範圍裁切配對，不依細計代碼名稱推定。',scopeSource:'https://upgis.klcg.gov.tw/arcgiswa/rest/services/KL_UPGIS/kl_uplan/MapServer/7'};
   updated.push(inside);
   if(z.overlapArea-value>.01){const outside=(await difference(rest,[z.intersection],c.geometry))[0],remaining=clone(z);Object.assign(remaining,{intersection:outside,overlapArea:area(outside)});updated.push(remaining)}
  }
  zones=updated;
 }
 return zones;
}
export function aggregate(zones){
 const eligible=zones.filter(z=>!z.rule.excluded),known=eligible.filter(z=>z.rule.supported),missing=eligible.filter(z=>!z.rule.supported&&z.overlapArea>.01),sum=(list,f)=>list.reduce((n,z)=>n+f(z),0);
 return {estimatedBaseArea:known.length?sum(known,z=>z.overlapArea):null,estimatedCoverage:known.length?sum(known,z=>z.overlapArea*z.rule.bcr/100):null,estimatedFar:known.length?sum(known,z=>z.overlapArea*z.rule.far/100):null,areaComplete:!!known.length&&!missing.length,unknownArea:sum(missing,z=>z.overlapArea),excludedArea:sum(zones.filter(z=>z.rule.excluded),z=>z.overlapArea)};
}
export async function envelopes(zones,roads,parcel,rest,area){
 const output=[],bufferCache=new Map();
 for(let index=0;index<zones.length;index++){
  const z=zones[index],r=z.rule,sb=r.setback;
  if(!r.supported||r.excluded||!sb.distances?.length)continue;
  for(const dist of sb.distances){
   const row={zoneIndex:index,zone:z.attributes.LUSE,distance:dist,condition:sb.text,boundary:sb.boundary||'road',status:'ok',automatic:(r.resolution?.status||'').startsWith('automatic'),additionalConstraints:[]};
   try{
    let result;
    if(sb.boundary==='parcel'){
     const shrink=(await rest(GEO+'buffer',{inSR:3828,outSR:3828,bufferSR:3828,geometries:collection([parcel]),distances:-dist,unit:9001,unionResults:'true'})).geometries;
     result=!shrink.length?{rings:[]}:(await rest(GEO+'intersect',{sr:3828,geometries:collection([z.intersection]),geometry:JSON.stringify({geometryType:'esriGeometryPolygon',geometry:shrink[0]})})).geometries[0];
    }else{
     if(!roads.length)throw Error('未辨識與本宗地相交／相接的計畫道路；不可推論免退縮');
     if(!bufferCache.has(dist)){const buffs=(await rest(GEO+'buffer',{inSR:3828,outSR:3828,bufferSR:3828,geometries:collection(roads),distances:dist,unit:9001,unionResults:'true'})).geometries;if(buffs.length!==1)throw Error('道路緩衝區回應不完整');bufferCache.set(dist,buffs[0])}
     result=(await difference(rest,[z.intersection],bufferCache.get(dist)))[0];
    }
    row.areaBeforeAdditional=area(result);
    for(const spec of r.adjacentConstraints||[]){
     if(!spec.geometries?.length)continue;
     const buffers=(await rest(GEO+'buffer',{inSR:3828,outSR:3828,bufferSR:3828,geometries:collection(spec.geometries),distances:spec.distance,unit:9001,unionResults:'true'})).geometries||[];
     if(buffers.length!==1)throw Error('鄰接分區退縮緩衝回應不完整');result=(await difference(rest,[result],buffers[0]))[0];
     const {geometries,...detail}=spec;row.additionalConstraints.push(detail);
    }
    const value=area(result);if(!(value>=0&&value<=z.overlapArea+.02))throw Error('退縮面積檢核失敗');Object.assign(row,{geometry:result,area:value,coverage:Math.min(value,z.overlapArea*r.bcr/100),far:z.overlapArea*r.far/100});
   }catch(e){Object.assign(row,{status:'unavailable',message:e.message})}
   output.push(row);
  }
 }
 return output;
}
export function segmentDistance(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)):0;return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)}
function lineDistance(p,paths){let result=Infinity;for(const path of paths)for(let i=0;i<path.length-1;i++)result=Math.min(result,segmentDistance(p,path[i],path[i+1]));return result}
function inside(p,g){let value=false;const [x,y]=p;for(const ring of g.rings||[])for(let i=0;i<ring.length-1;i++){const a=ring[i],b=ring[i+1];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])value=!value}return value}
function polygonDistance(p,g){return inside(p,g)?0:lineDistance(p,g.rings||[])}
function frontagePoints(geom,roads){
 const points=[];
 for(const ring of geom.rings||[])for(let i=0;i<ring.length-1;i++){
  const a=ring[i],b=ring[i+1];if(Math.hypot(a[0]-b[0],a[1]-b[1])<.5)continue;
  const samples=[.2,.5,.8].map(t=>[(1-t)*a[0]+t*b[0],(1-t)*a[1]+t*b[1]]);
  if(samples.every(p=>Math.min(99,...roads.map(g=>polygonDistance(p,g)))<.08))points.push(...samples);
 }
 return points;
}
export function matchRoadName(geom,roads,features){
 const points=frontagePoints(geom,roads),evidence=[];
 if(!points.length)return {status:'unresolved',reason:'未取得可辨識的相接計畫道路邊界',samples:[]};
 for(const point of points){
  const distances=new Map();
  for(const f of features){let name=(f.attributes.ROADNAME||'').trim();if(['','無路名'].includes(name))name='〈未命名道路〉';distances.set(name,Math.min(distances.get(name)??Infinity,lineDistance(point,f.geometry.paths||[])))}
  const ordered=[...distances].sort((a,b)=>a[1]-b[1]);
  if(!ordered.length||ordered[0][0]==='〈未命名道路〉'||ordered[0][1]>25||(ordered.length>1&&ordered[1][1]-ordered[0][1]<4))return {status:'unresolved',reason:'相接道路名稱不唯一、交叉口或名稱線距離過大',samples:evidence};
  evidence.push({point,roadName:ordered[0][0],distanceToNameLine:Math.round(ordered[0][1]*1000)/1000});
 }
 const names=new Set(evidence.map(x=>x.roadName));if(names.size!==1)return {status:'unresolved',reason:'多面臨路，無法以單一道路名稱決定全部退縮',samples:evidence};
 return {status:'spatial_match',roadName:[...names][0],samples:evidence,reason:'相接邊界採樣比對官方道路名稱線；未使用最近地址或手動輸入路名'};
}
export function resolve(zones,context,roads,roadNames,parcelArea,identity){
 for(const z of zones){
  const r=z.rule,plan=PLANS[r.planId]||{},zone=z.attributes.LUSE,kind=zone.includes('住宅')?'residential':zone.includes('商業')?'commercial':/工業|倉儲/.test(zone)?'industrial':'public';
  r.conditions=[];
  for(const [spec,items] of Object.entries(plan.conditions||{})){
   if(!(['all',zone,r.zoneKey].includes(spec)||(spec==='specialResidential'&&/特種住宅|特別住宅/.test(zone))))continue;
   for(const item0 of items){const item=clone(item0);if('minimumArea' in item)Object.assign(item,{observedArea:parcelArea,status:parcelArea>=item.minimumArea?'meets_single_parcel_area':'requires_assembly'});r.conditions.push(item)}
  }
  for(const item of plan.parcelConditions||[])if(item.section===identity?.section&&item.lots.includes(identity?.lot)){const {section,lots,...detail}=item;r.conditions.push({...detail,status:'specified_lot_match',source:plan.source})}
  r.bonusOptions=(plan.bonusOptions?.[r.zoneKey]||[]).map(o=>({...clone(o),source:plan.source,observedArea:z.overlapArea,areaStatus:o.wholeBlock?'requires_whole_block_evidence':z.overlapArea>=o.minimumArea?'area_threshold_met':'requires_assembly',status:'not_approved'}));
  r.densitySource=plan.densitySource||'';r.resolution={status:'conditional',reason:'路寬／附圖／指定位置尚不足以唯一選定',distance:null};const sb=r.setback;
  if(!sb.distances?.length)r.resolution={status:'missing_rule',reason:sb.text,distance:null};
  if(sb.auto&&sb.distances?.length===1)r.resolution={status:'automatic',reason:'已配對不依路寬分支的明文退縮條款',distance:sb.distances[0]};
  if(r.conditions.some(c=>c.status==='specified_lot_match')){Object.assign(sb,{distances:[],auto:false,text:'命中計畫指定地號，但原圖指定邊界及地號沿革尚未唯一確認；停止以一般退縮方案代替。'});r.resolution={status:'specified_boundary_missing',distance:null,reason:sb.text}}
  const named=(plan.namedRoads||[]).filter(item=>item.kinds.includes(kind));
  if(named.length){const evidence=matchRoadName(z.intersection,roads,roadNames);r.roadEvidence=evidence;const item=named.find(x=>evidence.roadName===x.name);if(item){Object.assign(sb,{distances:[item.distance],auto:true,text:`臨${item.name}：${item.distance}m；依官方圖資空間比對選定。基本圖名稱線仍非正式建築線。`});r.resolution={status:'automatic_spatial',distance:item.distance,reason:'明文指定路名與相接道路空間比對相符',source:plan.source,page:item.page}}}
  r.adjacentConstraints=[];
  for(const spec of plan.adjacentBuffers||[]){
   if(spec.zone&&spec.zone!==zone)continue;if(spec.kinds&&!spec.kinds.includes(kind))continue;
   const targets=context.filter(f=>(spec.differentZone&&f.attributes.LUSE!==zone)||(spec.zones||[]).includes(f.attributes.LUSE)),{zones:omitZones,differentZone,kinds,zone:omitZone,...detail}=spec;
   r.adjacentConstraints.push({...detail,targetZones:[...new Set(targets.map(f=>f.attributes.LUSE))].sort(),geometries:targets.map(f=>f.geometry),source:plan.source,status:targets.length?'mapped':'no_intersecting_target'});
  }
 }
 return zones;
}
export async function bonusEnvelopes(zones,roads,parcel,rest,area){
 const output=[];
 for(let index=0;index<zones.length;index++)for(const option of zones[index].rule.bonusOptions||[]){
  if(option.areaStatus!=='area_threshold_met')continue;
  const z=clone(zones[index]);Object.assign(z.rule,{bcr:option.bcr,far:option.far,resolution:{status:'conditional_bonus'},setback:{distances:[option.distance],text:option.label+'；須合併開發、採建蔽45%及道路退5m，尚未核准。',auto:false}});
  for(const row of await envelopes([z],roads,parcel,rest,area))output.push({...row,zoneIndex:index,variant:option.label,bcr:option.bcr,farPercent:option.far,approvalStatus:'not_approved'});
 }
 return output;
}
