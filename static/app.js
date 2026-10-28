'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses = ['待确认','未开始','进行中','待验收','受阻','已延期','暂停','已完成'];
const state = {csrf:'',projects:[],project:null,tasks:[],view:'board',page:'home',filters:{q:'',stage:'',owner:'',focus:'all'},archived:false,load:0};
let editTask = null, taskDirty = false, projectDirty = false, generated = [], projectMode = 'create';
const prefix = 'project-space-draft-v1:';
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const time = value => value ? new Date(value).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}) : '—';
const done = t => t.status === '已完成' && t.progress === 1;
const overdue = t => !done(t) && t.end && t.end < today();
const near = t => !done(t) && t.end && t.end >= today() && t.end <= new Date(Date.parse(today()+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
const progress = tasks => tasks.length ? Math.round(tasks.filter(done).length/tasks.length*100) : 0;
const tag = (text,color='') => `<span class="tag ${color}">${esc(text)}</span>`;
const track = n => `<div class="progress-track"><progress max="100" value="${Number(n)||0}" aria-label="完成进度 ${Number(n)||0}%"></progress></div>`;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5500);}
function draftGet(key){try{return JSON.parse(localStorage.getItem(prefix+key)||'null');}catch{return null;}}
function draftSet(key,value){try{localStorage.setItem(prefix+key,JSON.stringify(value));return true;}catch{toast('浏览器草稿保存失败，请保持页面打开并保存到数据库。');return false;}}
function draftRemove(key){try{localStorage.removeItem(prefix+key);}catch{}}
async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Requested-With':'ProjectBoard','X-CSRF-Token':state.csrf,...options.headers},cache:'no-store'});
  const data=await response.json();
  if(!response.ok){const error=new Error(data.error||'请求失败，请稍后重试');error.status=response.status;error.data=data;if(response.status===401&&path!=='/api/login')showLogin();throw error;}
  return data;
}
const post=(path,body={})=>api(path,{method:'POST',body:JSON.stringify(body)});
const projectPath=suffix=>'/api/projects/'+state.project.id+(suffix||'');
function showLogin(){
  $('login').hidden=false;$('workspace').hidden=true;
  for(const id of ['editor','project-editor'])if($(id).open)$(id).close();
}
async function boot(){try{const session=await api('/api/session');state.csrf=session.csrf;await enter();}catch{showLogin();}}
async function enter(){
  $('login').hidden=true;$('workspace').hidden=false;
  await loadProjects();
  const id=location.hash.slice(1);
  if(id&&state.projects.some(p=>p.id===id&&!p.archived))await openProject(id);else home();
}
$('login-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;$('login-error').textContent='';try{const data=await post('/api/login',{password:$('password').value});state.csrf=data.csrf;$('password').value='';await enter();}catch(err){$('login-error').textContent=err.message;}finally{button.disabled=false;}};
$('logout').onclick=async()=>{try{await post('/api/logout');showLogin();}catch(err){toast(err.message);}};
$('home').onclick=()=>home();$('trash').onclick=()=>home(true);
$('side-add').onclick=()=>projectEditor();
$('mobile-menu').onclick=()=>document.querySelector('.sidebar').classList.toggle('open');
function closeNav(){document.querySelector('.sidebar').classList.remove('open');}
async function loadProjects(){state.projects=(await api('/api/projects')).projects;renderSidebar();}
function renderSidebar(){
  $('project-list').innerHTML=state.projects.filter(p=>!p.archived).map(p=>`<button class="project-nav ${state.project?.id===p.id&&state.page==='project'?'active':''}" data-project="${p.id}"><span></span>${esc(p.name)}</button>`).join('');
  $('home').classList.toggle('active',state.page==='home');$('trash').classList.toggle('active',state.page==='trash');
}
function stat(label,value,unit,foot,icon){return `<div class="stat"><div class="stat-label">${label}<span class="stat-icon">${icon}</span></div><div class="stat-number">${value}<small>${unit}</small></div><div class="stat-foot">${foot}</div></div>`;}
function home(trash=false){
  state.load++;state.page=trash?'trash':'home';state.project=null;location.hash='';closeNav();renderSidebar();
  $('breadcrumb').innerHTML='工作空间 <span>/</span> '+(trash?'项目回收站':'项目总览');
  const projects=state.projects.filter(p=>p.archived===trash),active=state.projects.filter(p=>!p.archived);
  $('main').innerHTML=`<section class="page-heading"><div><div class="eyebrow">YOUR WORK, IN ORDER</div><h1>${trash?'项目回收站':'每个计划，都向前一步。'}</h1><p>${trash?'项目及其任务、历史记录均保留，可随时恢复。':'从想法到交付，清晰掌握每个项目的进展。'}</p></div><div class="heading-actions">${trash?'':'<button class="primary" data-action="create-project">＋ 新建项目</button>'}<button data-action="reload-home">↻ 刷新</button></div></section>
  ${trash?'':`<div class="stats">${stat('全部项目',active.length,'个','一个空间，连接所有项目','▦')}${stat('累计完成',active.reduce((s,p)=>s+p.completed,0),'项','每一份进展，都值得记录','✓')}${stat('待推进任务',active.reduce((s,p)=>s+p.total-p.completed,0),'项','按项目查看责任人与待办','◷')}${stat('整体完成率',Math.round(active.reduce((s,p)=>s+p.completed,0)/Math.max(1,active.reduce((s,p)=>s+p.total,0))*100),'%','按已完成任务数量计算','↗')}</div>`}
  <div class="section-head"><h2>${trash?'已删除的项目':'项目空间'} <small> / ${projects.length} 个项目</small></h2><small>${today().replaceAll('-',' / ')}</small></div><div class="project-grid">${projects.map(p=>`<article class="project-card"><div class="project-card-top"><span class="project-symbol">▧</span>${tag(trash?'已移入回收站':p.total&&p.total===p.completed?'已完成':'推进中',trash?'':'purple')}</div><h3>${esc(p.name)}</h3><p>${esc(p.description||p.content||'添加项目内容，生成你的第一份任务计划。')}</p><div class="project-progress"><div class="progress-caption"><span>项目完成进度</span><span>${p.completed} / ${p.total} 项 · ${Math.round(p.completed/Math.max(p.total,1)*100)}%</span></div>${track(p.completed/Math.max(p.total,1)*100)}</div><div class="project-card-bottom"><span>${esc(p.owner||'待指定负责人')}</span>${trash?`<button class="link" data-restore-project="${p.id}">恢复项目 ↗</button>`:`<button class="link" data-project="${p.id}">进入项目 ↗</button>`}</div></article>`).join('')}${trash?'':`<button class="create-card" data-action="create-project"><span>＋</span><strong>开始一个新项目</strong><small>填写项目内容，自动生成看板与待办</small></button>`}</div>${trash&&!projects.length?'<div class="empty"><h3>回收站是空的</h3>删除的项目会保留在这里。</div>':''}`;
  $('backup-status').textContent='项目数据保存在服务器数据库中';
}
async function openProject(id,preserve=false){
  const ticket=++state.load;closeNav();
  if(!preserve){state.filters={q:'',stage:'',owner:'',focus:'all'};state.archived=false;state.view='board';}
  if(!preserve)$('main').innerHTML='<div class="loading">正在打开项目空间…</div>';
  try{
    const data=await api('/api/projects/'+id);if(ticket!==state.load)return;
    state.project=data.project;state.tasks=data.tasks;state.backup=data.backup;state.page='project';location.hash=id;
    renderSidebar();renderProject();
  }catch(err){if(ticket!==state.load)return;$('main').innerHTML=`<div class="empty"><h3>项目暂时无法打开</h3><p>${esc(err.message)}</p><button data-action="reload-home">回到项目总览</button></div>`;toast(err.message);}
}
function activeTasks(){return state.tasks.filter(t=>!t.archived);}
function rank(t){return done(t)?9:overdue(t)||['受阻','已延期'].includes(t.status)?1:near(t)?2:3;}
function filtered(){const f=state.filters,q=f.q.toLowerCase();return state.tasks.filter(t=>t.archived===state.archived&&(!q||[t.id,t.title,t.content,t.owner,t.nextAction,t.stage,t.blocker].join(' ').toLowerCase().includes(q))&&(!f.stage||t.stage===f.stage)&&(!f.owner||t.owner===f.owner)&&(f.focus==='all'||f.focus==='overdue'&&overdue(t)||f.focus==='near'&&near(t)||f.focus==='open'&&!done(t)||f.focus==='blocked'&&['受阻','已延期'].includes(t.status))).sort((a,b)=>rank(a)-rank(b)||(a.end||'9999').localeCompare(b.end||'9999')||a.id.localeCompare(b.id,undefined,{numeric:true}));}
function options(values,current,first){return `<option value="">${first}</option>`+values.map(v=>`<option ${current===v?'selected':''} value="${esc(v)}">${esc(v)}</option>`).join('');}
function renderProject(){
  const p=state.project,tasks=activeTasks(),missing=tasks.filter(t=>!t.owner||!t.end).length;
  $('breadcrumb').innerHTML='工作空间 <span>/</span> '+esc(p.name);
  $('main').innerHTML=`<section class="page-heading"><div><div class="eyebrow">PROJECT WORKSPACE</div><h1>${esc(p.name)}</h1><p>${esc(p.description||'每一项任务，每一次进展，都在这里。')}</p></div><div class="heading-actions"><button data-action="edit-project">编辑项目</button><button data-action="generate">✧ 生成任务</button><button class="primary" data-action="new-task">＋ 新建任务</button></div></section>
  ${state.backup?.error?'<p class="backup-warning">最近一次自动备份失败，请检查服务器存储空间。当前数据库仍可使用，请及时导出备份。</p>':''}
  <div class="stats">${stat('计划任务',tasks.length,'项','完整的计划，让执行更清晰','▦')}${stat('已完成',tasks.filter(done).length,'项','完成率 '+progress(tasks)+'%','✓')}${stat('逾期任务',tasks.filter(overdue).length,'项','根据今天 '+today()+' 自动计算','◷')}${stat('近期到期',tasks.filter(near).length,'项',missing?missing+' 项待补负责人或排期':'未来 7 天内需要关注','⚑')}</div>
  <div class="project-banner"><div class="project-banner-icon">≋</div><div><h3>把下一步行动，变成确定的进展。</h3><p>点击任务填写进展、风险与交付记录；保存后同步更新看板、待办和统计。</p></div>${p.source?`<a href="${esc(safeURL(p.source))}" target="_blank" rel="noreferrer">查看原始项目计划 ↗</a>`:''}</div>
  <div class="viewbar"><button class="viewtab ${state.view==='board'?'active':''}" data-view="board">▥ 项目看板</button><button class="viewtab ${state.view==='todo'?'active':''}" data-view="todo">☷ 待办清单</button><button class="viewtab ${state.view==='overview'?'active':''}" data-view="overview">◴ 数据概览</button><span class="viewcount">${state.archived||state.tasks.filter(t=>t.archived).length?`<button class="link" data-action="toggle-archive">${state.archived?'返回任务':'任务回收站'}</button>`:'所有视图实时关联'}</span></div>
  <div class="filters"><input id="search" aria-label="搜索任务" placeholder="⌕ 搜索任务、内容或负责人…" value="${esc(state.filters.q)}"><select id="filter-stage" aria-label="筛选阶段">${options([...new Set(tasks.map(t=>t.stage))],state.filters.stage,'全部项目阶段')}</select><select id="filter-owner" aria-label="筛选负责人">${options([...new Set(tasks.map(t=>t.owner).filter(Boolean))],state.filters.owner,'全部负责人')}</select><select id="filter-focus" aria-label="筛选任务提醒">${[['all','全部任务'],['open','未完成'],['overdue','已逾期'],['near','7 天内到期'],['blocked','受阻 / 延期']].map(([v,l])=>`<option value="${v}" ${state.filters.focus===v?'selected':''}>${l}</option>`).join('')}</select><button class="refresh" data-action="refresh-project">↻ 刷新数据</button></div>
  <div id="view-content"></div><div class="section-head"><small id="result-count"></small><div class="section-actions"><button data-action="export">导出备份</button><button data-action="csv">导出 CSV</button><button data-action="import">导入记录</button><button data-action="backup">立即备份</button><button class="danger" data-action="delete-project">删除项目</button></div></div><input type="file" id="import-file" accept=".json,.html" hidden>`;
  $('search').oninput=e=>{state.filters.q=e.target.value;renderView();};
  for(const [id,key]of [['filter-stage','stage'],['filter-owner','owner'],['filter-focus','focus']])$(id).onchange=e=>{state.filters[key]=e.target.value;renderView();};
  $('import-file').onchange=importFile;renderView();
  $('backup-status').textContent=state.backup?.error?'备份异常，请及时导出':'数据库已连接 · 最近备份 '+time(state.backup?.lastAt);
}
function badge(t){return done(t)?tag('已完成','green'):overdue(t)?tag('已逾期','red'):['受阻','已延期'].includes(t.status)?tag(t.status,'red'):near(t)?tag('即将到期','amber'):!t.owner||!t.end?tag('待补计划','amber'):tag(t.priority+'优先级',t.priority==='高'?'purple':'');}
function card(t){return `<button class="task-card" data-task="${esc(t.id)}"><div class="task-meta"><span>${esc(t.id)}</span><span>${esc(t.stage)}</span></div><h3>${esc(t.title)}</h3><p class="excerpt">${esc(t.content||'点击补充项目内容')}</p>${t.nextAction?`<div class="task-next">↳ ${esc(t.nextAction)}</div>`:''}<div>${badge(t)}</div><div class="task-foot"><span class="task-owner">${esc(t.owner||'待指定负责人')}</span><span>${esc(t.end?t.end.slice(5).replace('-',' / '):'待排期')}</span></div></button>`;}
function renderView(){
  const list=filtered(),content=$('view-content');if(!content)return;
  $('result-count').textContent=`${state.archived?'回收站 · ':''}显示 ${list.length} / ${state.tasks.filter(t=>t.archived===state.archived).length} 项任务 · 点击查看完整内容`;
  if(state.archived){content.innerHTML=`<div class="table-wrap"><table><thead><tr><th>任务编号</th><th>任务名称</th><th>负责人</th><th>恢复</th></tr></thead><tbody>${list.map(t=>`<tr><td>${esc(t.id)}</td><td><strong>${esc(t.title)}</strong><small>${esc(t.stage)}</small></td><td>${esc(t.owner)}</td><td><button data-restore-task="${esc(t.id)}">恢复任务</button></td></tr>`).join('')}</tbody></table></div>`;return;}
  if(state.view==='board'){
    const lanes=[['未开始',['未开始','待确认']],['进行中',['进行中']],['待验收',['待验收']],['受阻 / 延期',['受阻','已延期','暂停']],['已完成',['已完成']]];
    content.innerHTML='<div class="board">'+lanes.map(([name,group])=>{const tasks=list.filter(t=>group.includes(t.status));return `<section class="lane"><div class="lane-head"><span class="lane-title"><span class="lane-dot"></span>${name}</span><strong>${tasks.length}</strong></div>${tasks.length?tasks.map(card).join(''):'<div class="empty-lane">这里还没有任务</div>'}<button class="lane-add" data-new-status="${group[0]}">＋ 添加任务</button></section>`;}).join('')+'</div>';
  }else if(state.view==='todo'){
    content.innerHTML=`<div class="table-wrap"><table><thead><tr><th>编号 / 阶段</th><th>任务与项目内容</th><th>下一步待办</th><th>负责人</th><th>截止日期</th><th>状态 / 提醒</th><th></th></tr></thead><tbody>${list.map(t=>`<tr><td>${esc(t.id)}<small>${esc(t.stage)}</small></td><td><strong>${esc(t.title)}</strong><details class="todo-content"><summary>查看项目内容</summary><p>${esc(t.content)}</p><p>验收要点：${esc(t.criteria||'待填写')}</p></details></td><td>${esc(t.nextAction||'待填写')}<small>${t.blocker?'阻塞：'+esc(t.blocker):''}</small></td><td>${esc(t.owner||'待指定')}</td><td>${esc(t.end||'待排期')}<small>${t.followup?'跟进 '+esc(t.followup):''}</small></td><td>${tag(t.status,'purple')}<small>${badge(t)}</small></td><td><button data-task="${esc(t.id)}">填写跟进</button></td></tr>`).join('')}</tbody></table>${!list.length?'<div class="empty">没有符合条件的任务</div>':''}</div>`;
  }else{
    const stages=[...new Set(list.map(t=>t.stage))],urgent=list.filter(t=>!done(t)).sort((a,b)=>rank(a)-rank(b)).slice(0,8);
    content.innerHTML=`<div class="overview-grid"><section class="panel"><h3>各阶段完成进度</h3>${stages.map(s=>{const items=list.filter(t=>t.stage===s);return `<div class="stage-row"><span>${esc(s)}</span>${track(progress(items))}<small>${items.filter(done).length} / ${items.length}</small></div>`;}).join('')||'<div class="empty">添加任务后自动生成统计</div>'}<div class="form-section">项目状态分布</div>${statuses.filter(s=>list.some(t=>t.status===s)).map(s=>`<div class="stage-row"><span>${s}</span>${track(list.filter(t=>t.status===s).length/Math.max(1,list.length)*100)}<small>${list.filter(t=>t.status===s).length} 项</small></div>`).join('')}</section><section class="panel"><h3>优先关注 · 下一步待办</h3>${urgent.map(t=>`<div class="urgent-item"><span class="task-number">${esc(t.id)}</span><div><button data-task="${esc(t.id)}">${esc(t.title)}</button><p>${esc(t.nextAction||'补充下一步行动')}</p><p>${esc(t.owner||'待指定')} · ${esc(t.end||'待排期')} ${overdue(t)?'· 已逾期':''}</p></div></div>`).join('')||'<div class="empty">当前没有未完成任务</div>'}</section><section class="panel wide"><h3>项目说明</h3><div class="project-content">${esc(state.project.content||'暂无项目说明')}</div><p class="muted">项目负责人：${esc(state.project.owner||'待指定')} · 计划日期：${esc(state.project.start||'待填写')} — ${esc(state.project.end||'待填写')}</p></section></div>`;
  }
}
function safeURL(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:'#';}catch{return '#';}}
function field(name,label,value,type='text',wide=false){return `<label class="${wide?'wide':''}">${label}${type==='textarea'?`<textarea name="${name}">${esc(value)}</textarea>`:`<input name="${name}" type="${type}" value="${esc(value)}" ${type==='number'?'min="0" max="100" step="1"':''} ${name==='title'||name==='name'||name==='stage'?'required':''} ${name==='id'?'required pattern="[A-Za-z0-9_.-]{1,80}"':''}>`}</label>`;}
function select(name,label,value,values){return `<label>${label}<select name="${name}">${values.map(v=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(v||'待填写')}</option>`).join('')}</select></label>`;}
function blankTask(status='未开始'){return {id:'T-'+crypto.randomUUID().slice(0,8),title:'',stage:state.filters.stage||'项目实施',content:'',owner:'',collaborator:'',status,progress:status==='已完成'?1:0,priority:'中',start:'',end:'',nextAction:'',criteria:'',followup:'',blocker:'',decision:'',evidence:'',actualEnd:'',acceptance:'',originalAction:'',originalDeliverable:'',sourceRow:null,version:0};}
function taskKey(task){return state.project.id+':'+(task.version?'task:'+task.id:'new-task');}
function openTask(id,status){
  const base=id?state.tasks.find(t=>t.id===id):blankTask(status);if(!base)return;
  const draft=draftGet(taskKey(base));editTask=structuredClone(draft?.task||base);editTask.key=taskKey(base);editTask.isNew=!base.version;
  taskDirty=!!draft;
  renderTaskForm(base,!!draft);$('editor').showModal();
}
function renderTaskForm(base,hasDraft=false){
  const t=editTask;
  $('editor').innerHTML=`<div class="dialog-head"><div><small>${t.isNew?'NEW TASK':esc(t.id)+' · VERSION '+t.version}</small><h2 id="editor-title">${t.isNew?'新建任务':'任务详情与跟进'}</h2></div><button class="dialog-close" data-close="editor" aria-label="关闭任务详情">×</button></div><form id="task-form"><div class="dialog-body">${hasDraft?'<div class="draft-notice">已恢复本机未提交的草稿。保存后才会写入数据库。<button type="button" data-action="discard-draft">放弃草稿</button></div>':''}<div class="form-section">任务内容</div><div class="field-grid">${t.isNew?field('id','任务编号',t.id):''}${field('title','任务名称',t.title,'text',!t.isNew)}${field('stage','项目阶段',t.stage)}${select('priority','优先级',t.priority,['待确认','高','中','低'])}${field('content','项目内容 / 工作范围',t.content,'textarea',true)}</div><div class="form-section">责任人与执行进展</div><div class="field-grid">${field('owner','主责人',t.owner)}${field('collaborator','协作人 / 配合方',t.collaborator)}${select('status','当前状态',t.status,statuses)}${field('progress','完成率（0—100%，可留空）',t.progress===null?'':Math.round(t.progress*100),'number')}${field('start','计划开始日期',t.start,'date')}${field('end','计划结束日期',t.end,'date')}${field('followup','下次跟进日期',t.followup,'date')}${field('actualEnd','实际完成日期',t.actualEnd,'date')}${field('nextAction','下一步行动 / 待办事项',t.nextAction,'textarea',true)}${field('blocker','问题 / 风险 / 阻塞',t.blocker,'textarea',true)}${field('decision','待协调事项 / 决策',t.decision,'textarea',true)}</div><div class="form-section">交付与验收</div><div class="field-grid">${field('criteria','验收要点（原建议可修改）',t.criteria,'textarea',true)}${field('evidence','交付链接 / 文档版本 / 说明',t.evidence,'textarea',true)}${select('acceptance','验收结论',t.acceptance,['','待验收','验收通过','需整改','不适用'])}</div>${t.originalAction||t.originalDeliverable||t.sourceRow?`<div class="form-section">原计划参考</div><div class="source-box">${esc(t.originalAction||'')}${t.originalDeliverable?'\n原计划交付物：'+esc(t.originalDeliverable):''}${t.sourceRow?'\n原表位置：项目计划第 '+t.sourceRow+' 行':''}</div>`:''}<p id="task-error" class="error" role="alert"></p><div id="task-conflict"></div><div id="draft-state" class="save-state">${hasDraft?'本机草稿已恢复':'编辑后会保留本机草稿，点击保存写入数据库。'}</div>${!t.isNew?'<div class="form-section">修改记录</div><button type="button" class="link" data-action="history">查看历史版本 ↗</button><div id="task-history"></div>':''}</div><div class="dialog-foot"><small>${t.isNew?'创建后自动进入项目看板':'数据库版本 v'+t.version+' · '+time(base.updatedAt)}</small><div>${t.isNew?'':'<button type="button" class="danger" data-action="archive-task">删除任务</button>'}<button type="submit" class="primary" id="save-task">${t.isNew?'创建任务':'保存到数据库'}</button></div></div></form>`;
  $('task-form').oninput=()=>{taskDirty=true;persistTaskDraft();};
  $('task-form').onsubmit=saveTask;
}
function collectTask(){
  const data={...editTask};delete data.key;delete data.isNew;
  for(const [key,value]of new FormData($('task-form')))data[key]=String(value).trim();
  data.progress=data.progress===''?null:Number(data.progress)/100;
  return data;
}
function persistTaskDraft(){if(!$('task-form'))return;const task=collectTask();if(draftSet(editTask.key,{task,savedAt:new Date().toISOString()}))$('draft-state').textContent='本机草稿已保留 · '+new Date().toLocaleTimeString('zh-CN')+' · 尚未提交数据库';}
async function saveTask(e){
  e.preventDefault();const data=collectTask(),key=editTask.key,isNew=editTask.isNew;
  if(data.status==='已完成'&&data.progress!==1){$('task-error').textContent='已完成任务的完成率需要填写为 100%。';return;}
  persistTaskDraft();const button=$('save-task');button.disabled=true;$('task-error').textContent='';
  const controls=[...$('task-form').elements];controls.forEach(el=>el.disabled=true);
  try{
    const result=await api(projectPath('/tasks'+(isNew?'':'/'+data.id)),{method:isNew?'POST':'PUT',body:JSON.stringify(data)});
    state.tasks=isNew?[...state.tasks,result.task]:state.tasks.map(t=>t.id===data.id?result.task:t);
    draftRemove(key);taskDirty=false;$('editor').close();renderProject();toast('已保存到数据库。');await loadProjects();
  }catch(err){
    $('task-error').textContent=err.message;
    if(err.status===409&&err.data.current){
      const current=err.data.current;
      $('task-conflict').innerHTML=`<div class="conflict"><strong>发现更新，请合并后再保存</strong><p>你的填写已保留。下面是数据库中的最新内容（v${current.version}）。点击“以最新版本继续合并”将保留当前填写并更新版本号，请手动核对差异。</p><pre>${esc(taskSummary(current))}</pre><button type="button" id="merge-current">以最新版本继续合并</button></div>`;
      $('merge-current').onclick=()=>{editTask.version=current.version;state.tasks=state.tasks.map(t=>t.id===current.id?current:t);persistTaskDraft();$('task-error').textContent='已切换到最新版本，请核对并合并上方字段，然后重新保存。';$('task-conflict').innerHTML='';};
    }
  }finally{controls.forEach(el=>el.disabled=false);}
}
function taskSummary(task){return [['任务',task.title],['内容',task.content],['负责人',task.owner],['协作方',task.collaborator],['优先级',task.priority],['阶段',task.stage],['状态',task.status],['完成率',task.progress===null?'未知':Math.round(task.progress*100)+'%'],['计划开始',task.start],['计划结束',task.end],['下一步',task.nextAction],['跟进日期',task.followup],['风险',task.blocker],['待决策',task.decision],['交付',task.evidence],['验收要点',task.criteria],['验收结论',task.acceptance],['实际完成',task.actualEnd]].map(([k,v])=>k+'：'+(v||'—')).join('\n');}
async function history(){
  try{const data=await api(projectPath('/tasks/'+editTask.id+'/history'));
    $('task-history').innerHTML=data.history.map(h=>`<div class="history-item"><div class="history-item-head"><strong>v${h.version} · ${esc(h.action)}</strong>${h.version===state.tasks.find(t=>t.id===editTask.id)?.version?tag('当前版本','purple'):`<button type="button" data-history-restore="${h.version}">恢复此版本</button>`}</div><p>${time(h.at)}</p><details><summary>查看版本内容</summary><pre>${esc(taskSummary(h.task))}</pre></details></div>`).join('');
  }catch(err){toast(err.message);}
}
async function restoreVersion(version){
  if(!confirm('将此任务恢复到 v'+version+'？当前版本仍会保留在修改记录中。'))return;
  if(taskDirty&&!confirm('当前有未提交的草稿。恢复历史版本会替换这些填写，是否继续？'))return;
  try{const result=await post(projectPath('/tasks/'+editTask.id+'/restore'),{version:editTask.version,targetVersion:version});state.tasks=state.tasks.map(t=>t.id===result.task.id?result.task:t);draftRemove(editTask.key);taskDirty=false;$('editor').close();renderProject();toast('已恢复历史版本，并生成新的修改记录。');}catch(err){toast(err.message);}
}
async function archiveTask(id){
  const task=state.tasks.find(t=>t.id===id);if(!task)return;
  if(!task.archived&&!confirm('将「'+task.title+'」移入任务回收站？可以随时恢复。'))return;
  try{const result=await post(projectPath('/tasks/'+id+'/archive'),{version:task.version});state.tasks=state.tasks.map(t=>t.id===id?result.task:t);if($('editor').open)$('editor').close();taskDirty=false;renderProject();await loadProjects();toast(task.archived?'任务已恢复。':'任务已移入回收站。');}catch(err){toast(err.message);}
}
function projectDraftKey(){return projectMode==='create'?'new-project':state.project.id+':project-'+projectMode;}
function projectEditor(mode='create'){
  projectMode=mode;generated=[];projectDirty=false;
  const draft=draftGet(projectDraftKey()),p=draft?.project||(mode==='create'?{name:'',description:'',content:'',owner:'',start:'',end:''}:state.project);
  if(draft){generated=draft.generated||[];projectDirty=true;}
  const generateOnly=mode==='generate',edit=mode==='edit';
  $('project-editor').innerHTML=`<div class="dialog-head"><div><small>${generateOnly?'GENERATE YOUR PLAN':edit?'PROJECT SETTINGS':'A NEW BEGINNING'}</small><h2 id="project-editor-title">${generateOnly?'根据项目内容生成任务':edit?'编辑项目信息':'开始一个新项目'}</h2></div><button class="dialog-close" data-close="project-editor" aria-label="关闭项目编辑">×</button></div><form id="project-form"><div class="dialog-body">${draft?'<div class="draft-notice">已恢复上次未提交的项目草稿。<button type="button" data-action="discard-project-draft">放弃草稿</button></div>':''}${generateOnly?'':`<div class="field-grid">${field('name','项目名称',p.name,'text',true)}${field('description','一句话描述项目',p.description,'text',true)}${field('owner','项目负责人',p.owner)}${field('start','计划开始',p.start,'date')}${field('end','计划结束',p.end,'date')}</div><div class="form-section">项目内容与计划</div>`}${edit?'':`<p class="hint">每行填写一项工作，或使用编号列表。支持提取「负责人：张三」「截止：2026-11-10」；用「需求阶段：」这样的单独一行划分阶段。未明确的信息会留空，生成后请检查。</p>`}<label>${generateOnly?'补充项目计划（新任务会追加到当前项目）':'项目说明 / 工作事项'}<textarea class="large" name="content" id="project-content" placeholder="需求阶段：&#10;1. 完成用户访谈，负责人：张三，截止：2026-11-05&#10;2. 输出需求文档，负责人：李四，截止：2026-11-08，交付物：确认后的需求说明书&#10;交付阶段：&#10;3. 联调测试与验收，截止：2026-11-20">${esc(generateOnly&&!draft?'':p.content)}</textarea></label>${edit?'':`<div class="generate-controls"><button type="button" id="generate-preview">✧ 提取任务并预览</button><small>按内容提取，不自动猜测负责人和排期</small></div><div id="generated-preview"></div>`}<p id="project-error" class="error" role="alert"></p><div id="project-draft-state" class="save-state">项目内容会保留本机草稿，提交后保存到数据库。</div></div><div class="dialog-foot"><small>${generateOnly?'生成任务会追加，已有任务保留':edit?'更新项目信息，任务单独维护':'看板、待办与统计将自动生成'}</small><div><button class="primary" type="submit" id="save-project">${generateOnly?'添加选中的任务':edit?'保存项目信息':'创建项目'}</button></div></div></form>`;
  $('project-form').oninput=e=>{if(e.target.name==='content'&&generated.length){generated=[];if($('generated-preview'))$('generated-preview').innerHTML='<p class="muted">内容已修改，请重新提取任务。</p>';}projectDirty=true;persistProjectDraft();};
  $('project-form').onsubmit=saveProject;
  if(!edit)$('generate-preview').onclick=generatePreview;
  if(generated.length)renderGenerated();$('project-editor').showModal();
}
function collectProject(){return Object.fromEntries(new FormData($('project-form')));}
function persistProjectDraft(){if(!$('project-form'))return;draftSet(projectDraftKey(),{project:collectProject(),generated,savedAt:new Date().toISOString()});$('project-draft-state').textContent='项目草稿已保留在本机 · 尚未提交数据库';}
async function generatePreview(){
  const button=$('generate-preview');button.disabled=true;$('project-error').textContent='';
  try{const data=await post('/api/generate',{content:$('project-content').value});generated=data.tasks.map(t=>({...t,selected:true}));renderGenerated();projectDirty=true;persistProjectDraft();toast('已提取 '+generated.length+' 项任务，请检查后提交。');}catch(err){$('project-error').textContent=err.message;}finally{button.disabled=false;}
}
function renderGenerated(){
  $('generated-preview').innerHTML=`<div class="preview-head"><strong>任务预览 · ${generated.length} 项</strong><small>取消勾选可跳过，保存后可逐项修改</small></div>`+generated.map((t,i)=>`<div class="generated-task"><input type="checkbox" aria-label="选择任务 ${i+1}" data-generated="${i}" ${t.selected?'checked':''}><div><label>${esc(t.title)}</label><p>${esc(t.stage)} · ${esc(t.owner||'待指定负责人')} · ${esc(t.end||'待排期')}</p><p>下一步：${esc(t.nextAction)}</p>${t.criteria?'<p>验收：'+esc(t.criteria)+'</p>':''}</div></div>`).join('');
  $('generated-preview').onchange=e=>{if(e.target.dataset.generated!==undefined){generated[Number(e.target.dataset.generated)].selected=e.target.checked;persistProjectDraft();}};
}
async function saveProject(e){
  e.preventDefault();let tasks=generated.filter(t=>t.selected).map(({selected,...t})=>t),data=collectProject();
  if(projectMode==='generate'&&!tasks.length){$('project-error').textContent='请先提取任务，并至少选择一项。';return;}
  if(projectMode==='create'&&data.content.trim()&&!generated.length){$('project-error').textContent='请先点击“提取任务并预览”，确认待办后再创建项目；也可以清空内容，先创建空项目。';return;}
  persistProjectDraft();const button=$('save-project');button.disabled=true;$('project-error').textContent='';
  try{
    let id=state.project?.id;
    if(projectMode==='create'){
      const result=await post('/api/projects',{...data,tasks});id=result.project.id;
    }else if(projectMode==='edit'){
      await api(projectPath(),{method:'PUT',body:JSON.stringify({...data,version:state.project.version})});
    }else{
      const ids=new Set(state.tasks.map(t=>t.id));let next=1;
      tasks=tasks.map(t=>{while(ids.has('T-'+String(next).padStart(3,'0')))next++;const id='T-'+String(next++).padStart(3,'0');ids.add(id);return {...t,id};});
      await post(projectPath('/import'),{tasks,versions:Object.fromEntries(state.tasks.map(t=>[t.id,t.version]))});
    }
    draftRemove(projectDraftKey());projectDirty=false;$('project-editor').close();await loadProjects();await openProject(id,projectMode!=='create');toast(projectMode==='generate'?'已添加 '+tasks.length+' 项任务，看板和统计已更新。':'项目信息已保存到数据库。');
  }catch(err){$('project-error').textContent=err.message;}finally{button.disabled=false;}
}
async function archiveProject(id){
  const p=state.projects.find(p=>p.id===id);if(!p)return;
  if(!p.archived&&!confirm('删除项目「'+p.name+'」？项目会移入回收站，任务与历史记录均保留。'))return;
  try{await post('/api/projects/'+id+'/archive',{version:p.version});await loadProjects();if(p.archived)await openProject(id);else home();toast(p.archived?'项目已恢复。':'项目已移入回收站。');}catch(err){toast(err.message);}
}
function download(data,name,type){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([data],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function exportProject(){try{const data=await api(projectPath('/export'));download(JSON.stringify(data,null,2),state.project.name+'-备份-'+today()+'.json','application/json');toast('已导出数据库中的全部项目任务，包含回收站任务。');}catch(err){toast(err.message);}}
async function exportCSV(){
  try{const data=await api(projectPath('/export'));const columns=[['id','任务编号'],['stage','阶段'],['title','任务名称'],['content','项目内容'],['owner','负责人'],['collaborator','协作人'],['status','状态'],['progress','完成率'],['start','计划开始'],['end','计划结束'],['nextAction','下一步待办'],['followup','跟进日'],['blocker','问题风险'],['decision','待决策'],['criteria','验收要点'],['evidence','交付记录'],['actualEnd','实际完成日'],['acceptance','验收结论'],['archived','在回收站']];
    const quote=v=>{let s=String(v??'');if(/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
    const csv=[columns.map(c=>quote(c[1])).join(','),...data.tasks.map(t=>columns.map(([k])=>quote(k==='progress'?(t[k]===null?'':Math.round(t[k]*100)+'%'):t[k])).join(','))].join('\r\n');download('\ufeff'+csv,state.project.name+'-待办-'+today()+'.csv','text/csv;charset=utf-8');
  }catch(err){toast(err.message);}
}
async function importFile(e){
  const file=e.target.files[0];if(!file)return;
  try{
    if(file.size>4000000)throw Error('文件大于 4MB，请分批导入');
    const text=await file.text();let data;
    if(file.name.toLowerCase().endsWith('.html')){const doc=new DOMParser().parseFromString(text,'text/html');const seed=doc.querySelector('#seed-data');if(!seed)throw Error('HTML 中没有可识别的项目记录');data=JSON.parse(seed.textContent);}else data=JSON.parse(text);
    if(!Array.isArray(data.tasks)||!data.tasks.length)throw Error('文件没有有效任务');
    if(data.project?.id&&data.project.id!==state.project.id)throw Error('备份来自其他项目，请切换至原项目后导入，避免覆盖同编号任务');
    if(!data.project?.id&&state.project.id!=='haikang'&&data.source?.includes('DUEFTVVpqZ0RKRUJH'))throw Error('这是海康项目的旧版记录，请切换至海康项目后导入');
    if(!confirm(`将 ${data.tasks.length} 项记录合并至「${state.project.name}」？同编号任务将更新，文件中没有的任务保留。导入前会自动备份。`))return;
    await post(projectPath('/import'),{tasks:data.tasks,versions:Object.fromEntries(state.tasks.map(t=>[t.id,t.version]))});await openProject(state.project.id,true);await loadProjects();toast('记录已导入，并保留导入前的历史版本。');
  }catch(err){toast('导入失败：'+err.message);}finally{e.target.value='';}
}
async function action(name){
  switch(name){
    case 'create-project':return projectEditor();case 'edit-project':return projectEditor('edit');case 'generate':return projectEditor('generate');case 'new-task':return openTask();
    case 'reload-home':await loadProjects();return home(state.page==='trash');
    case 'refresh-project':return openProject(state.project.id,true);
    case 'toggle-archive':state.archived=!state.archived;return renderProject();
    case 'export':return exportProject();case 'csv':return exportCSV();case 'import':return $('import-file').click();
    case 'backup':await post(projectPath('/backup'));toast('数据库完整备份已生成并通过完整性检查。');return openProject(state.project.id,true);
    case 'delete-project':return archiveProject(state.project.id);
    case 'history':return history();case 'archive-task':return archiveTask(editTask.id);
    case 'discard-draft':if(!confirm('放弃这份未提交的草稿？'))return;draftRemove(editTask.key);taskDirty=false;$('editor').close();return openTask(editTask.isNew?undefined:editTask.id);
    case 'discard-project-draft':if(!confirm('放弃这份项目草稿？'))return;draftRemove(projectDraftKey());projectDirty=false;$('project-editor').close();return projectEditor(projectMode);
  }
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  try{
    if(b.dataset.project)return await openProject(b.dataset.project);
    if(b.dataset.task)return openTask(b.dataset.task);
    if(b.dataset.view){state.view=b.dataset.view;state.archived=false;return renderProject();}
    if(b.dataset.newStatus)return openTask(undefined,b.dataset.newStatus);
    if(b.dataset.action)return await action(b.dataset.action);
    if(b.dataset.restoreProject)return await archiveProject(b.dataset.restoreProject);
    if(b.dataset.restoreTask)return await archiveTask(b.dataset.restoreTask);
    if(b.dataset.historyRestore)return await restoreVersion(Number(b.dataset.historyRestore));
    if(b.dataset.close){$(b.dataset.close).close();if(b.dataset.close==='editor')taskDirty=false;else projectDirty=false;}
  }catch(err){toast(err.message);}
});
for(const id of ['editor','project-editor'])$(id).addEventListener('cancel',()=>{if(id==='editor')taskDirty=false;else projectDirty=false;});
window.addEventListener('beforeunload',e=>{if(taskDirty||projectDirty){e.preventDefault();e.returnValue='';}});
window.addEventListener('offline',()=>{$('connection').textContent='连接中断 · 请保留草稿';toast('网络已断开。填写会保留本机草稿，恢复连接后请重新保存到数据库。');});
window.addEventListener('online',()=>{$('connection').innerHTML='<i class="small-dot"></i> 已连接';toast('网络已恢复，请重新保存尚未提交的填写。');});
boot();
