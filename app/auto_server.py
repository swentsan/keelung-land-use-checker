"""Local, read-only adapter for the public Keelung planning map. Standard library only."""
import argparse, datetime, html, http.cookiejar, json, math, re, threading, time
import urllib.error, urllib.parse, urllib.request
import rule_engine as engine
import site_analysis
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE = 'https://upgis.klcg.gov.tw/KL_LAND/'
REST = 'https://upgis.klcg.gov.tw/arcgiswa/rest/services/'
DISTRICTS = ['中山區','中正區','仁愛區','信義區','安樂區','暖暖區','七堵區']
CACHE = {}
BLOCK_CACHE = {}
LOCK = threading.Lock()

def fetch(url, data=None, opener=None):
    request = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode() if data else None,
                                     headers={'User-Agent':'KeelungLandAssessment/1.0'})
    with (opener.open if opener else urllib.request.urlopen)(request, timeout=30) as r:
        body = r.read(20_000_001)
        if len(body)>20_000_000: raise ValueError('官方回應超過大小限制')
        return body

def decode(body):
    try: return body.decode('utf-8-sig')
    except UnicodeDecodeError: return body.decode('big5', errors='replace')

def plain(text):
    text = re.sub(r'<(script|style)\b[^>]*>.*?</\1>', '', text, flags=re.I|re.S)
    text = re.sub(r'<br\s*/?>|</(?:p|tr|div)>', '\n', text, flags=re.I)
    return html.unescape(re.sub('<[^>]+>', '', text)).strip()

def rest(path, params=None):
    obj=json.loads(fetch(REST+path, {'f':'json', **(params or {})}))
    if obj.get('error'): raise ValueError('官方圖資服務錯誤：'+str(obj['error'].get('message','')))
    return obj

def meta(service):
    with LOCK: saved=CACHE.get(service)
    if saved and time.time()-saved[0]<3600: return saved[1]
    obj=rest('KL_UPGIS/'+service+'/MapServer')
    with LOCK: CACHE[service]=(time.time(),obj)
    return obj

def normalize_lot(value):
    value=str(value).strip().replace('地號','').replace('號','').replace('－','-')
    if not re.fullmatch(r'\d{1,4}(?:-\d{1,4})?',value): raise ValueError('地號格式應為615或615-1')
    parts=list(map(int,value.split('-')))
    if parts[0]==0: raise ValueError('地號母號不可為0')
    return str(parts[0])+('-'+str(parts[1]) if len(parts)>1 and parts[1] else '')

def section_options():
    with LOCK:saved=CACHE.get('official-sections')
    if saved and time.time()-saved[0]<3600:return saved[1]
    opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    url=SITE+'landuseNew/qsec_landuse.aspx';t=decode(fetch(url,opener=opener))
    fields={k:html.unescape(v) for k,v in re.findall(r'name="([^"]+)"[^>]*value="([^"]*)"',t) if k.startswith('__')}
    fields.update(TextBox1='',Button2='搜尋',sel3='七堵區',sel1='請選擇',TextBox2='')
    t=decode(fetch(url,fields,opener));select=re.search(r'<select\b[^>]*name="sel1"[^>]*>(.*?)</select>',t,re.S|re.I)
    if not select:raise ValueError('官方地段選單讀取失敗')
    values=[{'code':code,'name':plain(label)} for code,label in re.findall(r'<option[^>]*value="([^"]+)"[^>]*>(.*?)</option>',select[1],re.S) if re.fullmatch(r'(?:CD\d{4}|\d{5})',code)]
    if not values:raise ValueError('官方地段選單沒有有效項目')
    with LOCK:CACHE['official-sections']=(time.time(),values)
    return values

