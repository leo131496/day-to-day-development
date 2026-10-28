'use strict';
window.ProjectRisks = (() => {
  const categories=['范围与需求','进度与交付','资源与人员','技术与质量','客户与协作','成本与合同','安全与合规','其他'];
  const statuses=['已识别','处理中','待验证','已关闭'];
  const filters={q:'',status:'',level:'',archived:false};
  let current=null,projectId='',dirty=false,saving=false;
  const level=r=>{const score=r.probability*r.impact;return score>=9?'重大':score>=6?'高':score>=3?'中':'低';};
  const tone=r=>({'重大':'red','高':'red','中':'amber','低':'gray'}[level(r)]);
  const statusTone=r=>({'已识别':'gray','处理中':'green','待验证':'amber','已关闭':'blue'}[r.status]);
  const late=r=>r.status!=='已关闭'&&r.due&&r.due<today();
  const key=id=>projectId+':risk:'+(id||'new');
  const active=()=>state.risks.filter(r=>!r.archived);
  const visible=()=>state.risks.filter(r=>r.archived===filters.archived&&(!filters.status||r.status===filters.status)&&(!filters.level||level(r)===filters.level)&&(!filters.q||[r.id,r.title,r.description,r.owner,r.response,r.category].join(' ').toLowerCase().includes(filters.q.toLowerCase()))).sort((a,b)=>Number(late(b))-Number(late(a))||b.probability*b.impact-a.probability*a.impact||(a.due||'9999').localeCompare(b.due||'9999')||b.updatedAt.localeCompare(a.updatedAt));
  function render(){
    if(projectId!==state.project.id){projectId=state.project.id;Object.assign(filters,{q:'',status:'',level:'',archived:false});}
    const all=active(),list=visible(),open=all.filter(r=>r.status!=='已关闭');
    return `<section class="risk-register"><div class="risk-heading"><div><h2>项目风险清单</h2><p>识别风险、落实责任、跟踪应对，保留每次处理记录。</p></div><div><button data-risk-action="export">导出风险 CSV</button><button class="primary" data-risk-action="new">＋ 新增风险</button></div></div><div class="risk-metrics">${[['未关闭风险',open.length,'gray'],['高及重大风险',open.filter(r=>r.probability*r.impact>=6).length,'red'],['逾期未处理',open.filter(late).length,'red'],['已关闭风险',all.length-open.length,'blue']].map(([name,n,t])=>`<div class="tone-${t}"><span>${name}</span><strong>${n}<small>项</small></strong></div>`).join('')}</div><div class="risk-toolbar"><input id="risk-search" type="search" placeholder="搜索风险、负责人或应对措施…" aria-label="搜索风险" value="${esc(filters.q)}"><select id="risk-status" aria-label="筛选风险状态">${options(statuses,filters.status,'全部风险状态')}</select><select id="risk-level" aria-label="筛选风险等级">${options(['重大','高','中','低'],filters.level,'全部风险等级')}</select><button data-risk-action="trash">${filters.archived?'返回风险清单':'风险回收站'}${state.risks.some(r=>r.archived)?' ('+state.risks.filter(r=>r.archived).length+')':''}</button><button data-risk-action="refresh">↻ 刷新</button></div><p class="risk-rule">等级 = 发生概率 × 影响程度（各 1–3 分）；1–2 低、3–4 中、6 高、9 重大。等级为登记评估，逾期按处理截止日期判断。</p><div id="risk-results">${rows(list)}</div></section>`;
  }
  function rows(list){
    return `<div class="risk-table-scroll" tabindex="0" role="region" aria-label="项目风险清单，可左右滚动"><table class="risk-table"><thead><tr><th>风险事项 / 描述</th><th>类别 / 关联工作项</th><th>负责人</th><th>风险评估</th><th>应对措施 / 处理结果</th><th>处理状态</th><th>识别日期</th><th>处理截止</th><th>操作</th></tr></thead><tbody>${list.map(r=>`<tr data-risk-row="${esc(r.id)}"><td><small class="risk-id">${esc(r.id)}</small><strong>${esc(r.title)}</strong><p>${esc(r.description)}</p></td><td>${esc(r.category)}${r.linkedTaskId?`<button class="link" data-task="${esc(r.linkedTaskId)}">工作项 ${esc(r.linkedTaskId)} ↗</button>`:''}</td><td><strong>${esc(r.owner||'待指定')}</strong></td><td>${tag(level(r)+'风险',tone(r))}<small>概率 ${r.probability} × 影响 ${r.impact} = ${r.probability*r.impact} 分</small></td><td><p>${esc(r.response||'待制定应对措施')}</p>${r.resolution?`<details><summary>处理结果</summary><p>${esc(r.resolution)}</p>${r.closedAt?`<small>关闭于 ${esc(r.closedAt)}</small>`:''}</details>`:''}</td><td>${tag(r.status,statusTone(r))}${late(r)?tag('已逾期','red'):''}</td><td class="risk-date">${esc(r.identifiedAt)}</td><td class="risk-date ${late(r)?'risk-late':''}">${esc(r.due||'待排期')}</td><td>${r.archived?`<button data-risk-restore="${esc(r.id)}">恢复</button>`:`<button data-risk-edit="${esc(r.id)}">编辑</button>`}<small>${time(r.updatedAt)}</small></td></tr>`).join('')}</tbody></table>${!list.length?`<div class="empty"><h3>${filters.archived?'风险回收站为空':'暂无符合条件的风险'}</h3>${active().length?'调整搜索或筛选条件查看其他记录。':'点击“新增风险”，登记项目中需要跟进的问题。'}</div>`:''}</div><p class="risk-count">${filters.archived?'回收站 · ':''}显示 ${list.length} 项风险 · 记录保存在数据库中，项目备份包含风险清单。左右滚动可查看全部字段。</p>`;
  }
  const formData=()=>({...current,...Object.fromEntries(new FormData($('risk-form'))),probability:Number($('risk-field-probability').value),impact:Number($('risk-field-impact').value)});
  function persist(){if(!$('risk-form'))return;const value=formData();draftSet(key(current.version?current.id:null),{risk:value});dirty=true;$('risk-draft-state').textContent='本机草稿已保留，点击保存后写入数据库。';}
  function optionField(name,label,value,values){return `<label>${label}<select id="risk-field-${name}" name="${name}">${values.map(v=>{const [id,text]=Array.isArray(v)?v:[v,v];return `<option value="${esc(id)}" ${String(value)===String(id)?'selected':''}>${esc(text)}</option>`;}).join('')}</select></label>`;}
  function open(id){
    projectId=state.project.id;
    const saved=id?state.risks.find(r=>r.id===id):null;
    if(id&&!saved)return;
    const draft=draftGet(key(id));
    current=structuredClone(draft?.risk||saved||{id:'R-'+crypto.randomUUID().slice(0,8),title:'',description:'',category:'进度与交付',owner:'',probability:2,impact:2,status:'已识别',response:'',resolution:'',identifiedAt:today(),due:'',closedAt:'',linkedTaskId:'',version:0});dirty=!!draft;
    const r=current;
    $('risk-editor').innerHTML=`<div class="dialog-head"><div><small>PROJECT RISK REGISTER</small><h2 id="risk-editor-title">${saved?'编辑项目风险':'新增项目风险'}</h2></div><button type="button" class="dialog-close" data-close="risk-editor" aria-label="关闭风险编辑">×</button></div><form id="risk-form"><div class="dialog-body">${draft?'<div class="draft-notice">已恢复上次未提交的风险草稿。<button type="button" data-risk-action="discard">放弃草稿</button></div>':''}<div class="field-grid"><label class="wide">风险名称<input name="title" maxlength="160" value="${esc(r.title)}" required></label><label class="wide">风险描述 / 对项目的影响<textarea name="description" required>${esc(r.description)}</textarea></label>${optionField('category','风险类别',r.category,categories)}${field('owner','风险负责人',r.owner)}${optionField('probability','发生概率',r.probability,[[1,'低 · 1 分'],[2,'中 · 2 分'],[3,'高 · 3 分']])}${optionField('impact','影响程度',r.impact,[[1,'轻微 · 1 分'],[2,'中等 · 2 分'],[3,'严重 · 3 分']])}<div class="risk-score wide" id="risk-score"></div>${optionField('status','处理状态',r.status,statuses)}${optionField('linkedTaskId','关联项目工作项（可选）',r.linkedTaskId,[['','不关联'],...state.tasks.map(t=>[t.id,t.id+' · '+t.title])])}<label>识别日期<input name="identifiedAt" type="date" value="${esc(r.identifiedAt)}" required></label>${field('due','处理截止日期',r.due,'date')}${field('response','应对措施 / 后续行动',r.response,'textarea',true)}${field('resolution','处理结果（关闭风险时必填）',r.resolution,'textarea',true)}${field('closedAt','关闭日期（关闭风险时必填）',r.closedAt,'date')}</div><p class="save-state" id="risk-draft-state">${draft?'草稿尚未提交数据库。':'风险编号 '+esc(r.id)+' · 保存后可追踪处理记录。'}</p><p id="risk-error" class="error" role="alert"></p><div id="risk-conflict"></div>${saved?'<details id="risk-history"><summary>查看修改记录</summary><div id="risk-history-list"></div></details>':''}</div><div class="dialog-foot"><small>删除可恢复，风险记录随项目备份保存。</small><div>${saved?`<button type="button" class="danger" data-risk-delete="${esc(r.id)}">删除风险</button>`:''}<button class="primary" id="risk-save" type="submit">保存风险</button></div></div></form>`;
    const score=()=>{$('risk-score').innerHTML=tag(level(formData())+'风险',tone(formData()))+'<span>发生概率 × 影响程度 = '+($('risk-field-probability').value*$('risk-field-impact').value)+' 分</span>';};
    $('risk-form').oninput=()=>{persist();score();};
    $('risk-field-status').onchange=()=>{if($('risk-field-status').value==='已关闭'&&!$('risk-form').elements.closedAt.value)$('risk-form').elements.closedAt.value=today();persist();};
    $('risk-form').onsubmit=save;
    if(saved)$('risk-history').ontoggle=async()=>{
      if(!$('risk-history').open)return;
      try{const data=await api('/api/projects/'+projectId+'/risks/'+r.id+'/history');$('risk-history-list').innerHTML=data.history.map(h=>`<div class="history-item"><strong>v${h.version} · ${esc(h.action)}</strong><small>${time(h.at)}</small><p>${esc(h.risk.status)} · ${esc(h.risk.owner||'负责人待定')}</p><details><summary>查看当时的记录</summary><pre>${esc([['风险名称',h.risk.title],['风险描述',h.risk.description],['类别',h.risk.category],['负责人',h.risk.owner],['状态',h.risk.status],['概率 / 影响',h.risk.probability+' / '+h.risk.impact],['应对措施',h.risk.response],['处理结果',h.risk.resolution],['识别日期',h.risk.identifiedAt],['处理截止',h.risk.due],['关闭日期',h.risk.closedAt],['关联工作项',h.risk.linkedTaskId]].map(([k,v])=>k+'：'+(v||'—')).join('\n'))}</pre></details></div>`).join('');}catch(err){$('risk-history-list').textContent=err.message;}
    };
    score();$('risk-editor').showModal();$('risk-editor').scrollTop=0;$('risk-form [name=title]').focus({preventScroll:true});
  }
  async function save(e){
    e.preventDefault();persist();const value=formData(),draftKey=key(current.version?current.id:null),id=projectId;
    if(value.status==='已关闭'&&(!value.resolution.trim()||!value.closedAt)){$('risk-error').textContent='请填写处理结果和关闭日期后再关闭风险。';return;}
    const controls=[...e.target.elements],closeButton=$('risk-editor').querySelector('.dialog-close');saving=true;closeButton.disabled=true;controls.forEach(el=>el.disabled=true);$('risk-error').textContent='';
    try{
      const data=await api('/api/projects/'+id+'/risks'+(current.version?'/'+current.id:''),{method:current.version?'PUT':'POST',body:JSON.stringify(value)});
      draftRemove(draftKey);dirty=false;$('risk-editor').close();
      if(state.project?.id===id){state.risks=state.risks.some(r=>r.id===data.risk.id)?state.risks.map(r=>r.id===data.risk.id?data.risk:r):[...state.risks,data.risk];renderProject();}
      toast('风险已保存到数据库。');
    }catch(err){
      if(!$('risk-editor').open){toast(err.message);return;}
      $('risk-error').textContent=err.message;
      if(err.status===409&&err.data.current){const latest=err.data.current;$('risk-conflict').innerHTML=`<div class="conflict"><strong>数据库中已有更新（v${latest.version}）</strong><p>${esc(latest.title)} · ${esc(latest.owner||'待指定')} · ${esc(latest.status)}</p><p>应对措施：${esc(latest.response||'未填写')}</p><button type="button" id="risk-merge">核对后，保留填写并使用最新版本继续保存</button></div>`;$('risk-merge').onclick=()=>{if(latest.archived){$('risk-error').textContent='这条风险已删除，请先关闭编辑并从风险回收站恢复。';return;}current.version=latest.version;state.risks=state.risks.some(r=>r.id===latest.id)?state.risks.map(r=>r.id===latest.id?latest:r):[...state.risks,latest];draftRemove(draftKey);persist();$('risk-conflict').innerHTML='';$('risk-error').textContent='请核对所有字段后重新保存。';};}
    }finally{saving=false;closeButton.disabled=false;controls.forEach(el=>el.disabled=false);}
  }
  async function archive(id,archived){
    const risk=state.risks.find(r=>r.id===id);if(!risk)return;
    if(archived&&!confirm('将风险「'+risk.title+'」移入风险回收站？记录和修改历史会保留，可以恢复。'))return;
    const data=await post(projectPath('/risks/'+id+'/archive'),{version:risk.version,archived});
    state.risks=state.risks.map(r=>r.id===id?data.risk:r);draftRemove(key(id));dirty=false;if($('risk-editor').open)$('risk-editor').close();renderProject();toast(archived?'风险已移入回收站。':'风险已恢复。');
  }
  function exportCSV(){
    const columns=[['id','风险编号'],['title','风险名称'],['description','风险描述'],['category','类别'],['owner','负责人'],['probability','概率'],['impact','影响'],['level','等级'],['response','应对措施'],['status','状态'],['identifiedAt','识别日期'],['due','处理截止'],['resolution','处理结果'],['closedAt','关闭日期'],['linkedTaskId','关联工作项']];
    const quote=value=>'"'+String(value??'').replace(/^[\s]*[=+\-@\t\r]/,"'$&").replaceAll('"','""')+'"';
    const lines=[columns.map(c=>quote(c[1])).join(','),...visible().map(r=>columns.map(([key])=>quote(key==='level'?level(r):r[key])).join(','))];
    download('\ufeff'+lines.join('\r\n'),state.project.name+'-风险清单-'+today()+'.csv','text/csv;charset=utf-8');
  }
  document.addEventListener('input',e=>{if(!e.target.closest('.risk-toolbar'))return;if(e.target.id==='risk-search')filters.q=e.target.value;else return;$('risk-results').innerHTML=rows(visible());});
  document.addEventListener('change',e=>{if(!e.target.closest('.risk-toolbar'))return;if(e.target.id==='risk-status')filters.status=e.target.value;if(e.target.id==='risk-level')filters.level=e.target.value;$('risk-results').innerHTML=rows(visible());});
  document.addEventListener('click',async e=>{
    const button=e.target.closest('button');if(!button)return;
    try{
      if(button.dataset.riskEdit)return open(button.dataset.riskEdit);
      if(button.dataset.riskDelete)return await archive(button.dataset.riskDelete,true);
      if(button.dataset.riskRestore)return await archive(button.dataset.riskRestore,false);
      switch(button.dataset.riskAction){
        case 'new':return open();
        case 'discard':{if(!current||!confirm('放弃这份尚未提交的风险草稿？已保存的风险记录保留。'))return;const id=current.version?current.id:undefined;draftRemove(key(id));dirty=false;return open(id);}
        case 'refresh':return await openProject(state.project.id,true);
        case 'trash':filters.archived=!filters.archived;return renderView();
        case 'export':return exportCSV();
      }
    }catch(err){toast(err.message);}
  });
  document.addEventListener('DOMContentLoaded',()=>{$('risk-editor').addEventListener('cancel',e=>{if(saving)e.preventDefault();});$('risk-editor').addEventListener('close',()=>{dirty=false;current=null;$('risk-editor').innerHTML='';});});
  return {render,exportCSV,get dirty(){return dirty;}};
})();
