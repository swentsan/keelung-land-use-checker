(() => {
  const base = String(window.KEELUNG_API_BASE || '').replace(/\/$/,'');
  const configured = /^https:\/\/[^/]+$/.test(base);
  let registry;
  const loadRegistry = () => registry ||= fetch(new URL('./rules.json',location.href)).then(r=>{if(!r.ok)throw Error('規則庫讀取失敗');return r.json()});
  const reply = obj => new Response(JSON.stringify(obj),{headers:{'Content-Type':'application/json; charset=utf-8'}});
  window.apiURL = path => configured ? base+path : '';
  window.apiFetch = async path => {
    const url = new URL(path,location.origin);
    if(url.pathname === '/api/catalog') {
      const data=await loadRegistry(),plans=Object.values(data.plans);
      return reply({version:'3.0',reviewedAt:data.reviewedAt,plans:data.catalog.map(c=>({...c,rateCount:Object.keys(data.plans[c.planId]?.rates||{}).length})),rulePlanCount:plans.filter(p=>Object.keys(p.rates||{}).length).length,rateCount:plans.reduce((n,p)=>n+Object.keys(p.rates||{}).length,0)});
    }
    if(url.pathname === '/api/rules') {const data=await loadRegistry(),rule=data.plans[url.searchParams.get('id')];return rule?reply(rule):new Response('{}',{status:404})}
    if(!configured) throw Error('即時查詢服務尚未啟用；目前可使用土管規則庫與財務試算。');
    return fetch(base+path,{signal:AbortSignal.timeout(180000)});
  };
  document.addEventListener('DOMContentLoaded', async()=>{
    const status=document.getElementById('serviceState');
    const buttons=['query','test615'].map(id=>document.getElementById(id));
    if(!configured){status.textContent='即時查詢服務尚未啟用。土管規則庫及完整財務試算已可使用；地號查詢與套繪須待服務啟用。';buttons.forEach(b=>b.disabled=true);return}
    status.textContent='正在確認即時查詢服務…';buttons.forEach(b=>b.disabled=true);
    try{const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(60000)}),d=await r.json();if(!r.ok||!d.ok||d.version!=='3.0')throw Error();status.textContent='即時查詢服務已連線，可輸入地號查詢及套繪。';buttons.forEach(b=>b.disabled=false)}catch{status.textContent='查詢服務暫時無法連線；請稍後重新整理。規則庫及財務試算仍可使用。'}
  });
})();