def official_form(district, section, lot):
    opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    url=SITE+'landuseNew/qsec_landuse.aspx'
    def hidden(t):
        return {a:html.unescape(v) for a,v in re.findall(r'name="([^"]+)"[^>]*value="([^"]*)"',t) if a.startswith('__')}
    t=decode(fetch(url,opener=opener));fields=hidden(t)
    # The official search box truncates long compound section names. Search the
    # parent section keyword, then require an exact full-name match below.
    fields.update(TextBox1=section.split('段')[0],Button2='搜尋',sel3=district,sel1='請選擇',TextBox2='')
    t=decode(fetch(url,fields,opener))
    select=re.search(r'<select\b[^>]*name="sel1"[^>]*>(.*?)</select>',t,re.S|re.I)
    options=re.findall(r'<option[^>]*value="([^"]+)"[^>]*>(.*?)</option>',select[1],re.S) if select else []
    exact=[code for code,label in options if plain(label).replace(' ','')==section.replace(' ','')]
    if len(exact)!=1: raise ValueError('官方地段選單未取得唯一相符地段，請核對地段及小段全名')
    code=exact[0]; fields=hidden(t)
    fields.update(TextBox1=section,sel3=district,sel1=code,TextBox2=lot,Button1='查詢並定位')
    t=decode(fetch(url,fields,opener))
    def op(i):
        m=re.search(r'<span\b[^>]*id="Op'+str(i)+r'"[^>]*>(.*?)</span>',t,re.S|re.I)
        return m[1] if m else ''
    zone=plain(op(1)); plan=plain(op(2)); history=plain(op(3))
    if not zone or '查無' in zone: raise ValueError('官方表單查無此地號分區資料')
    ids=re.findall(r'View.asp\?ID=([\d-]+)',op(3),re.I)
    return {'sectionCode':code,'zone':zone,'plan':plan,'history':history,'planIds':list(dict.fromkeys(ids)),
            'formUrl':url,'formNotes':plain(op(4)+'\n'+op(5))}

def geometry_area(geometry):
    # ArcGIS rings: exterior and hole orientation carry opposite signed areas.
    def area(ring):
        if len(ring)<3: return 0
        x0,y0=ring[0]
        q=[(x-x0,y-y0) for x,y in ring]
        return sum(a[0]*q[(i+1)%len(q)][1]-q[(i+1)%len(q)][0]*a[1] for i,a in enumerate(q))/2
    return abs(sum(area(r) for r in geometry.get('rings',[])))

def spatial_query(layer, geometry, geometry_type='esriGeometryPolygon'):
    return rest('KL_UPGIS/kl_uplan/MapServer/'+str(layer)+'/query',
                {'geometry':json.dumps(geometry),'geometryType':geometry_type,'inSR':3828,
                 'spatialRel':'esriSpatialRelIntersects','outFields':'*','returnGeometry':'true'})['features']


