/* v2: per-zone provenance and conditional geometry. Values are always server supplied. */
let envelopeIndex=-1;
function rateLabel(v){return v===null||v===undefined?'待核對':num(v)+'%'}
function ruleCard(z){const r=z.rule;return `<article class="rule-card"><h3>${esc(z.attributes.LUSE)} · ${esc(r.planName||r.detailCode)}</h3><p><span class="badge">${esc(r.status)}</span> 計畫 ${esc(r.planId||'未定')} · 街廓 ${esc(r.block)}</p><p>建蔽 ${rateLabel(r.bcr)} ／ 容積 ${rateLabel(r.far)}；交集 ${num(z.overlapArea)}㎡</p><p>${esc(r.setback.text)}</p>${r.note?`<p class="note">${esc(r.note)}</p>`:''}${r.matchingNote?`<p class="danger">${esc(r.matchingNote)}</p>`:''}<p>${link(r.source,'官方計畫文件')} ${r.pageRefs.length?' · 數值／退縮相關PDF頁：'+esc(r.pageRefs.join('、')):''} <button class="text-button" data-rule="${esc(r.planId)}">查閱土管全文</button></p><div class="rule-text"></div></article>`}
selectResult=function(i){
 if(results[i].error){$('queryStatus').textContent=results[i].error;return}
 current=i;envelopeIndex=-1;const d=results[i].data,r=d.rules;
 $('resultTitle').textContent=`${d.district} ${d.section} ${d.lot} 地號`;
 $('retrieved').textContent='官方查詢取得時間：'+new Date(d.timestamp).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'});
 $('gross').textContent=num(d.parcel.attributes.AREA)+' m²';
 $('bcr').textContent=r.mixed?'多分區，見下表':rateLabel(r.bcr);$('far').textContent=r.mixed?'多分區，見下表':rateLabel(r.far);
 $('officialSummary').innerHTML=`<span class="badge">官方表單：${esc(d.zone)}</span><p>${esc(d.plan)}<br><small>${esc(d.history)}</small></p>${d.formNotes?`<p class="hint">${esc(d.formNotes)}</p>`:''}`;
 $('ruleSummary').innerHTML=`<p class="hint">逐分區查詢街廓的現行計畫，再與本機已核對規則配對。圖形跨區時分別計算。</p>${!d.areaComplete?`<div class="note">本筆尚有 ${num(d.unknownArea)}㎡非道路分區未配對，或圖資交集未完整覆蓋。下列加總僅為已配對部分，暫停帶入財務。</div>`:''}<div class="scroll"><table><thead><tr><th>分區／計畫</th><th>建蔽</th><th>容積</th><th>判讀</th></tr></thead><tbody>${d.zones.map(z=>`<tr><td>${esc(z.attributes.LUSE)}<br><small>${esc(z.rule.planName)} / ${esc(z.rule.planId)}</small></td><td>${rateLabel(z.rule.bcr)}</td><td>${rateLabel(z.rule.far)}</td><td>${esc(z.rule.status)}</td></tr>`).join('')}</tbody></table></div>`;
 const shapeArea=d.parcelGeometryArea;
 $('zoneRows').innerHTML=d.zones.map(z=>`<tr><td>${esc(z.attributes.LUSE)}</td><td>${esc(z.attributes.BLOCK_DEF)}</td><td class="num">${num(z.overlapArea)}</td><td class="num">${num(shapeArea?z.overlapArea/shapeArea*100:0)}%</td></tr>`).join('');
 $('setbackSummary').innerHTML=`${d.zones.filter(z=>!z.rule.excluded).map(ruleCard).join('')}<div class="note">候選範圍只扣除選定的道路退縮情境。路寬、指定路段及附圖尚未全部轉為可判斷圖資；河川、鄰地、既有巷道、騎樓、建築線、坡度、通行及回饋等條件仍可能縮小範圍。</div><label>套繪退縮情境（逐分區）<select id="envelope"><option value="-1">選擇條件後，顯示綠色候選範圍</option>${d.envelopes.map((e,j)=>`<option value="${j}" ${e.status==='ok'?'':'disabled'}>${esc(e.zone)} · ${e.boundary==='parcel'?'基地全界':'臨計畫道路'} ${e.distance}m · ${e.status==='ok'?num(e.area)+'㎡':esc(e.message)}</option>`).join('')}</select></label><div id="envelopeResult" class="formula">未選擇情境；不自動假定路寬。</div>`;
 $('envelope').onchange=()=>{envelopeIndex=Number($('envelope').value);$('allowScenario').checked=false;updateEnvelope();draw();updateScenario()};
 $('planList').innerHTML='<p class="hint">相交歷程不代表全部同時適用；本次數值來源見各分區規則。</p>'+d.plans.map(p=>'<p>'+link(site+'uplan/View.asp?ID='+p.PLANNO,p.PLANNAME)+'</p>').join('');
 $('sourceList').innerHTML=d.warnings.map(w=>'<p>'+esc(w)+'</p>').join('')+'<p>'+link(d.parcelSource,'地籍圖層')+'</p><p>'+link(d.zoneSource,'都市計畫分區圖層')+'</p>';
 $('baseArea').textContent=num(d.estimatedBaseArea)+' m²';$('coverageArea').textContent=num(d.estimatedCoverage)+' m²';$('farArea').textContent=num(d.estimatedFar)+' m²';
 $('areaNote').textContent=`已配對分區的面積合計；排除道路等 ${num(d.excludedArea)}㎡。公共設施及專用區有特定用途，不可直接按住宅銷售。選擇退縮情境後，可再看對應分區的候選建築量。`;
 $('allowScenario').checked=false;$('transferStatus').textContent='';renderList();fit();updateScenario();
};
function updateEnvelope(){const d=results[current]?.data,e=d?.envelopes[envelopeIndex];if(!$('envelopeResult'))return;$('envelopeResult').textContent=e&&e.status==='ok'?`${e.zone}：${e.condition} 本次假設所有相接計畫道路均採 ${e.distance}m，候選範圍 ${num(e.area)}㎡；單層建築量取候選範圍與建蔽上限較小者 ${num(e.coverage)}㎡。此情境尚待確認條件適用。`:'未選擇情境；不自動假定路寬。'}
const baseDraw=draw;
draw=function(){baseDraw();if(current<0)return;const d=results[current].data,e=d.envelopes[envelopeIndex];if(e?.status==='ok'){$('map').insertAdjacentHTML('beforeend',`<path d="${path(e.geometry)}" fill="#16a06466" fill-rule="evenodd" stroke="#08783e" stroke-width="2"><title>${esc(e.zone)} ${e.distance}m情境：${num(e.area)}㎡</title></path>`)}else{for(const c of d.envelopes.filter(c=>c.status==='ok'))$('map').insertAdjacentHTML('beforeend',`<path d="${path(c.geometry)}" fill="none" stroke="#08783e" stroke-width="2" stroke-dasharray="6 4"><title>${esc(c.zone)} ${c.distance}m條件情境：${num(c.area)}㎡；${esc(c.condition)}</title></path>`)}$('map').insertAdjacentHTML('beforeend',`<path d="${path(d.parcel.geometry)}" fill="none" stroke="#c23232" stroke-width="3"/>`);$('mapStatus').textContent='紅線：本宗地；藍色：分區交集；黃色：道路；綠虛線：自動計算的條件情境界線，綠色填色：選定情境。';};
const theoreticalScenario=updateScenario;
updateScenario=function(){theoreticalScenario();if(current<0)return;const d=results[current].data;if(!d.areaComplete){scenario=null;$('scenario').textContent='本筆非道路分區尚有未配對或圖資缺口，只顯示已知部分，不產生整筆財務情境。';return}const e=d.envelopes[envelopeIndex];if(e?.status==='ok'&&scenario){const n=Number($('floors').value),extra=Number($('extra').value),basement=Number($('basement').value),floor=Math.min(e.coverage*n,e.far),construction=floor+extra+basement;scenario={land:d.parcel.attributes.AREA*.3025,construction:construction*.3025};$('scenario').textContent=`所選分區 ${e.zone}／${e.distance}m退縮情境：min（單層 ${num(e.coverage)} × ${n}層，基準容積 ${num(e.far)}）＝${num(floor)}㎡；加非容積及地下工程後 ${num(construction)}㎡（${num(construction*.3025)}坪）。只試算所選分區，未計其他相交分區工程量；不是核准量或可售面積。`;}};
document.addEventListener('click',async ev=>{const b=ev.target.closest('[data-rule]');if(!b)return;const target=b.parentElement.nextElementSibling;b.disabled=true;try{const response=await fetch('/api/rules?id='+encodeURIComponent(b.dataset.rule));if(!response.ok)throw Error('此案尚未收錄可閱讀文字，請開啟官方文件。');const p=await response.json();target.innerHTML=`<details open><summary>土管文字（掃描辨識可能有誤，以官方原圖為準）</summary><p class="hint">SHA256 ${esc(p.sha256||'原始報告見官方連結')}</p>${(p.evidencePages||p.pages.map((text,i)=>({page:i+1,text}))).map(e=>`<details><summary>原PDF第${e.page}頁</summary><pre>${esc(e.text)}</pre></details>`).join('')}</details>`}catch(e){target.textContent=e.message}finally{b.disabled=false}});
async function loadCatalog(){try{const r=await fetch('/api/catalog');if(!r.ok)throw Error();const d=await r.json();$('catalogStatus').textContent=`規則庫 ${d.version} · 核對日 ${d.reviewedAt} · ${d.plans.length}個圖台細計範圍／${d.rulePlanCount}組計畫規則／${d.rateCount}筆數值。未收錄或有特殊條件的分區，查詢時會標示待核對。`;$('catalogRows').innerHTML=d.plans.map(c=>`<tr><td>${esc(c.code)}</td><td>${esc(c.name)}</td><td>${esc(c.planId)}</td><td>${c.rateCount}</td><td>${esc(c.status)}</td></tr>`).join('')}catch{$('catalogStatus').textContent='規則庫狀態讀取失敗，請確認本機服務已啟動。'}}
loadCatalog();

