import json,re,unicodedata,copy,time
from pathlib import Path
REGISTRY=json.loads((Path(__file__).parent/'rules.json').read_text('utf-8'))
PLANS=REGISTRY['plans'];CATALOG={x['code']:x for x in REGISTRY['catalog']}
NUMS={'一':'1','二':'2','三':'3','四':'4','五':'5','六':'6'}
def norm(z):return re.sub(r'\s+','',unicodedata.normalize('NFKC',z)).replace('之1','之一').replace('之2','之二')
def zone_key(z):
 z=norm(z)
 for prefix,head in [('住宅區','R'),('商業區','C'),('特種住宅區','SR'),('特別住宅區','SR'),('漁港專用區','F'),('乙種工業區','I'),('倉儲區','W')]:
  if z==prefix and head in 'RC':return head
  m=re.fullmatch(re.escape(prefix)+r'\((?:住|商|特住|漁專|乙工|倉儲|倉)?([一二三四五六])(?:之([一二]))?\)',z)
  if m:return head+NUMS[m[1]]+('-'+NUMS[m[2]] if m[2] else '')
 return z
def excluded(z):return any(x in z for x in ['道路','人行步道','高速公路','快速公路','河道','河川','水域','海堤','保護區','農業區'])
def classify(z):
 if '住宅' in z:return 'residential'
 if '商業' in z:return 'commercial'
 if '工業' in z or '倉儲' in z:return 'industrial'
 if z.endswith('用地') or '用地(' in z:return 'public'
 return 'other'
def select_rule(plan_id,zone):
 p=PLANS.get(str(plan_id),{});k=zone_key(zone);rates=p.get('rates',{});alias=k
 # Only explicitly unqualified school rules cover all school subtypes. Never
 # remove a housing condition, grade or numeral to force a match.
 if k not in rates and k.startswith('學校用地(') and '學校用地' in rates:alias='學校用地'
 explicit={'306':{'機關用地(供環保局使用)':'機關用地'},'75':{'醫護特定專用區':'醫護專用區'},'247':{'住宅區(整體開發)':'R'},'164':{'果菜批發市場用地':'批發市場用地'}}
 alias=explicit.get(str(plan_id),{}).get(k,alias)
 pair=rates.get(alias);kind=classify(zone);setbacks=p.get('setbacks',{})
 sb=setbacks.get(k) or setbacks.get(kind) or (setbacks.get('residential') if kind=='commercial' else None) or setbacks.get('all')
 # Exceptions must override the public-facility generic clause.
 if '市場用地' in zone and str(plan_id) in ['290','296','302','309','322','335','369']:
  sb=setbacks.get('residential')
 if kind=='industrial' and str(plan_id)=='263':sb=p.get('setbacks',{}).get('industrial',sb)
 return {'planId':str(plan_id),'zoneKey':k,'supported':pair is not None,'bcr':pair[0] if pair else None,'far':pair[1] if pair else None,
  'excluded':excluded(zone),'source':p.get('source',f'https://upgis.klcg.gov.tw/KL_LAND/uplan/View.asp?ID={plan_id}'),
  'pageRefs':p.get('pageRefs',[]),'note':p.get('note',''),'setback':copy.deepcopy(sb) if sb else {'distances':[],'text':'本資料尚未確認可直接數值化的退縮條件；不等於退縮0m。'},
  'status':'道路／非一般可建基地，排除面積情境' if excluded(zone) else '已配對數值' if pair else '此分區數值或適用條件待核對'}

def assign(zones,fetch,decode,plain,cache):
 for z in zones:
  a=z['attributes'];code=a.get('LCODEB','');c=CATALOG.get(code,{});block=a.get('BLOCK_DEF','');pid='';err=''
  try:
   if block not in cache or time.time()-cache[block][2]>3600:
    text=decode(fetch('https://upgis.klcg.gov.tw/KL_LAND/landuseNew/show_lu_byXY.aspx?fv='+block))
    ids=list(dict.fromkeys(re.findall(r'View.asp\?ID=([\d-]+)',text,re.I)))
    cache[block]=(ids,plain(text)[-2200:],time.time())
   ids,info,checked=cache[block]
   if len(ids)==1:pid=ids[0]
   else:err='街廓現行計畫回應不唯一；不以相交歷程猜選計畫。'
  except Exception:err='街廓現行計畫查詢失敗；本次不套用快照的數值規則。'
  base_pid=pid
  override={'B0062':'387','B0045':'387','B0067':'376','B0068':'377'}
  accepted={'B0062':{'347','387'},'B0045':{'347','387'},'B0067':{'105','376'},'B0068':{'377'}}
  if code in override and pid in accepted[code]:
   newer=override[code]
   if pid!=newer:err=f'圖台街廓回傳案號{pid}；此範圍另依已核對的發布案{newer}處理。版本核對日2026-11-02。'
   pid=newer
  # B0063's surviving warehouse has a specific current industrial plan; do not
  # apply the historic business-zone rate to a warehouse.
  if code=='B0063' and a.get('LUSE')=='倉儲區(五)':pid='375' if pid else ''
  r=select_rule(pid,a.get('LUSE',''));r.update(planName=c.get('name',''),detailCode=code,block=block,matchingNote=err,officialBasePlanId=base_pid)
  if code=='B0069' and pid=='380':
   r['planName']='學校用地恢復原分區案（圖台B0069標題有誤）'
   r['matchingNote']='細計範圍標題與街廓現行案不一致；依現行案380核對，不套用獅球嶺388。'
  required=PLANS.get(pid,{}).get('requiredBasePlan')
  if required and base_pid not in {required,pid}:
   r.update(supported=False,bcr=None,far=None,status='密度轉接所需原計畫不符，保留待核對')
  if not pid:r['status']=err or '無法確認現行計畫'
  z['rule']=r
 return zones