def lookup(district,section,lot):
    if district not in DISTRICTS or not re.fullmatch(r'[\u3400-\u9fffA-Za-z0-9（）()\-]{1,40}',section): raise ValueError('行政區或地段格式錯誤')
    lot=normalize_lot(lot)
    result=official_form(district,section,lot);code=result['sectionCode']
    layers=[l for l in meta('kl_sec')['layers'] if l['name']==code]
    if len(layers)!=1: raise ValueError('官方地籍圖層未找到對應地段')
    layer=layers[0]['id']; parcel=rest(f'KL_UPGIS/kl_sec/MapServer/{layer}/query',
        {'where':f"LANDNO='{lot}' OR LANDNOE='{lot}'",'outFields':'*','returnGeometry':'true'})
    features=parcel.get('features',[])
    if len(features)!=1: raise ValueError('官方地籍查詢未取得唯一宗地')
    feature=features[0];geom=feature['geometry'];geom['spatialReference']={'wkid':3828}
    requested_district=district;district_verification='unavailable'
    try:
        administrative=rest('KL_UPGIS/kl_admi/MapServer/2/query',{'geometry':json.dumps(geom),'geometryType':'esriGeometryPolygon','inSR':3828,'outFields':'TNAME','returnGeometry':'false'}).get('features',[])
        names=set(x['attributes']['TNAME'] for x in administrative)
        if len(names)==1 and next(iter(names)) in DISTRICTS:
            district=next(iter(names));district_verification='matched' if district==requested_district else 'corrected_from_official_boundary'
            if district!=requested_district:result['formNotes']+=' 官方行政界核對：輸入'+requested_district+'，本筆圖形位於'+district+'，結果已更正行政區。'
        elif len(names)>1:district_verification='multiple_boundary_intersections'
    except Exception:pass
    zones=spatial_query(4,geom)
    context_zones=[{'attributes':z['attributes'],'geometry':z['geometry']} for z in zones]
    road_geoms=[z['geometry'] for z in zones if z['attributes'].get('LUSE')=='道路用地']
    if zones:
        intersect=rest('Utilities/Geometry/GeometryServer/intersect',{'sr':3828,
            'geometries':json.dumps({'geometryType':'esriGeometryPolygon','geometries':[z['geometry'] for z in zones]}),
            'geometry':json.dumps({'geometryType':'esriGeometryPolygon','geometry':geom})})
        intersections=intersect.get('geometries',[])
        if len(intersections)!=len(zones): raise ValueError('分區交集回應不完整，無法可靠計算占比')
        for z,g in zip(zones,intersections): z['intersection']=g;z['overlapArea']=geometry_area(g)
        zones=[z for z in zones if z['overlapArea']>0.01]
    pts=[p for ring in geom['rings'] for p in ring];xs=[p[0] for p in pts];ys=[p[1] for p in pts]
    bbox=[min(xs)-60,min(ys)-60,max(xs)+60,max(ys)+60]
    nearby=rest(f'KL_UPGIS/kl_sec/MapServer/{layer}/query',{'geometry':','.join(map(str,bbox)),
        'geometryType':'esriGeometryEnvelope','inSR':3828,'outFields':'LANDNO,AREA','returnGeometry':'true'})
    plans=spatial_query(7,geom)
    engine.assign(zones,fetch,decode,plain,BLOCK_CACHE)
    zones=engine.apply_spatial_overrides(zones,plans,rest,geometry_area)
    summary=engine.aggregate(zones)
    geometric_area=geometry_area(geom)
    mapped_area=sum(z['overlapArea'] for z in zones)
    summary['parcelGeometryArea']=geometric_area
    summary['mappingComplete']=abs(mapped_area-geometric_area)<max(.1,geometric_area*.001)
    summary['areaComplete']=summary['areaComplete'] and summary['mappingComplete']
    known=[z['rule'] for z in zones if z['rule']['supported'] and not z['rule']['excluded']]
    ratios=set((r['bcr'],r['far']) for r in known)
    rules={'supported':bool(known),'bcr':next(iter(ratios))[0] if len(ratios)==1 else None,
           'far':next(iter(ratios))[1] if len(ratios)==1 else None,'mixed':len(ratios)>1,
           'title':'依每塊分區的現行計畫分別配對','source':known[0]['source'] if known else result['formUrl'],
           'page':'詳逐分區來源與全文','verification':'未配對分區不套用其他計畫數值；混合分區的建蔽與容積依交集面積分別加總。',
           'setback':{'status':'逐分區條件與圖面試算','distance':None,'text':'詳下列逐分區條文與候選範圍。'}}
    # Clip all adjoining polygons, preserving their attributes for non-road
    # setbacks. Original parcel intersection, not mere proximity, selects them.
    rect={'rings':[[[bbox[0],bbox[1]],[bbox[0],bbox[3]],[bbox[2],bbox[3]],[bbox[2],bbox[1]],[bbox[0],bbox[1]]]]}
    if context_zones:
        clipped=rest(engine.GEO+'intersect',{'sr':3828,'geometries':engine.collection([f['geometry'] for f in context_zones]),
            'geometry':json.dumps({'geometryType':'esriGeometryPolygon','geometry':rect})}).get('geometries',[])
        if len(clipped)!=len(context_zones):raise ValueError('鄰接分區裁切不完整')
        context_zones=[{'attributes':f['attributes'],'geometry':g} for f,g in zip(context_zones,clipped)]
        road_geoms=[f['geometry'] for f in context_zones if f['attributes']['LUSE']=='道路用地']
    road_names=[];evidence_notes=[]
    if road_geoms and any(engine.PLANS.get(z['rule']['planId'],{}).get('namedRoads') for z in zones):
        try:
            road_names=rest('KL_UPGIS/kl_basic/MapServer/4/query',{'geometry':','.join(map(str,bbox)),
                 'geometryType':'esriGeometryEnvelope','inSR':3828,'outFields':'ROADNAME,ROADNO,ROADKIND','returnGeometry':'true'}).get('features',[])
            if road_names:
                road_union=rest(engine.GEO+'union',{'sr':3828,'geometries':engine.collection(road_geoms)}).get('geometry')
                if not road_union:raise ValueError('道路聯集失敗')
                line_clips=rest(engine.GEO+'intersect',{'sr':3828,
                    'geometries':json.dumps({'geometryType':'esriGeometryPolyline','geometries':[f['geometry'] for f in road_names]}),
                    'geometry':json.dumps({'geometryType':'esriGeometryPolygon','geometry':road_union})}).get('geometries',[])
                if len(line_clips)!=len(road_names):raise ValueError('道路名稱線裁切不完整')
                road_names=[{'attributes':f['attributes'],'geometry':g} for f,g in zip(road_names,line_clips) if g.get('paths')]
        except Exception:
            road_names=[];evidence_notes.append('道路名稱比對服務不足，本次保留指定路段分支，不選定路名。')
    site_analysis.resolve(zones,context_zones,road_geoms,road_names,engine.PLANS,geometric_area,{'section':section,'lot':lot})
    candidates=engine.envelopes(zones,road_geoms,geom,rest,geometry_area)
    candidates+=site_analysis.bonus_envelopes(zones,road_geoms,geom,engine,rest,geometry_area)
    # Do not ship unnecessary full source polygons in per-rule evidence.
    for z in zones:
        for spec in z['rule'].get('adjacentConstraints',[]):spec.pop('geometries',None)
    automatic=[i for i,c in enumerate(candidates) if c.get('automatic') and c['status']=='ok']
    summary['automaticEnvelopeIndex']=automatic[0] if len(automatic)==1 and len(known)==1 else -1
    summary['automaticZoneCount']=len(set(candidates[i]['zoneIndex'] for i in automatic))
    summary['requiresAssembly']=any(c['status']=='requires_assembly' for z in zones for c in z['rule'].get('conditions',[]))
    summary['specifiedBoundaryPending']=any(z['rule'].get('resolution',{}).get('status')=='specified_boundary_missing' for z in zones)
    summary['evidenceNotes']=evidence_notes
    return {**result,'district':district,'section':section,'lot':lot,'parcel':feature,
        'requestedDistrict':requested_district,'districtVerification':district_verification,
        'zones':zones,'nearby':nearby.get('features',[])[:300],'nearbyLimited':nearby.get('exceededTransferLimit',False) or len(nearby.get('features',[]))>300,
        'plans':[p['attributes'] for p in plans],'rules':rules,**summary,'envelopes':candidates,'version':'3.0',
        'timestamp':datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),
        'parcelSource':REST+f'KL_UPGIS/kl_sec/MapServer/{layer}',
        'zoneSource':REST+'KL_UPGIS/kl_uplan/MapServer/4',
        'warnings':['圖資坐標為TWD67／TM2 121（EPSG:3828），非TWD97。',
                    'AREA為官方圖層面積，非本系統取得之土地登記謄本面積。',
                    '相交分區採官方幾何服務裁切；圖籍套合誤差與道路境界須由主管機關確認。',
                    '綠色候選範圍僅試算所選道路退縮條件；尚未包含指定附圖、河川／鄰地退縮、騎樓、建築線、坡度、通行、最小基地及回饋等全部條件，非正式可建範圍。']}

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def send(self,code,body,kind):
        self.send_response(code);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)))
        self.send_header('X-Content-Type-Options','nosniff');self.send_header('Cache-Control','no-store');self.end_headers()
        try:self.wfile.write(body)
        except (BrokenPipeError,ConnectionError):pass
    def do_GET(self):
        try:
            # Loopback service: reject foreign Host/Origin and arbitrary URL proxying.
            host=self.headers.get('Host','')
            if host not in {f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}:
                return self.send(403,b'Forbidden','text/plain')
            u=urllib.parse.urlsplit(self.path);q=urllib.parse.parse_qs(u.query)
            val=lambda k,default='':q.get(k,[default])[0]
            if u.path=='/api/health': return self.send(200,b'{"ok":true,"version":"3.0"}', 'application/json')
            if u.path=='/api/sections':return self.send(200,json.dumps({'sections':section_options(),'source':SITE+'landuseNew/qsec_landuse.aspx'},ensure_ascii=False).encode(),'application/json; charset=utf-8')
            if u.path=='/api/catalog':
                data={'version':'3.0','reviewedAt':engine.REGISTRY['reviewedAt'],'plans':[{**c,'rateCount':len(engine.PLANS.get(c['planId'],{}).get('rates',{}))} for c in engine.REGISTRY['catalog']],'rulePlanCount':sum(bool(p['rates']) for p in engine.PLANS.values()),'rateCount':sum(len(p['rates']) for p in engine.PLANS.values())}
                return self.send(200,json.dumps(data,ensure_ascii=False).encode(),'application/json; charset=utf-8')
            if u.path=='/api/rules':
                pid=val('id')
                if pid not in engine.PLANS:return self.send(404,b'{}','application/json')
                return self.send(200,json.dumps(engine.PLANS[pid],ensure_ascii=False).encode(),'application/json; charset=utf-8')
            if u.path=='/rules-ui.js':return self.send(200,(ROOT/'rules-ui.js').read_bytes(),'text/javascript; charset=utf-8')
            if u.path=='/api/lookup':
                result=lookup(val('district'),val('section'),val('lot'))
                return self.send(200,json.dumps(result,ensure_ascii=False).encode(),'application/json; charset=utf-8')
            if u.path=='/api/map':
                service=val('service');bbox=list(map(float,val('bbox').split(',')))
                if service not in ['kl_basic','kl_uplan','kl_ortho'] or len(bbox)!=4 or not all(math.isfinite(v) for v in bbox) or not (0<bbox[2]-bbox[0]<=5000 and 0<bbox[3]-bbox[1]<=5000): raise ValueError('圖面參數錯誤')
                params={'f':'image','bbox':','.join(map(str,bbox)),'bboxSR':3828,'imageSR':3828,'size':'1000,650','format':'png32','transparent':'true','dpi':96}
                if service=='kl_uplan':params['layers']='show:4'
                body=fetch(REST+'KL_UPGIS/'+service+'/MapServer/export?'+urllib.parse.urlencode(params))
                if not body.startswith(b'\x89PNG'): raise ValueError('官方未回傳有效圖面')
                return self.send(200,body,'image/png')
            if u.path in ['/','/index.html']: return self.send(200,(ROOT/'auto.html').read_bytes(),'text/html; charset=utf-8')
            if u.path=='/finance.html': return self.send(200,(ROOT/'finance.html').read_bytes(),'text/html; charset=utf-8')
            return self.send(404,b'Not found','text/plain')
        except (ValueError, urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as e:
            text=str(e) if isinstance(e,ValueError) else '官方連線或資料處理失敗，請稍後重試。'
            self.send(502,json.dumps({'error':text},ensure_ascii=False).encode(),'application/json; charset=utf-8')
        except Exception:
            self.send(500,b'{"error":"Unexpected service error"}','application/json')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8766);args=parser.parse_args()
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
