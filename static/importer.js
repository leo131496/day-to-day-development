'use strict';
window.WorkImporter=(()=>{
  let preview=null,rows=[],projectId='',page=0,busy=false,sequence=0,dirty=false;
  const size=30,dialog=()=>$('import-editor'),key=()=>`import:${projectId}`;
  const path=suffix=>'/api/projects/'+projectId+suffix;
  function stash(){if(!preview)return;dirty=true;draftSet(key(),{batchId:preview.batchId,rows,mode:$('import-mode').value});}
  function clearAuth(){dialog().querySelectorAll('[data-import-auth]').forEach(input=>input.value='');}
  function layout(){
    dialog().innerHTML=`<div class="import-shell"><div class="import-header"><div><div class="eyebrow">BRING YOUR PLAN INTO FOCUS</div><h2 id="import-title">导入项目工作清单</h2><p>读取计划，核对每一项工作，再保存到「${esc(state.project.name)}」。</p></div><button type="button" data-close="import-editor" aria-label="关闭导入">×</button></div>
    <div class="import-body"><div class="import-steps"><span class="active">01 选择来源</span><span>02 核对工作项</span><span>03 保存到项目</span></div>
    <div class="import-tabs" role="tablist" aria-label="导入来源"><button type="button" role="tab" aria-selected="true" data-import-tab="file">↑ 本地文件</button><button type="button" role="tab" aria-selected="false" data-import-tab="link">↗ 文档链接</button></div>
    <section id="import-file-panel" role="tabpanel"><label class="import-upload">选择本地项目计划文件<input type="file" id="import-source-file" accept=".xlsx,.csv,.tsv,.json,.docx,.txt,.md,.markdown,.html,.htm"><small>XLSX / CSV / TSV / JSON / DOCX / TXT / Markdown / HTML · 最大 2MB</small></label><p class="import-note">表格请包含任务名称或工作内容，以及负责人、状态、日期等表头。Excel 的所有非空工作表均会核对。暂不支持旧版 XLS / DOC、PDF 和图片。</p><button type="button" class="link" id="import-template">↓ 下载 CSV 模板</button></section>
    <section id="import-link-panel" role="tabpanel" hidden><label>腾讯文档 / 腾讯云 COS、飞书或钉钉链接<input type="url" id="import-url" placeholder="https://docs.qq.com/sheet/…" autocomplete="off"></label><p class="import-note">可读取公开下载文件和包含完整表格的分享页。动态分享页、内部文档可能需要下方授权；平台限制读取时，可从原平台导出文件后导入。</p>
    <details id="import-authorization"><summary>内部文档 / 平台授权信息（仅本次读取使用）</summary><div class="import-auth-grid"><label>平台<select id="import-provider"><option value="feishu">飞书</option><option value="tencent">腾讯文档</option><option value="dingtalk">钉钉</option></select></label><label>访问令牌 Access Token<input type="password" data-import-auth="token" autocomplete="off" maxlength="4096"></label><label data-provider="tencent" hidden>Client-Id<input type="password" data-import-auth="clientId" autocomplete="off"></label><label data-provider="tencent" hidden>Open-Id<input type="password" data-import-auth="openId" autocomplete="off"></label><label data-provider="dingtalk" hidden>操作人 operatorId<input type="password" data-import-auth="operatorId" autocomplete="off"></label><label data-provider="dingtalk" hidden>工作簿 workbookId<input type="password" data-import-auth="documentId" autocomplete="off"></label></div><p class="import-note">需要由有文档读取权限的账号 / 应用提供有效令牌。飞书支持电子表格、文档和知识库；腾讯文档使用开放平台导出；钉钉支持电子表格，普通文档请导出 DOCX。令牌不会存入数据库或浏览器草稿，读取后会清空。</p></details></section>
    <div class="import-read-row"><button type="button" class="primary" id="import-read">读取并预览</button><span id="import-read-status" role="status">预览后可修改、勾选需要保存的工作项</span></div>
    <p id="import-error" class="error" role="alert"></p><section id="import-preview" hidden></section></div>
    <div class="import-footer"><p id="import-save-note">读取预览不会修改项目工作清单。</p><div><button type="button" data-close="import-editor">稍后继续</button><button type="button" class="primary" id="import-save" disabled>保存到项目</button></div></div></div>`;
    dialog().querySelectorAll('[data-import-tab]').forEach(button=>button.onclick=()=>{
      dialog().querySelectorAll('[data-import-tab]').forEach(b=>b.setAttribute('aria-selected',String(b===button)));
      $('import-file-panel').hidden=button.dataset.importTab!=='file';$('import-link-panel').hidden=button.dataset.importTab!=='link';
    });
    $('import-provider').onchange=()=>dialog().querySelectorAll('[data-provider]').forEach(label=>label.hidden=label.dataset.provider!==$('import-provider').value);
    $('import-url').oninput=()=>{const url=$('import-url').value;if(/docs\.qq\.com/.test(url))$('import-provider').value='tencent';else if(/dingtalk\.com|alidocs\.com/.test(url))$('import-provider').value='dingtalk';else $('import-provider').value='feishu';$('import-provider').onchange();};
    $('import-template').onclick=()=>{const blob=new Blob(['\ufeff编号,阶段,任务名称,工作内容,负责人,协作人,状态,开始日期,结束日期,进度,优先级,验收标准\r\nDEMO-001,需求阶段,确认需求范围,组织需求评审并形成确认记录,张三,李四,未开始,2026-11-02,2026-11-06,0%,中,需求说明书签字确认\r\n'],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='项目工作清单导入模板.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
    $('import-read').onclick=read;$('import-save').onclick=save;
  }
  function setBusy(value,message=''){
    busy=value;$('import-read').disabled=value;$('import-save').disabled=value||!preview;
    $('import-read-status').textContent=message||'预览后可修改、勾选需要保存的工作项';
    dialog().querySelectorAll('[data-close="import-editor"]').forEach(button=>button.disabled=value);
    dialog().querySelectorAll('#import-preview input,#import-preview select,#import-preview button').forEach(el=>{
      if(value){el.dataset.beforeBusy=String(el.disabled);el.disabled=true;}
      else if(el.dataset.beforeBusy!==undefined){el.disabled=el.dataset.beforeBusy==='true';delete el.dataset.beforeBusy;}
    });
    if(!value&&preview)summary();
  }
  async function open(){
    sequence++;projectId=state.project.id;preview=null;rows=[];page=0;dirty=false;busy=false;layout();dialog().showModal();
    const stored=draftGet(key()),seq=sequence;
    if(stored?.batchId){
      setBusy(true,'正在恢复上次的导入预览…');
      try{const data=await api(path('/import-batches/'+stored.batchId));if(seq!==sequence)return;
        if(data.result){draftRemove(key());toast('上一批工作项已保存，无需重复导入。');}
        else{preview=data;rows=stored.rows?.length===data.rows.length?stored.rows:data.rows.map(row=>({...row,selected:true}));render(stored.mode||'append');$('import-preview').scrollIntoView({block:'start'});$('import-read-status').textContent='已恢复未完成的导入预览，请核对后保存。';dirty=true;}
      }catch(err){if(seq===sequence)$('import-error').textContent=err.message;}
      finally{if(seq===sequence)setBusy(false);}
    }
  }
  async function fileBody(file){
    if(!file)throw Error('请先选择一个本地文件');
    if(file.size>2000000)throw Error('文件超过 2MB，请拆分后导入');
    const buffer=new Uint8Array(await file.arrayBuffer());let binary='';
    for(let i=0;i<buffer.length;i+=16384)binary+=String.fromCharCode(...buffer.subarray(i,i+16384));
    return {kind:'file',name:file.name,content:btoa(binary)};
  }
  async function read(){
    if(busy)return;
    if(dirty&&!confirm('读取新来源将替换当前导入预览，继续吗？'))return;
    $('import-error').textContent='';const seq=sequence;
    try{
      setBusy(true,'正在读取内容，请稍候…');
      let body;
      if(!$('import-file-panel').hidden)body=await fileBody($('import-source-file').files[0]);
      else{const auth={};dialog().querySelectorAll('[data-import-auth]').forEach(input=>auth[input.dataset.importAuth]=input.value.trim());body={kind:'link',url:$('import-url').value.trim(),auth};}
      const data=await post(path('/import-preview'),body);if(seq!==sequence)return;
      preview=data;rows=data.rows.map(row=>({...row,selected:true}));page=0;render('append');stash();$('import-preview').scrollIntoView({block:'start'});
    }catch(err){if(seq===sequence)$('import-error').textContent='读取失败：'+err.message;}
    finally{if(seq===sequence){clearAuth();setBusy(false);}}
  }
  const columns=[['id','工作编号',110],['stage','项目阶段',120],['title','任务名称',190],['content','工作内容',240],['owner','负责人',110],['collaborator','协作人',110],['status','当前状态',110],['start','开始日期',130],['end','结束日期',130],['progress','进度 %',90],['priority','优先级',90]];
  function problems(row){
    const t=row.task,errors=[];
    if(!/^[A-Za-z0-9_.-]{1,80}$/.test(t.id||''))errors.push('请修正工作编号');
    if(!t.title?.trim()||!t.stage?.trim())errors.push('名称和阶段必填');
    if(!statuses.includes(t.status))errors.push('请选择有效状态');
    if(!['','待确认','高','中','低'].includes(t.priority))errors.push('请选择优先级');
    if(t.progress!==null&&(typeof t.progress!=='number'||!Number.isFinite(t.progress)||t.progress<0||t.progress>1))errors.push('进度应为 0–100%');
    if(t.status==='已完成'&&t.progress!==1)errors.push('已完成任务需为 100%');
    for(const field of ['start','end','actualEnd'])if(t[field]&&(!/^\d{4}-\d{2}-\d{2}$/.test(t[field])||Number.isNaN(Date.parse(t[field]+'T00:00:00Z'))||new Date(t[field]+'T00:00:00Z').toISOString().slice(0,10)!==t[field]))errors.push('日期请用 YYYY-MM-DD');
    if(t.start&&t.end&&t.end<t.start)errors.push('结束日期早于开始日期');
    return [...new Set(errors)];
  }
  function summary(){
    const selected=rows.filter(r=>r.selected),bad=selected.filter(r=>problems(r).length).length,ids=selected.map(r=>r.task.id),duplicates=new Set(ids).size!==ids.length;
    $('import-count').textContent=`共 ${rows.length} 项 · 已选 ${selected.length} 项${bad?' · '+bad+' 项待修正':''}${duplicates?' · 编号重复':''}`;
    $('import-save').disabled=busy||!selected.length||bad>0||duplicates;
    $('import-save').textContent=`保存 ${selected.length} 项到项目`;
    $('import-save-note').textContent='保存前自动备份 · 整批写入数据库 · 保存后自动更新看板';
  }
  function input(row,index,field,label){
    const value=row.task[field]??'';
    if(['status','priority'].includes(field)){
      const choices=field==='status'?statuses:['待确认','高','中','低'];
      return `<select data-import-row="${index}" data-field="${field}" aria-label="第 ${index+1} 项 ${label}">${!choices.includes(value)?`<option value="${esc(value)}">${esc(value||'请选择')}</option>`:''}${choices.map(v=>`<option ${v===value?'selected':''}>${esc(v)}</option>`).join('')}</select>`;
    }
    const shown=field==='progress'&&typeof value==='number'?Math.round(value*10000)/100:value;
    return `<input data-import-row="${index}" data-field="${field}" aria-label="第 ${index+1} 项 ${label}" value="${esc(shown)}" ${field==='progress'?'inputmode="decimal"':''} ${['start','end'].includes(field)?'placeholder="YYYY-MM-DD"':''}>`;
  }
  function render(mode){
    const section=$('import-preview');section.hidden=false;
    section.innerHTML=`<div class="import-preview-heading"><div><h3>核对工作项 <small id="import-count"></small></h3><p>${esc(preview.source)}${preview.sheets.length?' · '+esc(preview.sheets.join(' / ')):''}</p></div><label>保存方式<select id="import-mode"><option value="append">新增工作项（默认）</option><option value="merge">更新相同编号，其余新增</option></select></label></div><p class="import-note">可直接修改下列表格。新增会为重复编号分配新编号；更新按工作编号匹配，保留原记录中未提供或为空的字段。最多导入 2000 项，工时按工作日历重新计算。</p><div class="import-table-scroll" tabindex="0" aria-label="导入预览表，可横向滚动"><table class="import-table"><thead><tr><th><input type="checkbox" id="import-select-all" aria-label="选择全部工作项" ${rows.every(r=>r.selected)?'checked':''}></th>${columns.map(([field,label])=>`<th class="import-col-${field}">${label}</th>`).join('')}<th>来源 / 核对提示</th></tr></thead><tbody>${rows.slice(page*size,(page+1)*size).map((row,j)=>{const index=page*size+j;return `<tr><td><input type="checkbox" data-import-select="${index}" aria-label="选择第 ${index+1} 项" ${row.selected?'checked':''}></td>${columns.map(([field,label])=>`<td>${input(row,index,field,label)}</td>`).join('')}<td class="import-row-notes" data-import-notes="${index}"></td></tr>`;}).join('')}</tbody></table></div><div class="import-pagination"><span>第 ${page+1} / ${Math.ceil(rows.length/size)} 页 · 每页 ${size} 项</span><div><button type="button" id="import-prev" ${page===0?'disabled':''}>上一页</button><button type="button" id="import-next" ${(page+1)*size>=rows.length?'disabled':''}>下一页</button></div></div>`;
    $('import-mode').value=mode;
    $('import-mode').onchange=()=>{const value=$('import-mode').value;rows.forEach(row=>row.task.id=value==='merge'?(row.originalId||row.appendId):row.appendId);render(value);stash();};
    $('import-select-all').onchange=e=>{rows.forEach(row=>row.selected=e.target.checked);render($('import-mode').value);stash();};
    section.querySelectorAll('[data-import-select]').forEach(el=>el.onchange=()=>{rows[Number(el.dataset.importSelect)].selected=el.checked;summary();stash();});
    section.querySelectorAll('[data-import-row]').forEach(el=>el.oninput=()=>{
      const index=Number(el.dataset.importRow),field=el.dataset.field;
      rows[index].task[field]=field==='progress'?(el.value.trim()===''?null:Number.isFinite(Number(el.value))?Number(el.value)/100:el.value):el.value;
      notes(index);summary();stash();
    });
    $('import-prev').onclick=()=>{page--;render($('import-mode').value);};$('import-next').onclick=()=>{page++;render($('import-mode').value);};
    for(let index=page*size;index<Math.min((page+1)*size,rows.length);index++)notes(index);
    summary();
  }
  function notes(index){const row=rows[index],errors=problems(row),node=dialog().querySelector(`[data-import-notes="${index}"]`);if(!node)return;node.innerHTML=`<span>${esc(row.location)}</span>${errors.map(s=>`<strong>${esc(s)}</strong>`).join('')}${row.warnings.map(s=>`<small>${esc(s)}</small>`).join('')}`;node.closest('tr').classList.toggle('import-invalid',errors.length>0);}
  async function save(){
    if(busy||!preview)return;
    const selected=rows.map((row,index)=>({row,index})).filter(v=>v.row.selected),mode=$('import-mode').value;
    if(!selected.length||selected.some(v=>problems(v.row).length))return;
    if(mode==='merge'&&!confirm('按相同工作编号更新已有记录，空白字段保留原值。导入前会自动备份，确定保存？'))return;
    $('import-error').textContent='';const seq=sequence,id=projectId;
    try{
      stash();setBusy(true,'正在备份并保存，请稍候…');
      const result=await post(path('/import-batches/'+preview.batchId+'/save'),{mode,rows:selected.map(({row,index})=>({index,task:row.task}))});
      if(seq!==sequence)return;
      draftRemove(key());dirty=false;busy=false;dialog().close();
      if(state.project?.id===id){state.filters=defaultFilters();state.archived=false;state.view='list';await openProject(id,true,'list');await loadProjects();}
      toast(`已保存到数据库：新增 ${result.added} 项，更新 ${result.updated} 项；看板已同步。`);
    }catch(err){if(seq===sequence){$('import-error').textContent='保存失败：'+err.message+'。预览草稿已保留，可修正后重试。';setBusy(false);summary();}}
  }
  dialog().addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  dialog().addEventListener('close',()=>{clearAuth();sequence++;preview=null;rows=[];busy=false;dirty=false;dialog().innerHTML='';});
  return {open,get dirty(){return dirty;}};
})();
