"""Spatial evidence and explicit conditions, independent of the financial model."""
import math,copy
def segment_distance(p,a,b):
 dx=b[0]-a[0];dy=b[1]-a[1];den=dx*dx+dy*dy
 t=max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)) if den else 0
 return math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)
def line_distance(p,paths):
 return min((segment_distance(p,a,b) for path in paths for a,b in zip(path,path[1:])),default=float('inf'))
def inside(p,g):
 value=False;x,y=p
 for ring in g.get('rings',[]):
  for a,b in zip(ring,ring[1:]):
   if (a[1]>y)!=(b[1]>y) and x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:value=not value
 return value
def polygon_distance(p,g):return 0 if inside(p,g) else line_distance(p,g.get('rings',[]))
def frontage_points(geom,roads):
 # Only edges lying on a planning-road polygon are sampled, not all parcel edges.
 points=[]
 for ring in geom.get('rings',[]):
  for a,b in zip(ring,ring[1:]):
   length=math.dist(a,b)
   if length<.5:continue
   samples=[[(1-t)*a[0]+t*b[0],(1-t)*a[1]+t*b[1]] for t in [.2,.5,.8]]
   if all(min((polygon_distance(p,g) for g in roads),default=99)<.08 for p in samples):points+=samples
 return points
def match_road_name(geom,roads,features):
 points=frontage_points(geom,roads);evidence=[]
 if not points:return {'status':'unresolved','reason':'未取得可辨識的相接計畫道路邊界','samples':[]}
 for point in points:
  distances={}
  for f in features:
   name=(f['attributes'].get('ROADNAME') or '').strip()
   if name in ['','無路名']:name='〈未命名道路〉'
   distance=line_distance(point,f['geometry'].get('paths',[]))
   distances[name]=min(distances.get(name,float('inf')),distance)
  ordered=sorted(distances.items(),key=lambda item:item[1])
  if not ordered or ordered[0][0]=='〈未命名道路〉' or ordered[0][1]>25 or len(ordered)>1 and ordered[1][1]-ordered[0][1]<4:
   return {'status':'unresolved','reason':'相接道路名稱不唯一、交叉口或名稱線距離過大','samples':evidence}
  evidence.append({'point':point,'roadName':ordered[0][0],'distanceToNameLine':round(ordered[0][1],3)})
 names=set(x['roadName'] for x in evidence)
 if len(names)!=1:return {'status':'unresolved','reason':'多面臨路，無法以單一道路名稱決定全部退縮','samples':evidence}
 return {'status':'spatial_match','roadName':next(iter(names)),'samples':evidence,'reason':'相接邊界採樣比對官方道路名稱線；未使用最近地址或手動輸入路名'}
def conditions_for(rule,plan,zone,area):
 result=[];key=rule['zoneKey']
 for spec,items in plan.get('conditions',{}).items():
  matches=spec in ['all',zone,key] or spec=='specialResidential' and ('特種住宅' in zone or '特別住宅' in zone)
  if not matches:continue
  for item in items:
   item=copy.deepcopy(item)
   if 'minimumArea' in item:
    item.update(observedArea=area,status='meets_single_parcel_area' if area>=item['minimumArea'] else 'requires_assembly')
   result.append(item)
 return result
def resolve(zones,context,roads,road_names,plans,parcel_area,parcel_identity=None):
 for z in zones:
  r=z['rule'];plan=plans.get(r['planId'],{});kind=('residential' if '住宅' in z['attributes']['LUSE'] else 'commercial' if '商業' in z['attributes']['LUSE'] else 'industrial' if any(s in z['attributes']['LUSE'] for s in ['工業','倉儲']) else 'public')
  r['conditions']=conditions_for(r,plan,z['attributes']['LUSE'],parcel_area)
  if parcel_identity:
   for item in plan.get('parcelConditions',[]):
    if item['section']==parcel_identity.get('section') and parcel_identity.get('lot') in item['lots']:
     r['conditions'].append({**{k:v for k,v in item.items() if k not in ['section','lots']},'status':'specified_lot_match','source':plan['source']})
  r['bonusOptions']=[]
  for option in plan.get('bonusOptions',{}).get(r['zoneKey'],[]):
   option=copy.deepcopy(option)
   option.update(source=plan['source'],observedArea=z['overlapArea'],areaStatus='requires_whole_block_evidence' if option.get('wholeBlock') else 'area_threshold_met' if z['overlapArea']>=option['minimumArea'] else 'requires_assembly',status='not_approved')
   r['bonusOptions'].append(option)
  r['densitySource']=plan.get('densitySource','')
  r['resolution']={'status':'conditional','reason':'路寬／附圖／指定位置尚不足以唯一選定','distance':None}
  sb=r['setback']
  if not sb.get('distances'):r['resolution']={'status':'missing_rule','reason':sb['text'],'distance':None}
  if sb.get('auto') and len(sb.get('distances',[]))==1:
   r['resolution']={'status':'automatic','reason':'已配對不依路寬分支的明文退縮條款','distance':sb['distances'][0]}
  if any(c['status']=='specified_lot_match' for c in r['conditions']):
   sb.update(distances=[],auto=False,text='命中計畫指定地號，但原圖指定邊界及地號沿革尚未唯一確認；停止以一般退縮方案代替。')
   r['resolution']={'status':'specified_boundary_missing','distance':None,'reason':sb['text']}
  named=[item for item in plan.get('namedRoads',[]) if kind in item['kinds']]
  if named:
   evidence=match_road_name(z['intersection'],roads,road_names);r['roadEvidence']=evidence
   exact=[item for item in named if evidence.get('roadName')==item['name']]
   if exact:
    item=exact[0];sb.update(distances=[item['distance']],auto=True,text=f"臨{item['name']}：{item['distance']}m；依官方圖資空間比對選定。基本圖名稱線仍非正式建築線。")
    r['resolution']={'status':'automatic_spatial','distance':item['distance'],'reason':'明文指定路名與相接道路空間比對相符','source':plan['source'],'page':item['page']}
  r['adjacentConstraints']=[]
  for spec in plan.get('adjacentBuffers',[]):
   if spec.get('zone') and spec['zone']!=z['attributes']['LUSE']:continue
   if spec.get('kinds') and kind not in spec['kinds']:continue
   targets=[f for f in context if (spec.get('differentZone') and f['attributes']['LUSE']!=z['attributes']['LUSE'] or f['attributes']['LUSE'] in spec.get('zones',[]))]
   r['adjacentConstraints'].append({**{k:v for k,v in spec.items() if k not in ['zones','differentZone','kinds','zone']},'targetZones':sorted(set(f['attributes']['LUSE'] for f in targets)),'geometries':[f['geometry'] for f in targets],'source':plan['source'],'status':'mapped' if targets else 'no_intersecting_target'})
 return zones

def bonus_envelopes(zones,roads,parcel,engine,rest,area):
 output=[]
 for index,z in enumerate(zones):
  for option in z['rule'].get('bonusOptions',[]):
   # A base-area threshold is necessary but never sufficient for approval.
   if option['areaStatus']!='area_threshold_met':continue
   clone=copy.deepcopy(z);r=clone['rule']
   r.update(bcr=option['bcr'],far=option['far'],resolution={'status':'conditional_bonus'})
   r['setback']={'distances':[option['distance']],'text':option['label']+'；須合併開發、採建蔽45%及道路退5m，尚未核准。','auto':False}
   rows=engine.envelopes([clone],roads,parcel,rest,area)
   for row in rows:row.update(zoneIndex=index,variant=option['label'],bcr=option['bcr'],farPercent=option['far'],approvalStatus='not_approved')
   output+=rows
 return output
