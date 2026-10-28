'use strict';

window.ProjectStatus = (() => {
  const colors = {red:'#d92d20',green:'#079455',gray:'#667085',amber:'#d99a00',blue:'#1570ef'};
  const label = status => status === '暂停' ? '挂起' : status;
  const rawTone = status => status === '已完成' ? 'blue' : status === '进行中' ? 'green' : status === '已延期' ? 'red' : ['暂停','挂起','受阻','待验收'].includes(status) ? 'amber' : 'gray';
  const tone = (task, overdue) => overdue(task) ? 'red' : rawTone(task.status);
  const color = (task, overdue) => colors[tone(task, overdue)];
  return Object.freeze({colors,label,rawTone,tone,color});
})();

// Charts derive from saved tasks. No separate dashboard records or external services are needed.
window.ProjectDashboard = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const palette = ['#386cf4','#16b8ad','#e5af24','#e47f41','#a77bdc','#31a2d2','#677bd6','#74b58a','#d47eac','#7295a8','#9e6fc9','#5f9fda','#cc9b51','#4f9f9a','#a47d62','#6174a4','#a3b858','#c96f87','#7b9eaf','#87a9d1','#b98bb4','#83ada0'];
  const statusColors = Object.fromEntries(['待确认','未开始','进行中','待验收','受阻','已延期','暂停','已完成'].map(status=>[status,ProjectStatus.colors[ProjectStatus.rawTone(status)]]));
  const fmt = value => Number(value || 0).toLocaleString('zh-CN', {maximumFractionDigits:1});
  const truncate = (value, length = 15) => Array.from(value).length > length ? Array.from(value).slice(0,length).join('')+'…' : value;
  const dateNumber = value => Date.parse(value+'T00:00:00Z')/86400000;
  const dateLabel = value => new Date(value*86400000).toISOString().slice(0,10).replaceAll('-','/');
  const filterAttrs = (key, value) => `data-dashboard-filter="${key}" data-value="${esc(value)}"`;
  const empty = text => `<div class="dash-empty">${esc(text)}</div>`;
  const dot = color => `<svg class="dash-dot" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="${color}"/></svg>`;
  const heading = (title, hint, extra = '') => `<div class="dash-card-heading"><div><h3>${title}</h3><p>${hint}</p></div>${extra}</div>`;

  function timeline(tasks, h) {
    const dated = tasks.filter(t=>t.end).sort((a,b)=>a.end.localeCompare(b.end)||a.id.localeCompare(b.id,undefined,{numeric:true}));
    return `<section class="dash-card dash-timeline-card">${heading('项目交付时间线','按计划结束日期排序 · 点击工作项查看详情',`<div class="dash-timeline-controls"><span>${dated.length} 项已排期 · ${tasks.length-dated.length} 项待补结束日期</span><button data-dashboard-scroll="-1" aria-label="向前滚动时间线">←</button><button data-dashboard-scroll="1" aria-label="向后滚动时间线">→</button></div>`)}
      ${dated.length?`<div class="dash-timeline" tabindex="0" role="region" aria-label="项目交付时间线，可左右滚动">${dated.map(t=>{
        const tone=ProjectStatus.tone(t,h.overdue);
        return `<button class="dash-milestone tone-${tone}" data-task="${esc(t.id)}" title="${esc(t.title+' · '+t.owner+' · '+ProjectStatus.label(t.status)+' · '+t.end)}"><span class="dash-milestone-title">${esc(t.title)}</span><span class="dash-milestone-node"></span><strong>${h.overdue(t)?'逾期 · ':''}${esc(ProjectStatus.label(t.status))}</strong><time datetime="${esc(t.end)}">${esc(t.end)}</time><small>${esc(t.owner||'待指定负责人')}</small></button>`;
      }).join('')}</div>`:empty('补充工作项结束日期后，自动生成交付时间线。')}
    </section>`;
  }

  function statusChart(tasks, h) {
    const groups=Object.keys(statusColors).map(name=>({name,count:tasks.filter(t=>t.status===name).length})).filter(g=>g.count);
    let left=0;
    const bars=groups.map(g=>{
      const width=g.count/tasks.length*100;
      const html=`<g ${filterAttrs('status',g.name)} tabindex="0" role="button" aria-label="查看${ProjectStatus.label(g.name)} ${g.count}项"><title>${ProjectStatus.label(g.name)}：${g.count} 项（${fmt(width)}%）</title><rect x="${left}" y="0" width="${width}" height="22" fill="${statusColors[g.name]}"/></g>`;
      left+=width;return html;
    }).join('');
    const complete=tasks.filter(h.done).length;
    return `<section class="dash-card dash-status-card">${heading('任务状态分布','点击状态查看对应工作项')}<div class="dash-status-summary"><strong>${fmt(complete/Math.max(tasks.length,1)*100)}<small>%</small></strong><span>已完成任务占比</span></div>
      ${groups.length?`<svg class="dash-status-chart" viewBox="0 0 100 22" preserveAspectRatio="none" aria-label="任务状态分布">${bars}</svg><div class="dash-status-legend">${groups.map(g=>`<button ${filterAttrs('status',g.name)}>${dot(statusColors[g.name])}<span>${ProjectStatus.label(g.name)}</span><strong>${g.count}</strong></button>`).join('')}</div>`:empty('添加工作项后生成状态分布')}
    </section>`;
  }

  function stageChart(tasks, stages, stageColor) {
    const groups=stages.map(stage=>({stage,count:tasks.filter(t=>t.stage===stage).length})).filter(g=>g.count);
    const radius=74,circumference=2*Math.PI*radius;
    let offset=0;
    const arcs=groups.map(g=>{
      const size=g.count/Math.max(tasks.length,1)*circumference;
      const result=`<g ${filterAttrs('stage',g.stage)} tabindex="0" role="button" aria-label="查看阶段${esc(g.stage)}，${g.count}项"><title>${esc(g.stage)}：${g.count} 项（${fmt(g.count/tasks.length*100)}%）</title><circle cx="112" cy="112" r="${radius}" fill="none" stroke="${stageColor(g.stage)}" stroke-width="28" stroke-dasharray="${Math.max(0,size-(groups.length>1?2:0))} ${circumference}" stroke-dashoffset="${-offset}" transform="rotate(-90 112 112)"/></g>`;
      offset+=size;return result;
    }).join('');
    return `<section class="dash-card dash-stage-card">${heading('项目阶段任务分布','按工作项数量统计 · 点击阶段筛选')}<div class="dash-donut-layout"><svg class="dash-donut" viewBox="0 0 224 224" aria-label="项目阶段任务分布环形图"><circle cx="112" cy="112" r="74" fill="none" stroke="#f0f3f8" stroke-width="28"/>${arcs}<text x="112" y="109" text-anchor="middle" class="dash-donut-number">${tasks.length}</text><text x="112" y="133" text-anchor="middle" class="dash-donut-caption">工作项</text></svg><div class="dash-stage-legend">${groups.map(g=>`<button ${filterAttrs('stage',g.stage)}>${dot(stageColor(g.stage))}<span>${esc(g.stage)}</span><strong>${g.count}<small>${fmt(g.count/tasks.length*100)}%</small></strong></button>`).join('')||'<p>暂无阶段数据</p>'}</div></div></section>`;
  }

  function ownerChart(tasks, stages, stageColor) {
    const owners=[...new Set(tasks.map(t=>t.owner||''))].map(owner=>({owner,tasks:tasks.filter(t=>(t.owner||'')===owner)})).sort((a,b)=>b.tasks.length-a.tasks.length||a.owner.localeCompare(b.owner,'zh-CN'));
    const peak=Math.max(1,...owners.map(g=>g.tasks.length)),step=Math.max(1,Math.ceil(peak/5)),ceiling=Math.ceil(peak/step)*step;
    const width=Math.max(580,owners.length*125+60),plotHeight=195,bottom=222,column=50;
    const grid=Array.from({length:Math.round(ceiling/step)+1},(_,i)=>{const n=i*step,y=bottom-n/ceiling*plotHeight;return `<line x1="38" x2="${width-14}" y1="${y}" y2="${y}" stroke="#edf0f6"/><text x="28" y="${y+4}" text-anchor="end" class="dash-axis">${n}</text>`;}).join('');
    const columns=owners.map((g,i)=>{
      const x=62+i*((width-80)/Math.max(owners.length,1));let current=bottom;
      const blocks=stages.map(stage=>{
        const count=g.tasks.filter(t=>t.stage===stage).length;if(!count)return '';
        const height=count/ceiling*plotHeight;current-=height;
        return `<rect x="${x}" y="${current}" width="${column}" height="${height}" fill="${stageColor(stage)}"/>${height>=17?`<text x="${x+column/2}" y="${current+height/2+4}" text-anchor="middle" class="dash-bar-count">${count}</text>`:''}`;
      }).join('');
      return `<g ${filterAttrs('owner',g.owner)} tabindex="0" role="button" aria-label="查看负责人${esc(g.owner||'待指定负责人')}，${g.tasks.length}项"><title>${esc(g.owner||'待指定负责人')}：${g.tasks.length} 项\n${esc(stages.map(stage=>stage+'：'+g.tasks.filter(t=>t.stage===stage).length).join('\n'))}</title>${blocks}<text x="${x+column/2}" y="${current-9}" text-anchor="middle" class="dash-column-total">${g.tasks.length}</text><text x="${x+column/2}" y="244" text-anchor="middle" class="dash-axis">${esc(truncate(g.owner||'待指定',8))}</text></g>`;
    }).join('');
    return `<section class="dash-card dash-owner-card">${heading('任务负责人分布','柱高为工作项数量 · 色块代表项目阶段')}<div class="dash-chart-legend">${stages.filter(stage=>tasks.some(t=>t.stage===stage)).map(stage=>`<button ${filterAttrs('stage',stage)}>${dot(stageColor(stage))}${esc(stage)}</button>`).join('')}</div>${owners.length?`<div class="dash-owner-scroll" tabindex="0" role="region" aria-label="负责人任务分布，可左右滚动"><svg class="dash-owner-chart" width="${width}" height="263" viewBox="0 0 ${width} 263" aria-label="负责人任务数堆叠柱状图">${grid}${columns}</svg></div><div class="dash-owner-buttons">${owners.map(g=>`<button ${filterAttrs('owner',g.owner)}>${esc(g.owner||'待指定负责人')} <strong>${g.tasks.length}</strong></button>`).join('')}</div>`:empty('添加负责人后生成工作分布')}
    </section>`;
  }

  function gantt(tasks, h) {
    const dated=tasks.filter(t=>t.start&&t.end).sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id,undefined,{numeric:true}));
    if(!dated.length)return `<section class="dash-card dash-gantt-card">${heading('项目排期与执行进度','条形为计划日期范围，深色部分为已填写的完成进度；条形颜色对应任务状态')}${empty('补充开始日期与结束日期后，自动生成排期甘特图。')}</section>`;
    const first=Math.min(...dated.map(t=>dateNumber(t.start))),last=Math.max(...dated.map(t=>dateNumber(t.end))),span=Math.max(1,last-first+1);
    const axisWidth=690,labelWidth=254,totalWidth=labelWidth+axisWidth+55,rowHeight=43,height=48+dated.length*rowHeight;
    const scale=n=>labelWidth+(n-first)/span*axisWidth;
    const ticks=Array.from(new Set(Array.from({length:7},(_,i)=>Math.min(last,first+Math.round((span-1)*i/6)))));
    const now=dateNumber(h.today());
    const grid=ticks.map(n=>`<line x1="${scale(n)}" x2="${scale(n)}" y1="33" y2="${height}" stroke="#edf0f6"/><text x="${scale(n)}" y="20" text-anchor="middle" class="dash-axis">${dateLabel(n)}</text>`).join('');
    const rows=dated.map((t,i)=>{
      const y=47+i*rowHeight,x=scale(dateNumber(t.start)),width=Math.max(3,(dateNumber(t.end)-dateNumber(t.start)+1)/span*axisWidth),color=ProjectStatus.color(t,h.overdue);
      return `<g data-dashboard-task="${esc(t.id)}" data-gantt-row="${esc(t.id)}" tabindex="0" role="button" aria-label="查看${esc(t.title)}，${esc(t.owner||'负责人待指定')}，${esc(t.start)}至${esc(t.end)}，进度${t.progress==null?'待填写':fmt(t.progress*100)+'%'}"><title>${esc(t.title)}\n负责人：${esc(t.owner||'待指定')}\n排期：${esc(t.start)} 至 ${esc(t.end)}\n${esc(t.status)} · 进度 ${t.progress==null?'待填写':fmt(t.progress*100)+'%'}\n计划工时：${t.workload?.hours==null?'待计算':fmt(t.workload.hours)+'H'}</title><line x1="0" x2="${totalWidth}" y1="${y+28}" y2="${y+28}" stroke="#f1f3f7"/><text x="3" y="${y+2}" class="dash-gantt-title">${esc(truncate(t.title,17))}</text><text x="3" y="${y+19}" class="dash-gantt-owner">${esc(truncate(t.owner||'待指定负责人',22))}</text><rect x="${x}" y="${y-6}" width="${width}" height="17" rx="4" fill="${color}" fill-opacity=".18"/><rect x="${x}" y="${y-6}" width="${width*(t.progress||0)}" height="17" rx="4" fill="${color}"/><text x="${labelWidth+axisWidth+15}" y="${y+6}" class="dash-gantt-percent">${t.progress==null?'—':fmt(t.progress*100)+'%'}</text></g>`;
    }).join('');
    const todayLine=now>=first&&now<=last?`<line x1="${scale(now)}" x2="${scale(now)}" y1="32" y2="${height}" stroke="#ed8064" stroke-dasharray="4 4"/><text x="${scale(now)}" y="31" text-anchor="middle" fill="#cf6958" font-size="10">今天</text>`:'';
    return `<section class="dash-card dash-gantt-card">${heading('项目排期与执行进度','条形为计划日期范围，深色部分为已填写的完成进度；条形颜色对应任务状态',`<span class="dash-caption">${dated.length} 项已排期 · ${tasks.length-dated.length} 项日期待补全</span>`)}<div class="dash-gantt-scroll" tabindex="0" role="region" aria-label="项目排期甘特图，可上下左右滚动"><svg class="dash-gantt" width="${totalWidth}" height="${height}" viewBox="0 0 ${totalWidth} ${height}" aria-label="工作项排期与进度甘特图"><text x="3" y="20" class="dash-axis">工作事项 / 负责人</text>${grid}${rows}${todayLine}</svg></div><p class="dash-chart-note">日期轴包含自然日；计划工时仍按工作日历扣除放假、计入补班，并按每日 8H 计算。点击条形可编辑工作项。</p></section>`;
  }

  function execution(tasks, h) {
    const owners=[...new Set(tasks.map(t=>t.owner||''))].map(owner=>({owner,tasks:tasks.filter(t=>(t.owner||'')===owner)})).sort((a,b)=>b.tasks.length-a.tasks.length);
    return `<section class="dash-card dash-execution-card">${heading('负责人执行看板','按登记的负责人或责任组归集')}<div class="dash-execution-list">${owners.map(g=>{
      const m=h.metrics(g.tasks),late=g.tasks.filter(h.overdue).length;
      return `<button class="dash-execution-row" ${filterAttrs('owner',g.owner)}><span class="dash-person-icon">${esc((g.owner||'?').slice(0,1))}</span><span class="dash-person-info"><strong>${esc(g.owner||'待指定负责人')}</strong><small>${g.tasks.length} 项工作 · ${fmt(m.hours)}H${m.unpriced?' · '+m.unpriced+' 项工时待补':''}${late?' · '+late+' 项逾期':''}</small><svg viewBox="0 0 100 4" preserveAspectRatio="none" class="dash-person-progress" aria-label="进度${fmt(m.percent)}%"><rect width="100" height="4" fill="#eff2f8" rx="2"/><rect width="${m.percent}" height="4" fill="#386cf4" rx="2"/></svg></span><span class="dash-person-percent">${fmt(m.percent)}<small>%</small></span></button>`;
    }).join('')||empty('暂无负责人工作记录')}</div><p class="dash-chart-note">多人共同署名作为一个责任组，不重复计数；各责任组进度使用其工作项的工时与进度口径计算。</p></section>`;
  }

  function attention(tasks, h) {
    const risks=tasks.filter(t=>!h.done(t)&&(h.overdue(t)||['受阻','已延期'].includes(t.status)||t.blocker)).sort((a,b)=>(Number(h.overdue(b))-Number(h.overdue(a)))||(a.end||'9999').localeCompare(b.end||'9999'));
    return `<section class="dash-card dash-attention-card">${heading('交付风险与待补信息','优先跟进逾期、受阻和已登记风险')}<div class="dash-quality"><span><strong>${tasks.filter(t=>!t.owner).length}</strong> 项负责人待定</span><span><strong>${tasks.filter(t=>!t.start||!t.end).length}</strong> 项排期待补</span><span><strong>${tasks.filter(t=>t.progress==null).length}</strong> 项进度待填</span></div><div class="dash-risk-list">${risks.slice(0,10).map(t=>`<button data-task="${esc(t.id)}"><span class="dash-risk-mark">!</span><span><strong>${esc(t.title)}</strong><small>${esc(t.owner||'待指定负责人')} · ${esc(t.end||'待排期')} · ${h.overdue(t)?'已逾期':esc(ProjectStatus.label(t.status))}</small>${t.blocker?`<p>${esc(t.blocker)}</p>`:''}</span><span class="dash-risk-arrow">↗</span></button>`).join('')||empty('当前没有登记的逾期或受阻事项')}<p class="dash-chart-note">${risks.length>10?'共 '+risks.length+' 项关注事项，当前展示前 10 项。':''}缺少负责人或排期的记录仍计入任务总数。</p></div></section>`;
  }

  function render(tasks, h) {
    const m=h.metrics(tasks),allStages=[...new Set(h.allTasks.map(t=>t.stage))],stages=allStages.filter(stage=>tasks.some(t=>t.stage===stage));
    const stageColor=stage=>{const index=Math.max(0,allStages.indexOf(stage));return palette[index]||`hsl(${Math.round(index*137.508)%360},58%,55%)`;};
    const complete=tasks.filter(h.done).length,late=tasks.filter(h.overdue).length;
    return `<div class="project-dashboard" data-dashboard-total="${tasks.length}"><div class="dash-heading"><div><span class="dash-live-dot"></span><h2>项目可视化看板</h2><span class="dash-auto-badge">自动汇总</span><p>当前 ${tasks.length} / ${h.allTasks.length} 项工作 · 与已保存工作清单同步</p></div><div class="dash-actions">${h.filtered?'<button data-action="reset-dashboard-filters">清除筛选</button>':''}<button data-action="dashboard-list">工作清单 ↗</button></div></div>
      ${timeline(tasks,h)}<div class="dash-kpi-grid"><section class="dash-card dash-kpi-card blue"><div class="dash-kpi-label">任务总数 <span>WORK ITEMS</span></div><div class="dash-big-number" data-dashboard-kpi="total">${tasks.length}<small>项</small></div><div class="dash-kpi-foot"><span>覆盖 ${stages.length} 个项目阶段</span><button data-action="dashboard-list">查看工作清单 ↗</button></div></section><section class="dash-card dash-kpi-card blue"><div class="dash-kpi-label">已完成任务 <span>COMPLETED</span></div><div class="dash-big-number" data-dashboard-kpi="completed">${complete}<small>项</small></div><div class="dash-kpi-foot"><span>还有 ${tasks.length-complete} 项待推进</span><button ${filterAttrs('status','已完成')}>查看完成记录 ↗</button></div></section>${statusChart(tasks,h)}</div>
      <div class="dash-secondary-metrics"><div><span>整体完成进度</span><strong>${fmt(m.percent)}<small>%</small></strong><p>${h.progressRule(m)}</p></div><div><span>计划投入工时</span><strong>${fmt(m.hours)}<small>H</small></strong><p>${m.ready}/${m.total} 项可计算 · 每工作日 8H</p></div><div><span>已完成折算</span><strong>${fmt(m.equivalent)}<small>H</small></strong><p>计划工时 × 已填完成进度</p></div><div><span>逾期工作项</span><strong class="${late?'dash-late-number':''}">${late}<small>项</small></strong><p>${tasks.filter(h.near).length} 项 7 天内到期</p></div></div>
      ${tasks.length?'':`<div class="dash-no-results">${h.allTasks.length?'没有符合当前筛选条件的工作项，请调整或清除筛选。':'录入项目工作项后，时间线和各项图表将在这里自动生成。'}</div>`}<div class="dash-chart-grid">${stageChart(tasks,stages,stageColor)}${ownerChart(tasks,stages,stageColor)}${gantt(tasks,h)}${execution(tasks,h)}${attention(tasks,h)}</div><div class="dash-footer-note">统计范围：当前筛选内的有效工作项，回收站记录不参与统计。图表点击后可联动筛选；计划投入与完成折算用于项目管理，不代表实际报工。</div></div>`;
  }
  return {render};
})();