GEO='Utilities/Geometry/GeometryServer/'
def collection(gs):return json.dumps({'geometryType':'esriGeometryPolygon','geometries':gs})

def apply_spatial_overrides(zones,cases,rest,area):
 # Use the actual published-case footprint, never a mismatched detail-plan title.
 for case in cases:
  if str(case['attributes'].get('PLANNO'))!='388':continue
  if not case.get('geometry'):continue
  clips=rest(GEO+'intersect',{'sr':3828,'geometries':collection([z['intersection'] for z in zones]),'geometry':json.dumps({'geometryType':'esriGeometryPolygon','geometry':case['geometry']})}).get('geometries',[])
  if len(clips)!=len(zones):raise ValueError('新發布計畫範圍交集不完整')
  updated=[]
  for z,g in zip(zones,clips):
   value=area(g)
   if value<=.01:updated.append(z);continue
   inside=copy.deepcopy(z);inside.update(intersection=g,overlapArea=value)
   r=select_rule('388',z['attributes']['LUSE']);r.update(planName=case['attributes']['PLANNAME'],detailCode=z['attributes'].get('LCODEB',''),block=z['attributes'].get('BLOCK_DEF',''),officialBasePlanId=z['rule'].get('officialBasePlanId',''),matchingNote='依官方發布案388的實際空間範圍裁切配對，不依細計代碼名稱推定。',scopeSource='https://upgis.klcg.gov.tw/arcgiswa/rest/services/KL_UPGIS/kl_uplan/MapServer/7')
   inside['rule']=r;updated.append(inside)
   if z['overlapArea']-value>.01:
    outside=difference(rest,[z['intersection']],case['geometry'])[0];remaining=copy.deepcopy(z);remaining.update(intersection=outside,overlapArea=area(outside));updated.append(remaining)
  zones=updated
 return zones
def difference(rest,geoms,cutter):
 out=rest(GEO+'difference',{'sr':3828,'geometries':collection(geoms),'geometry':json.dumps({'geometryType':'esriGeometryPolygon','geometry':cutter})})
 if len(out.get('geometries',[]))!=len(geoms):raise ValueError('退縮裁切回應不完整')
 return out['geometries']
def envelopes(zones,roads,parcel,rest,area):
 output=[];buffer_cache={}
 for index,z in enumerate(zones):
  r=z['rule'];sb=r['setback'];distances=sb.get('distances',[])
  if not r['supported'] or r['excluded'] or not distances:continue
  for dist in distances:
   row={'zoneIndex':index,'zone':z['attributes']['LUSE'],'distance':dist,'condition':sb['text'],'boundary':sb.get('boundary','road'),'status':'ok','automatic':r.get('resolution',{}).get('status','').startswith('automatic'),'additionalConstraints':[]}
   try:
    if sb.get('boundary')=='parcel':
     shrink=rest(GEO+'buffer',{'inSR':3828,'outSR':3828,'bufferSR':3828,'geometries':collection([parcel]),'distances':-dist,'unit':9001,'unionResults':'true'})['geometries']
     if not shrink:result={'rings':[]}
     else:
      result=rest(GEO+'intersect',{'sr':3828,'geometries':collection([z['intersection']]),'geometry':json.dumps({'geometryType':'esriGeometryPolygon','geometry':shrink[0]})})['geometries'][0]
    else:
     if not roads:raise ValueError('未辨識與本宗地相交／相接的計畫道路；不可推論免退縮')
     if dist not in buffer_cache:
      buffs=rest(GEO+'buffer',{'inSR':3828,'outSR':3828,'bufferSR':3828,'geometries':collection(roads),'distances':dist,'unit':9001,'unionResults':'true'})['geometries']
      if len(buffs)!=1:raise ValueError('道路緩衝區回應不完整')
      buffer_cache[dist]=buffs[0]
     result=difference(rest,[z['intersection']],buffer_cache[dist])[0]
    row['areaBeforeAdditional']=area(result)
    for spec in r.get('adjacentConstraints',[]):
     geometries=spec.get('geometries',[])
     if not geometries:continue
     buffers=rest(GEO+'buffer',{'inSR':3828,'outSR':3828,'bufferSR':3828,'geometries':collection(geometries),'distances':spec['distance'],'unit':9001,'unionResults':'true'}).get('geometries',[])
     if len(buffers)!=1:raise ValueError('鄰接分區退縮緩衝回應不完整')
     result=difference(rest,[result],buffers[0])[0]
     row['additionalConstraints'].append({k:v for k,v in spec.items() if k!='geometries'})
    value=area(result)
    if not 0<=value<=z['overlapArea']+.02:raise ValueError('退縮面積檢核失敗')
    row.update(geometry=result,area=value,coverage=min(value,z['overlapArea']*r['bcr']/100),far=z['overlapArea']*r['far']/100)
   except Exception as e:row.update(status='unavailable',message=str(e))
   output.append(row)
 return output

def aggregate(zones):
 eligible=[z for z in zones if not z['rule']['excluded']]
 known=[z for z in eligible if z['rule']['supported']]
 missing=[z for z in eligible if not z['rule']['supported'] and z['overlapArea']>.01]
 base=sum(z['overlapArea'] for z in known)
 return {'estimatedBaseArea':base if known else None,'estimatedCoverage':sum(z['overlapArea']*z['rule']['bcr']/100 for z in known) if known else None,
  'estimatedFar':sum(z['overlapArea']*z['rule']['far']/100 for z in known) if known else None,'areaComplete':bool(known) and not missing,
  'unknownArea':sum(z['overlapArea'] for z in missing),'excludedArea':sum(z['overlapArea'] for z in zones if z['rule']['excluded'])}
