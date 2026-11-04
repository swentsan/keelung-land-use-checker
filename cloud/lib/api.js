import * as engine from './engine.js';
const SITE='https://upgis.klcg.gov.tw/KL_LAND/',REST='https://upgis.klcg.gov.tw/arcgiswa/rest/services/';
const DISTRICTS=['中山區','中正區','仁愛區','信義區','安樂區','暖暖區','七堵區'];
const CACHE=new Map();
async function cached(key,task,ttl=3600000){
 const old=CACHE.get(key);if(old&&Date.now()-old.time<ttl)return old.value;
 const value=Promise.resolve().then(task);CACHE.set(key,{time:Date.now(),value});
 try{return await value}catch(e){CACHE.delete(key);throw e}
}
function unescapeHTML(value){return value.replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n))).replace(/&(amp|quot|apos|lt|gt|nbsp);/g,(_,n)=>({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '})[n])}
export function plain(t){return unescapeHTML(t.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<br\s*\/?>|<\/(?:p|tr|div)>/gi,'\n').replace(/<[^>]+>/g,'')).trim()}
async function fetchOfficial(url,data=null,jar=null){
 const headers={'User-Agent':'KeelungLandAssessment/3.1','Accept':'*/*'};
 if(jar?.cookie)headers.Cookie=jar.cookie;
 if(data)headers['Content-Type']='application/x-www-form-urlencoded';
 const response=await fetch(url,{method:data?'POST':'GET',headers,body:data?new URLSearchParams(Object.entries(data).map(([k,v])=>[k,String(v)])):undefined,signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error('官方服務暫時無法連線（HTTP '+response.status+'）');
 if(jar){const cookies=response.headers.getSetCookie?response.headers.getSetCookie():[response.headers.get('set-cookie')].filter(Boolean);if(cookies.length)jar.cookie=cookies.map(x=>x.split(';')[0]).join('; ')}
 const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>20000000)throw Error('官方回應超過大小限制');return bytes;
}
function decode(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{return new TextDecoder('big5').decode(bytes)}}
export async function rest(path,params={}){
 const obj=JSON.parse(decode(await fetchOfficial(REST+path,{f:'json',...params})));
 if(obj.error)throw Error('官方圖資服務錯誤：'+(obj.error.message||''));return obj;
}
const hidden=t=>Object.fromEntries([...t.matchAll(/name="([^"]+)"[^>]*value="([^"]*)"/g)].filter(m=>m[1].startsWith('__')).map(m=>[m[1],unescapeHTML(m[2])]));
const selectOptions=t=>{const s=t.match(/<select\b[^>]*name="sel1"[^>]*>([\s\S]*?)<\/select>/i);if(!s)return [];return [...s[1].matchAll(/<option[^>]*value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/g)].map(m=>({code:m[1],name:plain(m[2])}))};
export function normalizeLot(value){value=String(value).trim().replaceAll('地號','').replaceAll('號','').replaceAll('－','-');if(!/^\d{1,4}(?:-\d{1,4})?$/.test(value))throw Error('地號格式應為615或615-1');const parts=value.split('-').map(Number);if(!parts[0])throw Error('地號母號不可為0');return String(parts[0])+(parts[1]?'-'+parts[1]:'')}
export async function sections(){return cached('sections',async()=>{
 const jar={},url=SITE+'landuseNew/qsec_landuse.aspx';let t=decode(await fetchOfficial(url,null,jar));
 t=decode(await fetchOfficial(url,{...hidden(t),TextBox1:'',Button2:'搜尋',sel3:'七堵區',sel1:'請選擇',TextBox2:''},jar));
 const values=selectOptions(t).filter(x=>/^(?:CD\d{4}|\d{5})$/.test(x.code));if(!values.length)throw Error('官方地段選單讀取失敗');return values;
})}
export async function officialForm(district,section,lot){
 const jar={},url=SITE+'landuseNew/qsec_landuse.aspx';let t=decode(await fetchOfficial(url,null,jar));
 t=decode(await fetchOfficial(url,{...hidden(t),TextBox1:section.split('段')[0],Button2:'搜尋',sel3:district,sel1:'請選擇',TextBox2:''},jar));
 const exact=selectOptions(t).filter(x=>x.name.replaceAll(' ','')===section.replaceAll(' ',''));
 if(exact.length!==1)throw Error('官方地段選單未取得唯一相符地段，請核對地段及小段全名');
 const code=exact[0].code;t=decode(await fetchOfficial(url,{...hidden(t),TextBox1:section,sel3:district,sel1:code,TextBox2:lot,Button1:'查詢並定位'},jar));
 const op=i=>(t.match(new RegExp('<span\\b[^>]*id="Op'+i+'"[^>]*>([\\s\\S]*?)<\\/span>','i'))||[])[1]||'';
 const zone=plain(op(1));if(!zone||zone.includes('查無'))throw Error('官方表單查無此地號分區資料');
 return {sectionCode:code,zone,plan:plain(op(2)),history:plain(op(3)),planIds:[...new Set([...op(3).matchAll(/View.asp\?ID=([\d-]+)/gi)].map(m=>m[1]))],formUrl:url,formNotes:plain(op(4)+'\n'+op(5))};
}
const meta=service=>cached('meta:'+service,()=>rest('KL_UPGIS/'+service+'/MapServer'));
const blockInfo=block=>cached('block:'+block,async()=>[...new Set([...decode(await fetchOfficial(SITE+'landuseNew/show_lu_byXY.aspx?fv='+encodeURIComponent(block))).matchAll(/View.asp\?ID=([\d-]+)/gi)].map(m=>m[1]))]);
export function geometryArea(g){
 return Math.abs((g.rings||[]).reduce((sum,ring)=>{if(ring.length<3)return sum;const [x0,y0]=ring[0],q=ring.map(([x,y])=>[x-x0,y-y0]);return sum+q.reduce((v,a,i)=>v+a[0]*q[(i+1)%q.length][1]-q[(i+1)%q.length][0]*a[1],0)/2},0));
}
async function spatialQuery(layer,geometry,type='esriGeometryPolygon'){const r=await rest('KL_UPGIS/kl_uplan/MapServer/'+layer+'/query',{geometry:JSON.stringify(geometry),geometryType:type,inSR:3828,spatialRel:'esriSpatialRelIntersects',outFields:'*',returnGeometry:'true'});if(!Array.isArray(r.features))throw Error('官方空間查詢回應不完整');return r.features}
export async function lookup(district,section,lot){
 if(!DISTRICTS.includes(district)||!/^([\u3400-\u9fffA-Za-z0-9（）()\-]){1,40}$/.test(section))throw Error('行政區或地段格式錯誤');
 lot=normalizeLot(lot);const result=await officialForm(district,section,lot),code=result.sectionCode;
 const layers=(await meta('kl_sec')).layers.filter(l=>l.name===code);if(layers.length!==1)throw Error('官方地籍圖層未找到對應地段');
 const layer=layers[0].id,features=(await rest(`KL_UPGIS/kl_sec/MapServer/${layer}/query`,{where:`LANDNO='${lot}' OR LANDNOE='${lot}'`,outFields:'*',returnGeometry:'true'})).features||[];
 if(features.length!==1)throw Error('官方地籍查詢未取得唯一宗地');const feature=features[0],geom=feature.geometry;geom.spatialReference={wkid:3828};
 const requestedDistrict=district;let districtVerification='unavailable';
 try{
  const admin=(await rest('KL_UPGIS/kl_admi/MapServer/2/query',{geometry:JSON.stringify(geom),geometryType:'esriGeometryPolygon',inSR:3828,outFields:'TNAME',returnGeometry:'false'})).features||[],names=[...new Set(admin.map(x=>x.attributes.TNAME))];
  if(names.length===1&&DISTRICTS.includes(names[0])){district=names[0];districtVerification=district===requestedDistrict?'matched':'corrected_from_official_boundary';if(district!==requestedDistrict)result.formNotes+=` 官方行政界核對：輸入${requestedDistrict}，本筆圖形位於${district}，結果已更正行政區。`}
  else if(names.length>1)districtVerification='multiple_boundary_intersections';
 }catch{}
 let zones=await spatialQuery(4,geom),context=zones.map(z=>({attributes:z.attributes,geometry:z.geometry})),roads=context.filter(z=>z.attributes.LUSE==='道路用地').map(z=>z.geometry);
 if(zones.length){
  const intersections=(await rest(engine.GEO+'intersect',{sr:3828,geometries:engine.collection(zones.map(z=>z.geometry)),geometry:JSON.stringify({geometryType:'esriGeometryPolygon',geometry:geom})})).geometries||[];
  if(intersections.length!==zones.length)throw Error('分區交集回應不完整，無法可靠計算占比');
  zones=zones.map((z,i)=>({...z,intersection:intersections[i],overlapArea:geometryArea(intersections[i])})).filter(z=>z.overlapArea>.01);
 }
 const pts=geom.rings.flat(),xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]),bbox=[Math.min(...xs)-60,Math.min(...ys)-60,Math.max(...xs)+60,Math.max(...ys)+60];
 const nearby=await rest(`KL_UPGIS/kl_sec/MapServer/${layer}/query`,{geometry:bbox.join(','),geometryType:'esriGeometryEnvelope',inSR:3828,outFields:'LANDNO,AREA',returnGeometry:'true'}),plans=await spatialQuery(7,geom);
 await engine.assign(zones,blockInfo);zones=await engine.spatialOverrides(zones,plans,rest,geometryArea);
 const summary=engine.aggregate(zones),geometricArea=geometryArea(geom),mappedArea=zones.reduce((n,z)=>n+z.overlapArea,0);
 summary.parcelGeometryArea=geometricArea;summary.mappingComplete=Math.abs(mappedArea-geometricArea)<Math.max(.1,geometricArea*.001);summary.areaComplete=summary.areaComplete&&summary.mappingComplete;
 const known=zones.filter(z=>z.rule.supported&&!z.rule.excluded).map(z=>z.rule),ratios=new Set(known.map(r=>r.bcr+','+r.far));
 const rules={supported:!!known.length,bcr:ratios.size===1?known[0].bcr:null,far:ratios.size===1?known[0].far:null,mixed:ratios.size>1,title:'依每塊分區的現行計畫分別配對',source:known[0]?.source||result.formUrl,page:'詳逐分區來源與全文',verification:'未配對分區不套用其他計畫數值；混合分區的建蔽與容積依交集面積分別加總。',setback:{status:'逐分區條件與圖面試算',distance:null,text:'詳下列逐分區條文與候選範圍。'}};
 if(context.length){
  const rect={rings:[[[bbox[0],bbox[1]],[bbox[0],bbox[3]],[bbox[2],bbox[3]],[bbox[2],bbox[1]],[bbox[0],bbox[1]]]]};
  const clipped=(await rest(engine.GEO+'intersect',{sr:3828,geometries:engine.collection(context.map(f=>f.geometry)),geometry:JSON.stringify({geometryType:'esriGeometryPolygon',geometry:rect})})).geometries||[];
  if(clipped.length!==context.length)throw Error('鄰接分區裁切不完整');context=context.map((f,i)=>({attributes:f.attributes,geometry:clipped[i]}));roads=context.filter(f=>f.attributes.LUSE==='道路用地').map(f=>f.geometry);
 }
 let roadNames=[];const evidenceNotes=[];
 if(roads.length&&zones.some(z=>engine.PLANS[z.rule.planId]?.namedRoads?.length)){
  try{
   roadNames=(await rest('KL_UPGIS/kl_basic/MapServer/4/query',{geometry:bbox.join(','),geometryType:'esriGeometryEnvelope',inSR:3828,outFields:'ROADNAME,ROADNO,ROADKIND',returnGeometry:'true'})).features||[];
   if(roadNames.length){
    const union=(await rest(engine.GEO+'union',{sr:3828,geometries:engine.collection(roads)})).geometry;if(!union)throw Error('道路聯集失敗');
    const clips=(await rest(engine.GEO+'intersect',{sr:3828,geometries:JSON.stringify({geometryType:'esriGeometryPolyline',geometries:roadNames.map(f=>f.geometry)}),geometry:JSON.stringify({geometryType:'esriGeometryPolygon',geometry:union})})).geometries||[];
    if(clips.length!==roadNames.length)throw Error('道路名稱線裁切不完整');roadNames=roadNames.map((f,i)=>({attributes:f.attributes,geometry:clips[i]})).filter(f=>f.geometry.paths?.length);
   }
  }catch{roadNames=[];evidenceNotes.push('道路名稱比對服務不足，本次保留指定路段分支，不選定路名。')}
 }
 engine.resolve(zones,context,roads,roadNames,geometricArea,{section,lot});
 const candidates=[...await engine.envelopes(zones,roads,geom,rest,geometryArea),...await engine.bonusEnvelopes(zones,roads,geom,rest,geometryArea)];
 for(const z of zones)for(const spec of z.rule.adjacentConstraints||[])delete spec.geometries;
 const automatic=candidates.flatMap((c,i)=>c.automatic&&c.status==='ok'?[i]:[]);
 Object.assign(summary,{automaticEnvelopeIndex:automatic.length===1&&known.length===1?automatic[0]:-1,automaticZoneCount:new Set(automatic.map(i=>candidates[i].zoneIndex)).size,requiresAssembly:zones.some(z=>z.rule.conditions.some(c=>c.status==='requires_assembly')),specifiedBoundaryPending:zones.some(z=>z.rule.resolution.status==='specified_boundary_missing'),evidenceNotes});
 return {...result,district,section,lot,parcel:feature,requestedDistrict,districtVerification,zones,nearby:(nearby.features||[]).slice(0,300),nearbyLimited:!!nearby.exceededTransferLimit||(nearby.features||[]).length>300,plans:plans.map(p=>p.attributes),rules,...summary,envelopes:candidates,version:'3.0',timestamp:new Date().toISOString(),parcelSource:REST+`KL_UPGIS/kl_sec/MapServer/${layer}`,zoneSource:REST+'KL_UPGIS/kl_uplan/MapServer/4',warnings:['圖資坐標為TWD67／TM2 121（EPSG:3828），非TWD97。','AREA為官方圖層面積，非本系統取得之土地登記謄本面積。','相交分區採官方幾何服務裁切；圖籍套合誤差與道路境界須由主管機關確認。','綠色候選範圍僅試算所選道路退縮條件；尚未包含指定附圖、河川／鄰地退縮、騎樓、建築線、坡度、通行、最小基地及回饋等全部條件，非正式可建範圍。']};
}
const ALLOWED=new Set(['https://swentsan.github.io']);
export async function handleRequest(request){
 const url=new URL(request.url),origin=request.headers.get('Origin'),headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 if(origin&&origin!==url.origin&&!ALLOWED.has(origin))return new Response('Forbidden',{status:403,headers});
 if(origin&&ALLOWED.has(origin)){headers['Access-Control-Allow-Origin']=origin;headers.Vary='Origin'}
 const json=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8'}});
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, OPTIONS'}});
 if(request.method!=='GET')return json({error:'僅提供唯讀查詢。'},405);
 if(request.url.length>8192)return json({error:'查詢參數過長'},414);
 try{
  const q=url.searchParams;
  if(url.pathname==='/api/health')return json({ok:true,version:'3.0',runtime:'cloud',reviewedAt:engine.REGISTRY.reviewedAt});
  if(url.pathname==='/api/catalog'){const values=Object.values(engine.PLANS);return json({version:'3.0',reviewedAt:engine.REGISTRY.reviewedAt,plans:engine.REGISTRY.catalog.map(c=>({...c,rateCount:Object.keys(engine.PLANS[c.planId]?.rates||{}).length})),rulePlanCount:values.filter(p=>Object.keys(p.rates||{}).length).length,rateCount:values.reduce((n,p)=>n+Object.keys(p.rates||{}).length,0)})}
  if(url.pathname==='/api/rules')return engine.PLANS[q.get('id')]?json(engine.PLANS[q.get('id')]):json({},404);
  if(url.pathname==='/api/sections')return json({sections:await sections(),source:SITE+'landuseNew/qsec_landuse.aspx'});
  if(url.pathname==='/api/lookup')return json(await lookup(q.get('district')||'',q.get('section')||'',q.get('lot')||''));
  if(url.pathname==='/api/map'){
   const service=q.get('service'),bbox=(q.get('bbox')||'').split(',').map(Number);
   if(!['kl_basic','kl_uplan','kl_ortho'].includes(service)||bbox.length!==4||!bbox.every(Number.isFinite)||!(bbox[2]-bbox[0]>0&&bbox[2]-bbox[0]<=5000&&bbox[3]-bbox[1]>0&&bbox[3]-bbox[1]<=5000))throw Error('圖面參數錯誤');
   const params={f:'image',bbox:bbox.join(','),bboxSR:3828,imageSR:3828,size:'1000,650',format:'png32',transparent:'true',dpi:96};if(service==='kl_uplan')params.layers='show:4';
   const bytes=await fetchOfficial(REST+'KL_UPGIS/'+service+'/MapServer/export?'+new URLSearchParams(params));
   if(bytes[0]!==137||bytes[1]!==80||bytes[2]!==78||bytes[3]!==71)throw Error('官方未回傳有效圖面');return new Response(bytes,{headers:{...headers,'Content-Type':'image/png'}});
  }
  if(url.pathname==='/')return new Response('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>基隆土地評估查詢服務</title><body style="font:18px/1.8 system-ui;padding:8vw;background:#f3f5ef;color:#193b36"><h1>基隆土地評估查詢服務</h1><p>提供官方都市計畫、地籍套繪與退縮條件分析。</p><p><a href="https://swentsan.github.io/keelung-land-use-checker/v3/">開啟建案評估系統 →</a></p><p>不儲存個案資料。未確認條件保留待核對，試算不等於正式可建範圍。</p></body></html>',{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
  return json({error:'Not found'},404);
 }catch(e){console.error('Official lookup failure',url.pathname,e.message);return json({error:e.message||'官方連線或資料處理失敗，請稍後重試。'},502)}
}