/* v3 additions preserve the v2 financial and multi-parcel workflow. */
const conditionStatus={specified_lot_match:'命中計畫明列地號，沿革與指定邊界待確認',unverified:'待履行／核准資料',rule_identified:'條文已辨識，依方案適用',document_reports_completed:'發布計畫書記載已完成',meets_single_parcel_area:'本筆圖形面積達門檻，法定基地仍待確認',requires_assembly:'本筆不足，須整合其他土地'};
const cardV2=ruleCard;
ruleCard=function(z){const r=z.rule;let detail='';
 if(r.densitySource)detail+=`<p>${link(r.densitySource,'明文比照的密度依據')}；退縮另依本案條文處理。</p>`;
 const resolution=r.resolution||{};detail+=`<p class="${resolution.status?.startsWith('automatic')?'auto-note':'hint'}">${resolution.status?.startsWith('automatic')?'道路／基地退縮已自動判讀':'退縮仍有條件分支'}：${esc(resolution.reason||'尚待資料')}</p>`;
 if(r.roadEvidence)detail+=`<details><summary>指定路名空間比對證據</summary><p>${esc(r.roadEvidence.roadName||r.roadEvidence.reason)}</p><p class="hint">來源：官方基本圖道路名稱線，先裁切至計畫道路面，再比對相接邊界採樣。無法唯一對應時保留分支。</p><p class="hint">${esc((r.roadEvidence.samples||[]).map(s=>s.roadName+'：距名稱線'+num(s.distanceToNameLine)+'m').join('；'))}</p></details>`;
 if(r.conditions?.length)detail+=`<h3>附帶條件與開發門檻</h3><div class="scroll"><table><thead><tr><th>項目</th><th>自動判讀</th><th>依據／尚需資料</th></tr></thead><tbody>${r.conditions.map(c=>`<tr><td>${esc(c.title)}</td><td>${esc(conditionStatus[c.status]||c.status)}${c.minimumArea?'<br>圖形 '+num(c.observedArea)+'㎡ ／門檻 '+num(c.minimumArea)+'㎡':''}</td><td>${esc(c.text)}<br>${link(c.source,'官方文件')} PDF第${esc(c.page)}頁</td></tr>`).join('')}</tbody></table></div>`;
 if(r.bonusOptions?.length)detail+=`<h3>獎勵方案面積初判</h3><p class="hint">基準容積保留原值。達面積門檻不等於獎勵已核准；滿足門檻的5m退縮方案可在下方選取試算。</p><div class="scroll"><table><thead><tr><th>方案</th><th>本筆圖形初判</th><th>建蔽／容積／退縮</th></tr></thead><tbody>${r.bonusOptions.map(o=>`<tr><td>${esc(o.label)}</td><td>${o.areaStatus==='area_threshold_met'?'達面積門檻，其他條件待審':o.areaStatus==='requires_whole_block_evidence'?'需全街廓範圍證據':'本筆不足，需合併'}<br>${num(o.observedArea)}㎡</td><td>${o.bcr}%／${o.far}%／${o.distance}m${o.riverFrontageRatio?'<br>向河面寬 ≤ '+o.riverFrontageRatio+'%':''}</td></tr>`).join('')}</tbody></table></div>`;
 if(r.adjacentConstraints?.length)detail+=`<h3>鄰接分區退縮</h3>${r.adjacentConstraints.map(c=>`<p class="hint">${esc(c.text)} ${c.status==='mapped'?'本次已命中並裁切：'+esc(c.targetZones.join('、')):'本次相接圖徵未命中目標類別，未擅自扣除鄰近但未相接的用地。'}</p>`).join('')}`;
 return cardV2(z).replace('</article>',detail+'</article>');
};
const selectV2=selectResult;
selectResult=function(i){selectV2(i);if(!results[i]?.data)return;const d=results[i].data;
 $('ruleSummary').insertAdjacentHTML('afterbegin',`<div class="auto-note">已依官方條文及圖資判讀 ${d.automaticZoneCount||0} 塊分區的部分退縮。尚待路寬、核定附圖或履約資料者，逐項列在退縮區。</div>`);
 for(let j=0;j<d.envelopes.length;j++){const c=d.envelopes[j],o=$('envelope').querySelector(`option[value="${j}"]`);if(o)o.textContent=(c.automatic?'自動判讀｜':'條件情境｜')+(c.variant?c.variant+'｜':'')+o.textContent;}
 if(d.automaticEnvelopeIndex>=0){$('envelope').value=String(d.automaticEnvelopeIndex);envelopeIndex=d.automaticEnvelopeIndex;updateEnvelope();draw();updateScenario();}
 if(d.requiresAssembly)$('areaNote').textContent+=' 本筆圖形未達本計畫最小開發規模，須整合其他土地；暫停單筆財務帶入。';
};
const updateV2=updateScenario;
updateScenario=function(){updateV2();if(current<0)return;const d=results[current].data;if(d.requiresAssembly||d.specifiedBoundaryPending){scenario=null;$('scenario').textContent=d.requiresAssembly?'本筆未達計畫最小開發規模，需先整合其他土地，暫停單筆財務帶入。':'命中計畫指定退縮或保留通道地號，指定邊界與沿革未確認；暫停以一般面積情境帶入財務。';return}const c=d.envelopes[envelopeIndex];if(c?.variant)$('scenario').textContent+=' 獎勵方案：'+c.variant+'；尚未核准，不代表已取得獎勵容積。';};
const updateEnvelopeV2=updateEnvelope;
updateEnvelope=function(){updateEnvelopeV2();if(current<0)return;const c=results[current].data.envelopes[envelopeIndex];if(c?.status==='ok'){$('envelopeResult').textContent=(c.automatic?'已依條文／圖資自動選定此退縮方案。':'條件情境，未自動認定適用。')+$('envelopeResult').textContent;if(c.additionalConstraints?.length)$('envelopeResult').textContent+=' 已另扣除：'+c.additionalConstraints.map(x=>x.text).join('；')+'。';}};
fetch('/api/sections').then(r=>{if(!r.ok)throw Error();return r.json()}).then(d=>{const list=document.createElement('datalist');list.id='officialSections';list.innerHTML=d.sections.map(s=>`<option value="${esc(s.name)}">${esc(s.code)}</option>`).join('');$('section').setAttribute('list',list.id);$('section').after(list)}).catch(()=>{});

