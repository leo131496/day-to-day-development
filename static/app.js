'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses = ['待确认','未开始','进行中','待验收','受阻','已延期','暂停','已完成'];
const defaultFilters=()=>({q:'',stage:'',owner:'',status:'',focus:'all',sort:'wbs'});
const state = {csrf:'',user:null,projects:[],project:null,tasks:[],risks:[],calendars:{},view:'list',page:'home',filters:defaultFilters(),archived:false,load:0};
let recoveryPending=false,recoveryReceipt=null;
let editTask = null, taskDirty = false, projectDirty = false, calendarDirty = false, generated = [], projectMode = 'create';
let workloadPreviewSequence=0,workloadPreviewTimer=null,calendarYear=2026,calendarVersion=0;
const prefix = 'project-space-draft-v1:';
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const time = value => value ? new Date(value).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}) : '—';
const done = t => t.status === '已完成' && t.progress === 1;
const overdue = t => !done(t) && t.end && t.end < today();
const near = t => !done(t) && t.end && t.end >= today() && t.end <= new Date(Date.parse(today()+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
const hoursText=value=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:1});
function metrics(tasks){
  const active=tasks.filter(t=>!t.archived),known=active.filter(t=>t.progress!==null&&t.progress!==undefined),ready=active.filter(t=>t.workload?.hours!==null&&t.workload?.hours!==undefined);
  const hours=ready.reduce((sum,t)=>sum+t.workload.hours,0),weighted=hours>0&&ready.length===active.length&&known.length===active.length;
  return {total:active.length,hours,ready:ready.length,unpriced:active.length-ready.length,known:known.length,weighted,
    percent:weighted?active.reduce((sum,t)=>sum+t.workload.hours*t.progress,0)/hours*100:known.length?known.reduce((sum,t)=>sum+t.progress,0)/known.length*100:0,
    equivalent:ready.reduce((sum,t)=>sum+t.workload.hours*(t.progress||0),0),missingYears:[...new Set(active.flatMap(t=>t.workload?.missingYears||[]))]};
}
const progress=tasks=>Math.round(metrics(tasks).percent*10)/10;
const progressRule=m=>m.weighted?'按计划工时加权':'按已填任务进度平均（'+m.known+'/'+m.total+' 项）';
const tag = (text,color='') => `<span class="tag ${color}">${esc(text)}</span>`;
const statusLabel = ProjectStatus.label;
const track = (n,tone='') => `<div class="progress-track ${tone?'tone-'+tone:''}"><progress max="100" value="${Number(n)||0}" aria-label="完成进度 ${Number(n)||0}%"></progress></div>`;
function statusPills(task){return `<span class="task-statuses">${tag(statusLabel(task.status),ProjectStatus.rawTone(task.status))}${overdue(task)&&task.status!=='已延期'?tag('已逾期','red'):''}</span>`;}
function statusSummary(tasks){return `<div class="owner-status-tags">${statuses.filter(status=>tasks.some(task=>task.status===status)).map(status=>tag(statusLabel(status)+' '+tasks.filter(task=>task.status===status).length,ProjectStatus.rawTone(status))).join('')}</div>`;}
function statusLegend(){return `<div class="status-legend" aria-label="任务状态颜色说明">${[['red','逾期'],['green','进行中'],['gray','未开始'],['amber','挂起'],['blue','已完成']].map(([tone,label])=>`<span class="tone-${tone}"><i aria-hidden="true"></i>${label}</span>`).join('')}<small>超过计划结束日期且未完成的任务标红。</small></div>`;}
function dataProvenance(){
  const project=state.project,source=project.source&&safeURL(project.source),original=activeTasks().filter(task=>Number.isInteger(task.sourceRow)),updated=original.filter(task=>task.version>1);
  return `<details class="data-provenance"><summary>数据来源与统计说明<span>${source&&source!=='#'?'计划整理快照'+(project.sourceDate?' · '+esc(project.sourceDate):''):'已保存的项目工作清单'}</span></summary><div>${source&&source!=='#'?`<p>原始来源：<a href="${esc(source)}" target="_blank" rel="noopener noreferrer">查看项目计划原文 ↗</a>。${original.length} 项保留原表位置，${updated.length} 项有后续修改记录；未实时同步外部文档。</p>`:'<p>内容来自本项目人工录入、文件或链接导入，以及项目内容提取后确认保存的工作项。外部文件后续修改不会自动同步。</p>'}<p>工作内容、负责人、排期、状态和进度以原计划及后续登记为依据，当前执行情况需负责人核实。下一步行动和验收要点可能含整理建议，请核对后使用。</p><p>工时按单项排期扣除放假及周末、计入补班后按每日 8H 折算；完成折算为计划工时乘以登记进度，均不等于实报工时。并行任务的工作日不合并为项目工期或人天。</p></div></details>`;
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5500);}
const draftKey=key=>prefix+(state.user?.id||'anonymous')+':'+key;
function draftGet(key){try{const raw=localStorage.getItem(draftKey(key))||(state.user?.id==='admin'?localStorage.getItem(prefix+key):null);return JSON.parse(raw||'null');}catch{return null;}}
function draftSet(key,value){try{localStorage.setItem(draftKey(key),JSON.stringify(value));if(state.user?.id==='admin')localStorage.removeItem(prefix+key);return true;}catch{toast('浏览器草稿保存失败，请保持页面打开并保存到数据库。');return false;}}
function draftRemove(key){try{localStorage.removeItem(draftKey(key));if(state.user?.id==='admin')localStorage.removeItem(prefix+key);}catch{}}
async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Requested-With':'ProjectBoard','X-CSRF-Token':state.csrf,...options.headers},cache:'no-store'});
  const data=await response.json();
  if(!response.ok){const error=new Error(data.error||'请求失败，请稍后重试');error.status=response.status;error.data=data;if(response.status===401&&path!=='/api/login')showLogin();throw error;}
  return data;
}
const post=(path,body={})=>api(path,{method:'POST',body:JSON.stringify(body)});
const projectPath=suffix=>'/api/projects/'+state.project.id+(suffix||'');
function showLogin(){
  clearTimeout(toast.timer);$('toast').hidden=true;
  state.load++;state.csrf='';state.user=null;state.projects=[];state.tasks=[];state.risks=[];state.project=null;
  $('login').hidden=false;$('workspace').hidden=true;
  for(const id of ['editor','project-editor','account-editor','calendar-editor','import-editor','risk-editor'])if($(id).open)$(id).close();
  taskDirty=false;projectDirty=false;calendarDirty=false;
  if(!recoveryPending)authMode('login');
}
function setSession(data){state.csrf=data.csrf;state.user=data.user;$('account-name').textContent=data.user.displayName+' · 账号设置';$('account-button').textContent=data.user.displayName.slice(0,1);}
async function boot(){try{setSession(await api('/api/session'));await enter();}catch{showLogin();}}
async function enter(){
  $('login').hidden=true;$('workspace').hidden=false;
  await loadProjects();
  const id=location.hash.slice(1);
  if(id&&state.projects.some(p=>p.id===id&&!p.archived))await openProject(id,false,['dashboard','risks'].includes(new URLSearchParams(location.search).get('view'))?new URLSearchParams(location.search).get('view'):'list');else home();
}
$('login-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;$('login-error').textContent='';try{setSession(await post('/api/login',{username:$('username').value.trim(),password:$('password').value}));$('password').value='';await enter();}catch(err){$('login-error').textContent=err.message;}finally{button.disabled=false;}};
$('logout').onclick=async()=>{try{await post('/api/logout');showLogin();}catch(err){toast(err.message);}};
$('account-settings').onclick=accountSettings;$('account-button').onclick=accountSettings;
function authMode(mode){
  if(recoveryPending)return;
  for(const name of ['login','register','reset']){const form=$(name+'-form');form.hidden=name!==mode;form.querySelectorAll('input[autocomplete=current-password],input[autocomplete=new-password]').forEach(input=>{input.value='';input.type='password';});form.querySelectorAll('[data-toggle-password]').forEach(button=>{button.textContent='显示';button.setAttribute('aria-label','显示密码');});$(name+'-error').textContent='';}
  $('recovery-receipt').hidden=true;$('auth-tabs').hidden=mode==='reset';
  document.querySelectorAll('#auth-tabs [data-auth-mode]').forEach(button=>{button.classList.toggle('active',button.dataset.authMode===mode);button.setAttribute('aria-pressed',String(button.dataset.authMode===mode));});
  if(mode==='reset'&&!$('reset-username').value)$('reset-username').value=$('username').value;
}
function showRecovery(data,reset=false){
  recoveryPending=true;recoveryReceipt={username:data.user?.username||data.username,code:data.recoveryCode};
  for(const mode of ['login','register','reset']){$(mode+'-form').hidden=true;$(mode+'-form').querySelectorAll('input[autocomplete=current-password],input[autocomplete=new-password]').forEach(input=>{input.value='';input.type='password';});}
  $('auth-tabs').hidden=true;$('recovery-receipt').hidden=false;$('recovery-title').textContent=reset?'密码已重置':'账号已创建';
  $('recovery-description').textContent=reset?'旧密码及原恢复码已失效。请保存新恢复码，再使用新密码登录。':'你好，'+(data.user?.displayName||recoveryReceipt.username)+'。请先保存用于找回密码的恢复码。';
  $('recovery-code').textContent=data.recoveryCode;$('recovery-saved').checked=false;$('recovery-continue').disabled=true;
}
function authSubmit(mode,path){
  $(mode+'-form').onsubmit=async e=>{
    e.preventDefault();const form=e.target,values=Object.fromEntries(new FormData(form));
    const password=values.password??values.newPassword;
    if(password!==values.confirmPassword){$(mode+'-error').textContent='两次输入的密码不一致。';return;}
    const controls=[...form.elements];controls.forEach(input=>input.disabled=true);form.setAttribute('aria-busy','true');$(mode+'-error').textContent='';
    try{const data=await post(path,values);showRecovery(data,mode==='reset');}catch(err){$(mode+'-error').textContent=err.message;}finally{controls.forEach(input=>input.disabled=false);form.removeAttribute('aria-busy');}
  };
}
authSubmit('register','/api/register');authSubmit('reset','/api/reset-password');
$('download-recovery').onclick=()=>{if(recoveryReceipt)download('序 · 项目工作台\n账号：'+recoveryReceipt.username+'\n密码恢复码：'+recoveryReceipt.code+'\n\n恢复码可以重置账号密码，请妥善保管，不要分享给他人。\n恢复密码后旧恢复码失效，请保存系统提供的新恢复码。\n',recoveryReceipt.username+'-密码恢复码.txt','text/plain;charset=utf-8');};
$('recovery-saved').onchange=e=>$('recovery-continue').disabled=!e.target.checked;
$('recovery-continue').onclick=()=>{if(!$('recovery-saved').checked)return;$('username').value=recoveryReceipt.username;recoveryReceipt=null;recoveryPending=false;$('recovery-code').textContent='';$('reset-code').value='';authMode('login');$('password').focus();};
function accountSettings(){
  closeNav();const user=state.user;if(!user)return;
  $('account-editor').innerHTML=`<div class="dialog-head"><div><small>YOUR ACCOUNT</small><h2 id="account-title">账号设置</h2></div><button class="dialog-close" data-close="account-editor" aria-label="关闭账号设置">×</button></div><form id="password-form" class="account-form"><div class="dialog-body"><div class="account-profile"><span class="account-avatar">${esc(user.displayName.slice(0,1))}</span><div><strong>${esc(user.displayName)}</strong><small>登录账号：${esc(user.username)}</small></div></div><div class="form-section">修改登录密码</div><label>当前密码<input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required maxlength="128" placeholder="请输入当前密码"></label><label>新密码<div class="password-input"><input id="new-password" name="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128" placeholder="至少 12 个字符，支持长密码"><button type="button" data-toggle-password="new-password" aria-label="显示密码">显示</button></div></label><label>确认新密码<input id="confirm-new-password" name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128" placeholder="再次输入新密码"></label><p class="hint">修改成功后，其他设备上的登录将失效。当前页面继续保持登录，项目数据与已保存的恢复码保留。</p><p id="password-error" class="error" role="alert"></p></div><div class="dialog-foot"><small>密码不会以明文保存在数据库中</small><button class="primary" type="submit" id="change-password">保存新密码</button></div></form>`;
  $('password-form').onsubmit=async e=>{
    e.preventDefault();const data=Object.fromEntries(new FormData(e.target));
    if(data.newPassword!==data.confirmPassword){$('password-error').textContent='两次输入的新密码不一致。';return;}
    const controls=[...e.target.elements];controls.forEach(input=>input.disabled=true);$('password-error').textContent='';
    try{setSession(await post('/api/change-password',data));$('account-editor').close();$('account-editor').innerHTML='';toast('密码已修改，其他设备需使用新密码重新登录。');}catch(err){$('password-error').textContent=err.message;}finally{controls.forEach(input=>input.disabled=false);}
  };
  if(user.role==='admin'){
    $('account-editor').insertAdjacentHTML('beforeend','<section class="dialog-body"><div class="form-section">完整数据库备份</div><p class="muted">包含全部账号、项目与历史记录，请另存到私人存储中。</p><button type="button" id="download-database-backup">下载完整备份</button></section>');
    $('download-database-backup').onclick=exportDatabase;
  }
  $('account-editor').showModal();
}
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
  $('main').classList.remove('dashboard-mode');const url=new URL(location.href);url.searchParams.delete('view');window.history.replaceState(null,'',url);
  state.load++;state.page=trash?'trash':'home';state.project=null;location.hash='';closeNav();renderSidebar();
  $('breadcrumb').innerHTML='工作空间 <span>/</span> '+(trash?'项目回收站':'项目总览');
  const projects=state.projects.filter(p=>p.archived===trash),active=state.projects.filter(p=>!p.archived);
  const portfolioHours=active.reduce((sum,p)=>sum+p.plannedHours,0),portfolioCount=active.reduce((sum,p)=>sum+p.total,0),portfolioWeighted=portfolioHours>0&&active.every(p=>p.summary.progressMethod==='hours'||!p.total);
  const portfolioProgress=portfolioWeighted?active.reduce((sum,p)=>sum+p.progress*p.plannedHours,0)/portfolioHours:active.reduce((sum,p)=>sum+p.progress*p.total,0)/Math.max(1,portfolioCount);
  $('main').innerHTML=`<section class="page-heading"><div><div class="eyebrow">YOUR WORK, IN ORDER</div><h1>${trash?'项目回收站':'每个计划，都向前一步。'}</h1><p>${trash?'项目及其任务、历史记录均保留，可随时恢复。':'从想法到交付，清晰掌握每个项目的进展。'}</p></div><div class="heading-actions">${trash?'':'<button class="primary" data-action="create-project">＋ 新建项目</button>'}<button data-action="reload-home">↻ 刷新</button></div></section>
  ${trash?'':`<div class="stats">${stat('全部项目',active.length,'个','一个空间，连接所有项目','▦')}${stat('累计完成',active.reduce((s,p)=>s+p.completed,0),'项','每一份进展，都值得记录','✓')}${stat('待推进任务',active.reduce((s,p)=>s+p.total-p.completed,0),'项','按项目查看责任人与待办','◷')}${stat('整体完成率',hoursText(portfolioProgress),'%',portfolioWeighted?'按计划工时汇总':'按各项目任务进度汇总','↗')}</div>`}
  <div class="section-head"><h2>${trash?'已删除的项目':'项目空间'} <small> / ${projects.length} 个项目</small></h2><small>${today().replaceAll('-',' / ')}</small></div><div class="project-grid">${projects.map(p=>`<article class="project-card"><div class="project-card-top"><span class="project-symbol">▧</span>${tag(trash?'已移入回收站':p.total&&p.total===p.completed?'已完成':'推进中',trash?'gray':p.total&&p.total===p.completed?'blue':'green')}</div><h3>${esc(p.name)}</h3><p>${esc(p.description||p.content||'添加项目内容，生成你的第一份任务计划。')}</p><div class="project-progress"><div class="progress-caption"><span>项目完成进度</span><span>${p.completed} / ${p.total} 项完成 · ${hoursText(p.progress)}%</span></div>${track(p.progress)}</div><div class="project-card-bottom"><span>${esc(p.owner||'待指定负责人')}</span>${trash?`<button class="link" data-restore-project="${p.id}">恢复项目 ↗</button>`:`<div class="project-entry-actions"><button class="link" data-dashboard-project="${p.id}">可视化看板</button><button class="link" data-project="${p.id}">进入项目 ↗</button></div>`}</div></article>`).join('')}${trash?'':`<button class="create-card" data-action="create-project"><span>＋</span><strong>开始一个新项目</strong><small>填写项目内容，生成工作清单与排期</small></button>`}</div>${trash&&!projects.length?'<div class="empty"><h3>回收站是空的</h3>删除的项目会保留在这里。</div>':''}`;
  $('backup-status').textContent='项目数据保存在服务器数据库中';
}
async function openProject(id,preserve=false,initialView='list'){
  const ticket=++state.load;closeNav();
  if(!preserve){state.filters=defaultFilters();state.archived=false;state.view=initialView;}
  if(!preserve)$('main').innerHTML='<div class="loading">正在打开项目空间…</div>';
  try{
    const data=await api('/api/projects/'+id);if(ticket!==state.load)return;
    state.project=data.project;state.tasks=data.tasks;state.risks=data.risks||[];state.calendars=data.workCalendar.years;state.backup=data.backup;state.page='project';location.hash=id;
    renderSidebar();renderProject();
  }catch(err){if(ticket!==state.load)return;$('main').innerHTML=`<div class="empty"><h3>项目暂时无法打开</h3><p>${esc(err.message)}</p><button data-action="reload-home">回到项目总览</button></div>`;toast(err.message);}
}
function activeTasks(){return state.tasks.filter(t=>!t.archived);}
function rank(t){return done(t)?9:overdue(t)||['受阻','已延期'].includes(t.status)?1:near(t)?2:3;}
function filtered(){const f=state.filters,q=f.q.toLowerCase();return state.tasks.filter(t=>t.archived===state.archived&&(!q||[t.id,t.title,t.content,t.owner,t.collaborator,t.nextAction,t.stage,t.blocker].join(' ').toLowerCase().includes(q))&&(!f.stage||t.stage===f.stage)&&(!f.owner||t.owner===f.owner)&&(!f.status||t.status===f.status)&&(f.focus==='all'||f.focus==='overdue'&&overdue(t)||f.focus==='near'&&near(t)||f.focus==='open'&&!done(t)||f.focus==='unassigned'&&!t.owner||f.focus==='blocked'&&['受阻','已延期'].includes(t.status))).sort((a,b)=>(f.sort==='end'?(a.end||'9999').localeCompare(b.end||'9999'):f.sort==='hours'?(b.workload?.hours??-1)-(a.workload?.hours??-1):f.sort==='progress'?(b.progress??-1)-(a.progress??-1):f.sort==='attention'?rank(a)-rank(b):0)||a.id.localeCompare(b.id,undefined,{numeric:true}));}
function options(values,current,first,label=value=>value){return `<option value="">${first}</option>`+values.map(v=>`<option ${current===v?'selected':''} value="${esc(v)}">${esc(label(v))}</option>`).join('');}
function renderProject(){
  $('main').classList.toggle('dashboard-mode',state.view==='dashboard'&&!state.archived);
  const url=new URL(location.href);if(['dashboard','risks'].includes(state.view))url.searchParams.set('view',state.view);else url.searchParams.delete('view');window.history.replaceState(null,'',url);
  const p=state.project,tasks=activeTasks(),m=metrics(tasks),missing=tasks.filter(t=>!t.owner||!t.start||!t.end).length;
  $('breadcrumb').innerHTML='工作空间 <span>/</span> '+esc(p.name);
  $('main').innerHTML=`<section class="page-heading"><div><div class="eyebrow">PROJECT DELIVERY · WORK REGISTER</div><h1>${esc(p.name)}</h1><p>${esc(p.description||'明确工作范围、责任分工和计划投入，持续跟踪交付进展。')}</p></div><div class="heading-actions"><button data-action="edit-project">项目信息</button><button data-action="calendar">工作日历</button><button data-action="import-worklist">↑ 导入工作清单</button><button data-action="generate">✧ 生成工作项</button><button class="primary" data-action="new-task">＋ 新增工作项</button></div></section>
  ${state.backup?.error?'<p class="backup-warning">最近一次自动备份失败，请检查服务器存储空间。当前数据库仍可使用，请及时导出备份。</p>':''}
  <div class="stats work-stats">${stat('工作清单',tasks.length,'项',tasks.filter(done).length+' 项已完成 · '+missing+' 项待补责任或排期','▦')}${stat('计划工时',hoursText(m.hours),'H','已计算 '+m.ready+'/'+m.total+' 项 · 每工作日 8H','◷')}${stat('整体进度',hoursText(m.percent),'%',progressRule(m),'↗')}${stat('进度关注',tasks.filter(overdue).length,'项逾期',tasks.filter(near).length+' 项 7 天内到期','⚑')}</div>
  <div class="calendar-policy"><span class="calendar-policy-icon">▦</span><div><strong>中国大陆工作日历 · 8H / 工作日</strong><p>起止日期均计入；扣除周末及法定放假，计入调休补班。${m.unpriced?'有 '+m.unpriced+' 项尚不能计算工时，请补齐日期或年度日历。':'当前已排期工作项均已按日历计算。'}</p></div><button class="link" data-action="calendar">查看计算依据 ↗</button></div>
  ${dataProvenance()}${statusLegend()}
  <div class="viewbar"><button class="viewtab ${state.view==='list'?'active':''}" data-view="list">☷ 项目工作清单</button><button class="viewtab ${state.view==='dashboard'?'active':''}" data-view="dashboard">◉ 可视化看板</button><button class="viewtab ${state.view==='board'?'active':''}" data-view="board">▥ 状态看板</button><button class="viewtab ${state.view==='overview'?'active':''}" data-view="overview">◴ 进度与工时</button><button class="viewtab ${state.view==='risks'?'active':''}" data-view="risks">⚑ 风险清单</button><span class="viewcount">${state.archived||state.tasks.filter(t=>t.archived).length?`<button class="link" data-action="toggle-archive">${state.archived?'返回工作清单':'工作项回收站'}</button>`:'责任清晰 · 过程留痕'}</span></div>
  <div class="filters"><input id="search" aria-label="搜索任务" placeholder="⌕ 搜索任务、内容或负责人…" value="${esc(state.filters.q)}"><select id="filter-stage" aria-label="筛选阶段">${options([...new Set(tasks.map(t=>t.stage))],state.filters.stage,'全部项目阶段')}</select><select id="filter-owner" aria-label="筛选负责人">${options([...new Set(tasks.map(t=>t.owner).filter(Boolean))],state.filters.owner,'全部负责人')}</select><select id="filter-focus" aria-label="筛选任务提醒">${[['all','全部任务'],['open','未完成'],['unassigned','负责人待定'],['overdue','已逾期'],['near','7 天内到期'],['blocked','受阻 / 延期']].map(([v,l])=>`<option value="${v}" ${state.filters.focus===v?'selected':''}>${l}</option>`).join('')}</select><button class="refresh" data-action="refresh-project">↻ 刷新数据</button></div>
  <div id="view-content"></div><div class="section-head"><small id="result-count"></small><div class="section-actions"><button data-action="export">导出备份</button><button data-action="csv">导出 CSV</button><button data-action="import">恢复 JSON 备份</button><button data-action="backup">立即备份</button><button class="danger" data-action="delete-project">删除项目</button></div></div><input type="file" id="import-file" accept=".json,.html" hidden>`;
  document.querySelector('.filters').hidden=state.view==='risks';
  $('search').oninput=e=>{state.filters.q=e.target.value;renderView();};
  $('filter-focus').insertAdjacentHTML('beforebegin',`<select id="filter-status" aria-label="筛选当前状态">${options(statuses,state.filters.status,'全部状态',statusLabel)}</select>`);
  $('filter-focus').insertAdjacentHTML('afterend',`<select id="filter-sort" aria-label="工作清单排序">${[['wbs','按工作编号'],['end','按结束日期'],['hours','按计划工时'],['progress','按进度百分比'],['attention','按关注优先级']].map(([v,label])=>`<option value="${v}" ${state.filters.sort===v?'selected':''}>${label}</option>`).join('')}</select>`);
  for(const [id,key]of [['filter-stage','stage'],['filter-owner','owner'],['filter-status','status'],['filter-focus','focus'],['filter-sort','sort']])$(id).onchange=e=>{state.filters[key]=e.target.value;renderView();};
  $('import-file').onchange=importFile;renderView();
  const viewbar=document.querySelector('.viewbar'),tab=viewbar.querySelector('.viewtab.active');if(tab)viewbar.scrollLeft+=tab.getBoundingClientRect().left-viewbar.getBoundingClientRect().left-Math.max(0,(viewbar.clientWidth-tab.clientWidth)/2);
  $('backup-status').textContent=state.backup?.error?'备份异常，请及时导出':'数据库已连接 · 最近备份 '+time(state.backup?.lastAt);
}
function badge(t){return statusPills(t)+(near(t)?tag('7 天内到期','amber'):'');}
function card(t){return `<button class="task-card tone-${statusTone(t)}" data-task="${esc(t.id)}"><div class="task-meta"><span>${esc(t.id)}</span><span>${esc(t.stage)}</span></div><h3>${esc(t.title)}</h3><p class="excerpt">${esc(t.content||'点击补充项目内容')}</p>${t.nextAction?`<div class="task-next">↳ ${esc(t.nextAction)}</div>`:''}<div>${badge(t)}</div><div class="task-foot"><span class="task-owner">${esc(t.owner||'待指定负责人')}</span><span>${esc(t.end?t.end.slice(5).replace('-',' / '):'待排期')}</span></div></button>`;}
function statusTone(task){return ProjectStatus.tone(task,overdue);}
function workloadHint(w){
  if(!w||w.status==='dates_missing')return '请补齐开始日期和结束日期';
  if(w.status==='calendar_missing')return '请配置 '+w.missingYears.join('、')+' 年工作日历';
  if(w.status!=='ready')return '请核对开始日期与结束日期';
  return `${w.calendarDays} 个自然日，扣除放假 ${w.holidayDays} 天、其他周末 ${w.weekendDays} 天；计入周末补班 ${w.makeupDays} 天。${w.workingDays} 个工作日 × 8H = ${w.hours}H。`;
}
function workloadCell(task){const w=task.workload;return w?.status==='ready'?`<strong class="hours-value" title="${esc(workloadHint(w))}">${hoursText(w.hours)}<span> H</span></strong>${w.makeupDays?'<small>含补班 '+w.makeupDays+' 天</small>':''}`:`<span class="hours-missing" title="${esc(workloadHint(w))}">${w?.status==='calendar_missing'?'日历待配置':'待排期'}</span>`;}
function progressCell(task){return task.progress===null?'<span class="muted">待填写</span>':`<div class="work-progress" data-progress="${Math.round(task.progress*100)}"><span>${Math.round(task.progress*100)}<small>%</small></span>${track(Math.round(task.progress*100),statusTone(task))}</div>`;}
function renderWorkList(list){
  const m=metrics(list),stages=[...new Set(list.map(t=>t.stage))];
  return `<section class="work-register"><div class="register-heading"><div><h2>项目工作清单</h2><p>以工作项为单位，记录责任、范围、排期与完成情况。</p></div><div class="register-context"><span>项目负责人</span><strong>${esc(state.project.owner||'待指定')}</strong>${state.project.source?`<a href="${esc(safeURL(state.project.source))}" target="_blank" rel="noreferrer">原始项目计划 ↗</a>`:''}</div></div><div class="register-summary"><span><i class="small-dot"></i> 当前 ${list.length} 项工作</span><span>计划工时 <strong>${hoursText(m.hours)} H</strong>${m.unpriced?' · '+m.unpriced+' 项待计算':''}</span><span>进度 <strong>${hoursText(m.percent)}%</strong> · ${progressRule(m)}</span><span class="register-scroll-hint">左右滚动查看完整字段 ↔</span></div><div class="work-table-scroll" tabindex="0" role="region" aria-label="项目工作清单，可左右滚动查看所有字段"><table class="work-table"><colgroup><col class="col-wbs"><col class="col-content"><col class="col-owner"><col class="col-collaborator"><col class="col-status"><col class="col-date"><col class="col-date"><col class="col-days"><col class="col-hours"><col class="col-progress"><col class="col-action"></colgroup><thead><tr><th>WBS 编号</th><th>工作事项 / 工作内容</th><th>负责人</th><th>协作人</th><th>当前状态</th><th>开始日期</th><th>结束日期</th><th>工作日</th><th>计划工时</th><th>进度</th><th>操作</th></tr></thead><tbody>${stages.map((stage,index)=>{const items=list.filter(t=>t.stage===stage),sm=metrics(items);return `<tr class="work-stage"><td colspan="11"><div><span class="stage-index">${String(index+1).padStart(2,'0')}</span><strong>${esc(stage)}</strong><span>${items.length} 项工作</span><span class="stage-hours">${hoursText(sm.hours)} H${sm.unpriced?' · '+sm.unpriced+' 项待计算':''}</span></div></td></tr>`+items.map(t=>`<tr data-work-row="${esc(t.id)}"><td class="wbs-cell">${esc(t.id)}</td><td class="work-content-cell"><strong>${esc(t.title)}</strong><p class="work-description">${esc(t.content||'工作内容待补充')}</p>${t.blocker?`<div class="work-risk">风险：${esc(t.blocker)}</div>`:''}${t.nextAction||t.criteria||t.evidence?`<details class="work-extra"><summary>执行记录 / 交付验收</summary>${t.nextAction?'<p>下一步行动：'+esc(t.nextAction)+'</p>':''}${t.criteria?'<p>验收标准：'+esc(t.criteria)+'</p>':''}${t.evidence?'<p>交付记录：'+esc(t.evidence)+'</p>':''}</details>`:''}</td><td class="work-owner">${t.owner?`<span class="owner-initial">${esc(t.owner.slice(0,1))}</span><strong>${esc(t.owner)}</strong>`:'<span class="hours-missing">待指定</span>'}</td><td class="work-collaborator">${esc(t.collaborator||'—')}</td><td>${statusPills(t)}<small class="priority-note">${esc(t.priority||'待确认')}优先级</small></td><td class="work-date">${esc(t.start||'待排期')}</td><td class="work-date ${overdue(t)?'date-overdue':''}">${esc(t.end||'待排期')}${overdue(t)?'<small>已逾期</small>':''}</td><td class="work-days">${t.workload?.workingDays===null||t.workload?.workingDays===undefined?'—':t.workload.workingDays+' 天'}</td><td>${workloadCell(t)}</td><td>${progressCell(t)}</td><td><button class="work-edit" data-task="${esc(t.id)}">编辑记录 ↗</button></td></tr>`).join('');}).join('')}</tbody></table>${!list.length?'<div class="empty"><h3>暂无符合条件的工作项</h3>调整筛选条件，或新增工作项。</div>':''}</div><div class="register-footnote">每项工作日为该任务的排期时长；并行任务不合并为项目工期或人天。计划工时按每工作日 8H 估算，实际投入需另行登记。</div></section>`;
}
function renderWorkOverview(list){
  const stages=[...new Set(list.map(t=>t.stage))],owners=[...new Set(list.map(t=>t.owner||'待指定负责人'))],m=metrics(list);
  const risks=list.filter(t=>!done(t)&&(overdue(t)||['受阻','已延期'].includes(t.status)||t.blocker)).sort((a,b)=>rank(a)-rank(b)).slice(0,8);
  return `<div class="overview-grid"><section class="panel"><h3>阶段进度与计划工时</h3>${stages.map(stage=>{const items=list.filter(t=>t.stage===stage),sm=metrics(items);return `<div class="work-stage-metric"><div><strong>${esc(stage)}</strong><span>${items.length} 项 · ${hoursText(sm.hours)} H${sm.unpriced?' · '+sm.unpriced+' 项待计算':''}</span><b>${hoursText(sm.percent)}%</b></div>${track(sm.percent)}<small>${progressRule(sm)}</small></div>`;}).join('')||'<div class="empty">添加工作项后自动计算</div>'}</section><section class="panel"><h3>进度与投入概览</h3><div class="effort-number">${hoursText(m.hours)}<span>计划工时 / H</span></div><div class="effort-pair"><span>已完成折算</span><strong>${hoursText(m.equivalent)} H</strong></div><div class="effort-pair"><span>剩余计划投入</span><strong>${hoursText(Math.max(0,m.hours-m.equivalent))} H</strong></div><div class="effort-pair"><span>可计算覆盖</span><strong>${m.ready} / ${m.total} 项</strong></div><p class="effort-note">折算工时 = 计划工时 × 已填进度百分比，用于衡量计划完成量。实际投入需另行报工，不根据日期推断。</p><div class="form-section">状态分布</div>${statuses.filter(s=>list.some(t=>t.status===s)).map(s=>`<div class="stage-row"><span>${statusLabel(s)}</span>${track(list.filter(t=>t.status===s).length/Math.max(1,list.length)*100,ProjectStatus.rawTone(s))}<small>${list.filter(t=>t.status===s).length} 项</small></div>`).join('')}</section><section class="panel wide"><h3>负责人工作分布</h3><div class="table-wrap"><table class="resource-table"><thead><tr><th>负责人</th><th>工作项</th><th>计划工时</th><th>完成折算</th><th>进度</th><th>状态分布</th><th>需关注</th></tr></thead><tbody>${owners.map(owner=>{const items=list.filter(t=>(t.owner||'待指定负责人')===owner),om=metrics(items);return `<tr><td><strong>${esc(owner)}</strong></td><td>${items.length} 项</td><td>${hoursText(om.hours)} H${om.unpriced?'<small>'+om.unpriced+' 项待计算</small>':''}</td><td>${hoursText(om.equivalent)} H</td><td>${hoursText(om.percent)}%<small>${progressRule(om)}</small></td><td>${statusSummary(items)}</td><td>${tag(items.filter(overdue).length+' 项逾期',items.some(overdue)?'red':'gray')}</td></tr>`;}).join('')}</tbody></table></div><p class="effort-note">按工作项登记的负责人归集；多位负责人共同署名时作为一个责任组展示，不自动拆分工时。</p></section><section class="panel wide"><h3>风险与排期关注</h3>${risks.map(t=>`<div class="urgent-item"><span class="task-number">${esc(t.id)}</span><div><button data-task="${esc(t.id)}">${esc(t.title)}</button><p>${esc(t.owner||'待指定负责人')} · ${esc(t.start||'待排期')} — ${esc(t.end||'待排期')} · ${esc(statusLabel(t.status))}</p><p>${esc(t.blocker||t.nextAction||'请更新当前执行情况')}</p></div></div>`).join('')||'<div class="empty">当前没有记录在案的风险或逾期工作项</div>'}</section><section class="panel wide"><h3>项目说明</h3><div class="project-content">${esc(state.project.content||'暂无项目说明')}</div></section></div>`;
}
function renderView(){
  const list=filtered(),content=$('view-content');if(!content)return;
  if(state.view==='risks'&&!state.archived){content.innerHTML=ProjectRisks.render();$('result-count').textContent='风险记录与工作项分别保存 · 删除可恢复';return;}
  $('result-count').textContent=`${state.archived?'回收站 · ':''}显示 ${list.length} / ${state.tasks.filter(t=>t.archived===state.archived).length} 项任务 · 点击查看完整内容`;
  if(state.archived){content.innerHTML=`<div class="table-wrap"><table><thead><tr><th>任务编号</th><th>任务名称</th><th>负责人</th><th>恢复</th></tr></thead><tbody>${list.map(t=>`<tr><td>${esc(t.id)}</td><td><strong>${esc(t.title)}</strong><small>${esc(t.stage)}</small></td><td>${esc(t.owner)}</td><td><button data-restore-task="${esc(t.id)}">恢复任务</button></td></tr>`).join('')}</tbody></table></div>`;return;}
  if(state.view==='board'){
    const lanes=[['未开始',['未开始','待确认']],['进行中',['进行中']],['待验收',['待验收']],['挂起 / 受阻 / 延期',['暂停','受阻','已延期']],['已完成',['已完成']]];
    content.innerHTML='<div class="board">'+lanes.map(([name,group])=>{const tasks=list.filter(t=>group.includes(t.status));return `<section class="lane tone-${ProjectStatus.rawTone(group[0])}"><div class="lane-head"><span class="lane-title"><span class="lane-dot"></span>${name}</span><strong>${tasks.length}</strong></div>${tasks.length?tasks.map(card).join(''):'<div class="empty-lane">这里还没有任务</div>'}<button class="lane-add" data-new-status="${group[0]}">＋ 添加任务</button></section>`;}).join('')+'</div>';
  }else if(state.view==='list'){
    content.innerHTML=renderWorkList(list);
  }else if(state.view==='dashboard'){
    content.innerHTML=ProjectDashboard.render(list,{allTasks:activeTasks(),metrics,done,overdue,near,today,progressRule,filtered:Object.entries(state.filters).some(([key,value])=>key!=='sort'&&value&&value!=='all')});
  }else{
    content.innerHTML=renderWorkOverview(list);
  }
}
function safeURL(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:'#';}catch{return '#';}}
function field(name,label,value,type='text',wide=false){return `<label class="${wide?'wide':''}">${label}${type==='textarea'?`<textarea name="${name}">${esc(value)}</textarea>`:`<input name="${name}" type="${type}" value="${esc(value)}" ${type==='number'?'min="0" max="100" step="1"':''} ${name==='title'||name==='name'||name==='stage'?'required':''} ${name==='id'?'required pattern="[A-Za-z0-9_.-]{1,80}"':''}>`}</label>`;}
function select(name,label,value,values){return `<label>${label}<select name="${name}">${values.map(v=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(name==='status'?statusLabel(v):v||'待填写')}</option>`).join('')}</select></label>`;}
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
  $('task-form').querySelector('[name=end]').closest('label').insertAdjacentHTML('afterend','<section class="effort-preview wide" id="workload-preview" aria-live="polite"></section>');
  $('task-form').oninput=e=>{taskDirty=true;persistTaskDraft();if(['start','end'].includes(e.target.name))previewWorkload();};
  $('task-form').onsubmit=saveTask;
  previewWorkload();
}
function previewWorkload(){
  const form=$('task-form'),sequence=++workloadPreviewSequence;clearTimeout(workloadPreviewTimer);
  const start=form.querySelector('[name=start]').value,end=form.querySelector('[name=end]').value;
  $('workload-preview').innerHTML='<strong>计划工时 · 每工作日 8H</strong><p>'+(start&&end?'正在依据工作日历计算…':'填写开始和结束日期后，自动扣除放假与周末，并计入调休补班。')+'</p>';
  if(!start||!end)return;
  workloadPreviewTimer=setTimeout(async()=>{
    try{const {workload:w}=await post('/api/work-hours',{start,end});if(sequence!==workloadPreviewSequence||form!==$('task-form'))return;
      $('workload-preview').innerHTML=`<div><strong>计划工时 · 每工作日 8H</strong>${w.status==='ready'?`<b>${hoursText(w.hours)}<small> H</small></b>`:'<button type="button" class="link" data-action="calendar">配置工作日历 ↗</button>'}</div><p>${esc(workloadHint(w))}</p>`;
    }catch(err){if(sequence===workloadPreviewSequence&&form===$('task-form'))$('workload-preview').textContent='工时暂时无法计算：'+err.message;}
  },220);
}
async function calendarEditor(){
  const data=await api('/api/calendar');state.calendars=data.years;
  const missing=metrics(activeTasks()).missingYears;
  calendarYear=missing[0]||Number(today().slice(0,4));
  if(!state.calendars[calendarYear]&&!missing.length)calendarYear=Number(Object.keys(state.calendars).sort().at(-1));
  $('calendar-editor').innerHTML=`<div class="dialog-head"><div><small>WORK CALENDAR · CN</small><h2 id="calendar-title">工作日历与工时规则</h2></div><button type="button" class="dialog-close" data-close="calendar-editor" aria-label="关闭工作日历">×</button></div><div class="dialog-body"><div class="calendar-rule-card"><strong>每天 8H · 开始与结束日期均计入</strong><p>有效工作日 = 周一至周五 − 放假工作日 + 周末补班日。任务工时自动计算；未配置的年份不会给出估算值。</p></div><div class="calendar-year-picker"><label>年度日历<select id="calendar-year"></select></label><label>新增年份<input id="calendar-new-year" type="number" min="1900" max="2200" value="${Math.max(...Object.keys(state.calendars).map(Number))+1}"></label><button type="button" id="calendar-add-year">添加年份</button></div><form id="calendar-form"><div id="calendar-fields"></div><p id="calendar-error" class="error" role="alert"></p><p id="calendar-draft-state" class="save-state"></p><div class="calendar-save-row"><button type="button" id="calendar-reload">放弃草稿，重新读取</button><button type="submit" class="primary" id="calendar-save">保存工作日历</button></div></form></div>`;
  function years(){const values=[...new Set([...Object.keys(state.calendars).map(Number),calendarYear])].sort((a,b)=>a-b);$('calendar-year').innerHTML=values.map(y=>`<option value="${y}" ${y===calendarYear?'selected':''}>${y} 年${state.calendars[y]?.custom?' · 自定义':state.calendars[y]?' · 官方内置':' · 未配置'}</option>`).join('');}
  function fields(){
    years();const saved=state.calendars[calendarYear],draft=draftGet('work-calendar:'+calendarYear);
    calendarVersion=draft?.version??saved?.version??0;calendarDirty=!!draft;
    const value=draft?.value||{sourceTitle:saved?.sourceTitle||'',sourceUrl:saved?.sourceUrl||'',holidayText:saved?.holidays.map(h=>h.start+(h.end!==h.start?'~'+h.end:'')+' | '+h.name).join('\n')||'',makeupText:saved?.workdays.join('\n')||''};
    $('calendar-fields').innerHTML=`${saved?.sourceUrl?`<a class="calendar-source" href="${esc(safeURL(saved.sourceUrl))}" target="_blank" rel="noreferrer">查看已保存日历的通知原文 ↗</a>`:''}<div class="field-grid">${field('sourceTitle','日历依据 / 通知名称',value.sourceTitle,'text',true)}${field('sourceUrl','通知链接（可选）',value.sourceUrl,'url',true)}${field('holidayText','放假安排（每行：开始日期~结束日期 | 节日名称）',value.holidayText,'textarea',true)}${field('makeupText','调休补班日期（每行一个日期）',value.makeupText,'textarea',true)}</div><p class="calendar-editor-note">示例：${calendarYear}-01-01~${calendarYear}-01-03 | 元旦。请根据该年度正式通知完整填写，修改只应用于当前账号的项目；保存会保留日历修改版本。</p>`;
    $('calendar-error').textContent='';$('calendar-draft-state').textContent=draft?'已恢复未提交的日历草稿。':saved?'已加载 '+calendarYear+' 年日历。':'该年度尚未配置；补齐全年安排后才能计算对应工时。';
  }
  $('calendar-year').onchange=e=>{calendarYear=Number(e.target.value);fields();};
  $('calendar-add-year').onclick=()=>{const year=Number($('calendar-new-year').value);if(!Number.isInteger(year)||year<1900||year>2200){toast('请填写 1900 至 2200 之间的年份');return;}calendarYear=year;fields();};
  $('calendar-reload').onclick=()=>{draftRemove('work-calendar:'+calendarYear);calendarDirty=false;fields();};
  $('calendar-form').oninput=()=>{calendarDirty=true;draftSet('work-calendar:'+calendarYear,{value:Object.fromEntries(new FormData($('calendar-form'))),version:calendarVersion});$('calendar-draft-state').textContent='日历草稿已在本机保留，保存后更新项目工时。';};
  $('calendar-form').onsubmit=async e=>{
    e.preventDefault();const button=$('calendar-save');button.disabled=true;$('calendar-error').textContent='';
    try{await api('/api/calendar/'+calendarYear,{method:'PUT',body:JSON.stringify({...Object.fromEntries(new FormData(e.target)),version:calendarVersion})});draftRemove('work-calendar:'+calendarYear);calendarDirty=false;$('calendar-editor').close();
      if($('editor').open)previewWorkload();
      if(state.project)await openProject(state.project.id,true);await loadProjects();toast('工作日历已保存，项目工时已重新计算。');
    }catch(err){$('calendar-error').textContent=err.message;}finally{button.disabled=false;}
  };fields();$('calendar-editor').showModal();
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
async function taskHistory(){
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
async function exportDatabase(){
  const button=$('download-database-backup');button.disabled=true;button.textContent='正在生成完整备份…';
  try{
    const response=await fetch('/api/admin/database-backup',{headers:{'X-Requested-With':'ProjectBoard'},cache:'no-store'});
    if(!response.ok){const data=await response.json();if(response.status===401)showLogin();throw Error(data.error||'备份失败，请稍后重试');}
    download(await response.arrayBuffer(),'项目工作台-完整备份-'+today()+'.sqlite3','application/vnd.sqlite3');toast('完整备份已下载，请保存在私人存储中，不要上传公开仓库。');
  }catch(err){toast(err.message);}finally{button.disabled=false;button.textContent='下载完整备份';}
}
async function exportProject(){try{const data=await api(projectPath('/export'));download(JSON.stringify(data,null,2),state.project.name+'-备份-'+today()+'.json','application/json');toast('已导出全部项目任务与风险清单，包含回收站记录。');}catch(err){toast(err.message);}}
async function exportCSV(){
  try{const data=await api(projectPath('/export'));const columns=[['id','任务编号'],['stage','阶段'],['title','任务名称'],['content','项目内容'],['owner','负责人'],['collaborator','协作人'],['status','状态'],['progress','完成率'],['start','计划开始'],['end','计划结束'],['workingDays','有效工作日'],['plannedHours','计划工时H'],['hoursRule','工时计算依据'],['nextAction','下一步待办'],['followup','跟进日'],['blocker','问题风险'],['decision','待决策'],['criteria','验收要点'],['evidence','交付记录'],['actualEnd','实际完成日'],['acceptance','验收结论'],['archived','在回收站']];
    const quote=v=>{let s=String(v??'');if(/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
    const csv=[columns.map(c=>quote(c[1])).join(','),...data.tasks.map(t=>columns.map(([k])=>quote(k==='progress'?(t[k]===null?'':Math.round(t[k]*100)+'%'):k==='workingDays'?t.workload.workingDays:k==='plannedHours'?t.workload.hours:k==='hoursRule'?workloadHint(t.workload):t[k])).join(','))].join('\r\n');download('\ufeff'+csv,state.project.name+'-工作清单-'+today()+'.csv','text/csv;charset=utf-8');
  }catch(err){toast(err.message);}
}
async function importFile(e){
  const file=e.target.files[0];if(!file)return;
  try{
    if(file.size>4000000)throw Error('文件大于 4MB，请分批导入');
    const text=await file.text();let data;
    if(file.name.toLowerCase().endsWith('.html')){const doc=new DOMParser().parseFromString(text,'text/html');const seed=doc.querySelector('#seed-data');if(!seed)throw Error('HTML 中没有可识别的项目记录');data=JSON.parse(seed.textContent);}else data=JSON.parse(text);
    if(!Array.isArray(data.tasks)||(!data.tasks.length&&!data.risks?.length))throw Error('文件没有有效任务或风险记录');
    if(data.project?.id&&data.project.id!==state.project.id)throw Error('备份来自其他项目，请切换至原项目后导入，避免覆盖同编号任务');
    if(!data.project?.id&&state.project.id!=='haikang'&&data.source?.includes('DUEFTVVpqZ0RKRUJH'))throw Error('这是海康项目的旧版记录，请切换至海康项目后导入');
    if(!confirm(`将 ${data.tasks.length} 项工作及 ${data.risks?.length||0} 项风险合并至「${state.project.name}」？同编号记录将更新，文件中没有的记录保留。导入前会自动备份。`))return;
    await post(projectPath('/import'),{tasks:data.tasks,risks:data.risks||[],versions:Object.fromEntries(state.tasks.map(t=>[t.id,t.version])),riskVersions:Object.fromEntries(state.risks.map(r=>[r.id,r.version]))});await openProject(state.project.id,true);await loadProjects();toast('记录已导入，并保留导入前的历史版本。');
  }catch(err){toast('导入失败：'+err.message);}finally{e.target.value='';}
}
async function action(name){
  switch(name){
    case 'import-worklist':return WorkImporter.open();
    case 'calendar':return calendarEditor();
    case 'reset-dashboard-filters':state.filters=defaultFilters();return renderProject();
    case 'dashboard-list':state.view='list';return renderProject();
    case 'create-project':return projectEditor();case 'edit-project':return projectEditor('edit');case 'generate':return projectEditor('generate');case 'new-task':return openTask();
    case 'reload-home':await loadProjects();return home(state.page==='trash');
    case 'refresh-project':return openProject(state.project.id,true);
    case 'toggle-archive':state.archived=!state.archived;return renderProject();
    case 'export':return exportProject();case 'csv':return state.view==='risks'?ProjectRisks.exportCSV():exportCSV();case 'import':return $('import-file').click();
    case 'backup':await post(projectPath('/backup'));toast('数据库完整备份已生成并通过完整性检查。');return openProject(state.project.id,true);
    case 'delete-project':return archiveProject(state.project.id);
    case 'history':return taskHistory();case 'archive-task':return archiveTask(editTask.id);
    case 'discard-draft':if(!confirm('放弃这份未提交的草稿？'))return;draftRemove(editTask.key);taskDirty=false;$('editor').close();return openTask(editTask.isNew?undefined:editTask.id);
    case 'discard-project-draft':if(!confirm('放弃这份项目草稿？'))return;draftRemove(projectDraftKey());projectDirty=false;$('project-editor').close();return projectEditor(projectMode);
  }
}
document.addEventListener('click',async e=>{
  const chart=e.target.closest('[data-dashboard-filter],[data-dashboard-task]');
  if(chart){
    if(chart.dataset.dashboardTask)return openTask(chart.dataset.dashboardTask);
    const key=chart.dataset.dashboardFilter;if(!['owner','stage','status'].includes(key))return;
    const value=chart.dataset.value||'';state.filters[key]=value;
    if(key==='owner'){if(!value)state.filters.focus='unassigned';else if(state.filters.focus==='unassigned')state.filters.focus='all';}
    renderProject();$('view-content').scrollIntoView({block:'start',behavior:'smooth'});return;
  }
  const b=e.target.closest('button');if(!b)return;
  try{
    if(b.dataset.dashboardProject)return await openProject(b.dataset.dashboardProject,false,'dashboard');
    if(b.dataset.dashboardScroll)return $('view-content').querySelector('.dash-timeline')?.scrollBy({left:Number(b.dataset.dashboardScroll)*550,behavior:'smooth'});
    if(b.dataset.authMode)return authMode(b.dataset.authMode);
    if(b.dataset.togglePassword){const input=$(b.dataset.togglePassword),show=input.type==='password';input.type=show?'text':'password';b.textContent=show?'隐藏':'显示';b.setAttribute('aria-label',show?'隐藏密码':'显示密码');return;}
    if(b.dataset.project)return await openProject(b.dataset.project);
    if(b.dataset.task)return openTask(b.dataset.task);
    if(b.dataset.view){state.view=b.dataset.view;state.archived=false;return renderProject();}
    if(b.dataset.newStatus)return openTask(undefined,b.dataset.newStatus);
    if(b.dataset.action)return await action(b.dataset.action);
    if(b.dataset.restoreProject)return await archiveProject(b.dataset.restoreProject);
    if(b.dataset.restoreTask)return await archiveTask(b.dataset.restoreTask);
    if(b.dataset.historyRestore)return await restoreVersion(Number(b.dataset.historyRestore));
    if(b.dataset.close){$(b.dataset.close).close();if(b.dataset.close==='editor')taskDirty=false;else if(b.dataset.close==='project-editor')projectDirty=false;else if(b.dataset.close==='calendar-editor')calendarDirty=false;else if(b.dataset.close==='account-editor')$('account-editor').innerHTML='';}
  }catch(err){toast(err.message);}
});
for(const id of ['editor','project-editor'])$(id).addEventListener('cancel',()=>{if(id==='editor')taskDirty=false;else projectDirty=false;});
$('account-editor').addEventListener('close',()=>{$('account-editor').querySelectorAll('input').forEach(input=>input.value='');});
$('calendar-editor').addEventListener('cancel',()=>calendarDirty=false);
window.addEventListener('beforeunload',e=>{if(taskDirty||projectDirty||calendarDirty||recoveryPending||window.WorkImporter?.dirty||window.ProjectRisks?.dirty){e.preventDefault();e.returnValue='';}});
window.addEventListener('offline',()=>{$('connection').textContent='连接中断 · 请保留草稿';toast('网络已断开。填写会保留本机草稿，恢复连接后请重新保存到数据库。');});
window.addEventListener('online',()=>{$('connection').innerHTML='<i class="small-dot"></i> 已连接';toast('网络已恢复，请重新保存尚未提交的填写。');});
boot();

document.addEventListener('keydown',e=>{if(!['Enter',' '].includes(e.key))return;const target=e.target.closest('svg [role=button]');if(target){e.preventDefault();target.dispatchEvent(new MouseEvent('click',{bubbles:true}));}});
