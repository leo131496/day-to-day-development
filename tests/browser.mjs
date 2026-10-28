// Run with the installed Playwright runtime (see README). No browser dependency ships with the app.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url);
const {chromium}=require('playwright');
const root=path.resolve(import.meta.dirname,'..'),data=await mkdtemp(path.join(tmpdir(),'project-board-browser-'));
const base='http://127.0.0.1:8766',password='browser-test-password-2026';
await mkdir(path.join(root,'test-results'),{recursive:true});
let service,browser,logs='';
async function start(){
  service=spawn('python3',['-B','server.py','--port','8766','--data-dir',data],{cwd:root,env:{...process.env,BOARD_PASSWORD:password},stdio:['ignore','pipe','pipe']});
  service.stdout.on('data',v=>logs+=v);service.stderr.on('data',v=>logs+=v);
  for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}
  throw Error('Server did not start: '+logs);
}
async function stop(){if(!service||service.exitCode!==null)return;service.kill('SIGTERM');await new Promise(r=>service.once('exit',r));}
try{
  await start();browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1512,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('#username').fill('admin');await page.locator('#password').fill(password);await page.locator('#login-form button[type=submit]').click();
  await page.getByRole('heading',{name:'每个计划，都向前一步。'}).waitFor();
  await page.screenshot({path:path.join(root,'test-results/home.png'),fullPage:true});
  await page.locator('.project-card [data-project="haikang"]').click();await page.locator('[data-work-row]').first().waitFor();
  assert.equal(await page.locator('[data-work-row]').count(),50);
  assert.match(await page.locator('.viewtab.active').textContent(),/项目工作清单/);
  for(const text of ['负责人','当前状态','开始日期','结束日期','工作日','计划工时','进度'])assert.ok((await page.locator('.work-table thead').textContent()).includes(text));
  await page.screenshot({path:path.join(root,'test-results/worklist-seed.png'),fullPage:true});
  // Every visualization must reflect saved records, and browsing charts cannot mutate them.
  const seedTasks=await page.evaluate(async()=>(await (await fetch('/api/projects/haikang')).json()).tasks);
  await page.locator('[data-view="dashboard"]').click();
  assert.equal(await page.locator('[data-dashboard-kpi="total"]').textContent(),'50项');
  assert.equal(await page.locator('[data-dashboard-kpi="completed"]').textContent(),seedTasks.filter(t=>t.status==='已完成'&&t.progress===1).length+'项');
  assert.equal(await page.locator('.dash-milestone').count(),seedTasks.filter(t=>t.end).length);
  assert.equal(await page.locator('[data-gantt-row]').count(),seedTasks.filter(t=>t.start&&t.end).length);
  await page.screenshot({path:path.join(root,'test-results/dashboard-seed.png'),fullPage:true});
  assert.ok(await page.locator('.dash-gantt').textContent().then(text=>/2026\/\d{2}\/\d{2}/.test(text)),'Date axes must include years for cross-year schedules');
  const firstStage=await page.locator('.dash-stage-legend button').first().getAttribute('data-value');
  await page.locator('.dash-stage-legend button').first().click();
  assert.equal(await page.locator('[data-dashboard-total]').getAttribute('data-dashboard-total'),String(seedTasks.filter(t=>t.stage===firstStage).length));
  assert.equal(await page.locator('#filter-stage').inputValue(),firstStage);
  await page.locator('.dash-actions [data-action="dashboard-list"]').click();assert.equal(await page.locator('[data-work-row]').count(),seedTasks.filter(t=>t.stage===firstStage).length);
  await page.locator('[data-view="dashboard"]').click();
  await page.locator('[data-action="reset-dashboard-filters"]').click();
  await page.locator('.dash-status-chart [data-value="已完成"]').focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('#filter-status').inputValue(),'已完成');
  assert.equal(await page.locator('[data-dashboard-total]').getAttribute('data-dashboard-total'),String(seedTasks.filter(t=>t.status==='已完成').length));
  await page.locator('[data-action="reset-dashboard-filters"]').click();await page.reload();
  await page.locator('.project-dashboard').waitFor();assert.match(await page.locator('.viewtab.active').textContent(),/可视化看板/);
  const seedAfter=await page.evaluate(async()=>(await (await fetch('/api/projects/haikang')).json()).tasks);
  assert.deepEqual(seedAfter,seedTasks);
  await page.locator('[data-view="board"]').click();await page.locator('.task-card').first().waitFor();
  assert.equal(await page.locator('.task-card').count(),50);
  await page.screenshot({path:path.join(root,'test-results/board.png'),fullPage:true});
  await page.locator('[data-task="6.7"]').click();await page.locator('textarea[name="content"]').waitFor();
  assert.match(await page.locator('textarea[name="content"]').inputValue(),/销售/);
  await page.screenshot({path:path.join(root,'test-results/detail.png'),fullPage:true});
  await page.locator('[data-close="editor"]').click();
  await page.locator('#home').click();await page.locator('[data-action="create-project"]').first().click();
  await page.locator('#project-form [name="name"]').fill('官网升级 · 集成验证');
  await page.locator('#project-form [name="description"]').fill('从需求访谈到网站交付，清晰管理每一步。');
  await page.locator('#project-content').fill('需求阶段：\n1. 用户访谈，负责人：张三，截止：2026-11-05\n2. 输出需求文档，负责人：李四，截止：2026-11-08，交付物：确认版需求说明书\n交付阶段：\n3. 联调测试，截止：2026-11-20');
  await page.locator('#generate-preview').click();await page.locator('.generated-task').first().waitFor();assert.equal(await page.locator('.generated-task').count(),3);
  await page.screenshot({path:path.join(root,'test-results/generate.png'),fullPage:true});
  await page.locator('#save-project').click();await page.getByRole('heading',{name:'官网升级 · 集成验证',exact:true}).waitFor();
  const projectId=await page.evaluate(()=>location.hash.slice(1));
  assert.equal(await page.locator('[data-work-row]').count(),3);
  await page.locator('[data-view="dashboard"]').click();assert.equal(await page.locator('[data-dashboard-total]').getAttribute('data-dashboard-total'),'3');
  await page.locator('.dash-owner-buttons [data-value=""]').click();assert.equal(await page.locator('[data-dashboard-total]').getAttribute('data-dashboard-total'),'1');assert.equal(await page.locator('#filter-focus').inputValue(),'unassigned');
  await page.locator('[data-action="reset-dashboard-filters"]').click();await page.locator('[data-view="board"]').click();
  assert.equal(await page.locator('.task-card').count(),3);
  await page.locator('[data-task="T-001"]').click();
  await page.locator('[name="nextAction"]').fill('已完成访谈并整理纪要');await page.locator('[name="status"]').selectOption('进行中');await page.locator('[name="progress"]').fill('45');
  await page.locator('#save-task').click();await page.locator('#editor').waitFor({state:'hidden'});
  // A real process restart must retain the login session, new project, and saved edits.
  await stop();await start();await page.reload();await page.locator('[data-work-row]').first().waitFor();await page.locator('[data-view="board"]').click();await page.locator('[data-task="T-001"]').waitFor();await page.locator('[data-task="T-001"]').click();
  assert.equal(await page.locator('[name="nextAction"]').inputValue(),'已完成访谈并整理纪要');assert.equal(await page.locator('[name="progress"]').inputValue(),'45');
  // Closing and refreshing before save must preserve the local draft.
  await page.locator('[name="blocker"]').fill('草稿：等待客户确认');await page.locator('[data-close="editor"]').click();await page.reload();await page.locator('[data-work-row]').first().waitFor();await page.locator('[data-view="board"]').click();await page.locator('[data-task="T-001"]').click();
  assert.equal(await page.locator('[name="blocker"]').inputValue(),'草稿：等待客户确认');assert.match(await page.locator('.draft-notice').textContent(),/恢复/);
  await page.locator('#save-task').click();await page.locator('#editor').waitFor({state:'hidden'});
  // Parallel editors: the stale editor must receive a conflict and keep its input.
  const second=await context.newPage();await second.goto(base+'/#'+projectId);await second.locator('[data-task="T-002"]').click();
  await page.locator('[data-task="T-002"]').click();await page.locator('[name="nextAction"]').fill('第一页更新');await page.locator('#save-task').click();await page.locator('#editor').waitFor({state:'hidden'});
  await second.locator('[name="nextAction"]').fill('第二页保留草稿');await second.locator('#save-task').click();await second.locator('#merge-current').waitFor();
  assert.equal(await second.locator('[name="nextAction"]').inputValue(),'第二页保留草稿');await second.locator('#merge-current').click();await second.locator('#save-task').click();await second.locator('#editor').waitFor({state:'hidden'});await second.close();
  await page.locator('[data-action="refresh-project"]').click();await page.locator('[data-task="T-002"]').click();await page.locator('[data-action="history"]').click();await page.locator('.history-item').first().waitFor();assert.equal(await page.locator('.history-item').count(),3);
  await page.locator('[data-close="editor"]').click();
  // Create, search, delete and restore a task through the UI.
  await page.locator('[data-action="new-task"]').click();await page.locator('[name="id"]').fill('CUSTOM-UI');await page.locator('[name="title"]').fill('验收会议');await page.locator('#save-task').click();await page.locator('#editor').waitFor({state:'hidden'});
  await page.locator('#search').fill('验收会议');assert.equal(await page.locator('.task-card').count(),1);await page.locator('.task-card').click();
  page.once('dialog',dialog=>dialog.accept());await page.locator('[data-action="archive-task"]').click();await page.locator('#editor').waitFor({state:'hidden'});await page.locator('#search').fill('');await page.locator('[data-action="toggle-archive"]').click();
  await page.locator('[data-restore-task="CUSTOM-UI"]').click();await page.locator('[data-action="toggle-archive"]').click();await page.locator('[data-task="CUSTOM-UI"]').waitFor();
  await page.locator('[data-view="overview"]').click();await page.screenshot({path:path.join(root,'test-results/overview.png'),fullPage:true});
  await page.locator('[data-view="list"]').click();await page.screenshot({path:path.join(root,'test-results/worklist.png'),fullPage:true});
  // Legal holidays are excluded, weekend makeup days included; hours persist through the API.
  await page.locator('[data-action="new-task"]').click();await page.locator('[name="id"]').fill('HOURS-UI');await page.locator('[name="title"]').fill('工时计算核对');await page.locator('[name="owner"]').fill('张三');
  await page.locator('[name="content"]').fill('核对国庆期间放假与补班安排，形成项目交付记录。');await page.locator('[name="start"]').fill('2026-10-01');await page.locator('[name="end"]').fill('2026-10-10');await page.locator('[name="status"]').selectOption('进行中');await page.locator('[name="progress"]').fill('50');
  await page.locator('#workload-preview b').filter({hasText:'24'}).waitFor();assert.match(await page.locator('#workload-preview').textContent(),/补班 1 天/);await page.locator('#save-task').click();await page.locator('#editor').waitFor({state:'hidden'});
  assert.match(await page.locator('[data-work-row="HOURS-UI"]').textContent(),/24 H/);assert.equal(await page.locator('[data-work-row="HOURS-UI"] [data-progress]').getAttribute('data-progress'),'50');
  await page.locator('#filter-status').selectOption('进行中');assert.equal(await page.locator('[data-work-row="HOURS-UI"]').count(),1);await page.locator('#filter-status').selectOption('');
  // A missing calendar never produces invented hours; saving a custom year recalculates the open draft.
  await page.locator('[data-action="new-task"]').click();await page.locator('[name="id"]').fill('HOURS-CROSS');await page.locator('[name="title"]').fill('跨年排期核对');await page.locator('[name="start"]').fill('2026-12-31');await page.locator('[name="end"]').fill('2027-01-04');
  await page.locator('#workload-preview').filter({hasText:'2027'}).waitFor();await page.locator('#workload-preview [data-action="calendar"]').click();
  await page.locator('#calendar-new-year').fill('2027');await page.locator('#calendar-add-year').click();await page.locator('#calendar-form [name="sourceTitle"]').fill('集成测试专用日历（非官方通知）');await page.locator('#calendar-form [name="holidayText"]').fill('2027-01-01~2027-01-03 | 测试休息');
  await page.screenshot({path:path.join(root,'test-results/calendar.png'),fullPage:true});await page.locator('#calendar-save').click();await page.locator('#calendar-editor').waitFor({state:'hidden'});await page.locator('#workload-preview b').filter({hasText:'16'}).waitFor();await page.locator('#save-task').click();await page.locator('#editor').waitFor({state:'hidden'});
  assert.match(await page.locator('[data-work-row="HOURS-CROSS"]').textContent(),/16 H/);
  await page.screenshot({path:path.join(root,'test-results/worklist-hours.png'),fullPage:true});
  // Editing from a chart updates summaries; removal and recovery immediately recalculate counts.
  await page.locator('[data-view="dashboard"]').click();
  await page.locator('[data-gantt-row="HOURS-UI"]').focus();await page.keyboard.press('Enter');
  await page.locator('[name="status"]').selectOption('已完成');await page.locator('[name="progress"]').fill('100');await page.locator('#save-task').click();await page.locator('#editor').waitFor({state:'hidden'});
  assert.equal(await page.locator('[data-dashboard-kpi="completed"]').textContent(),'1项');
  assert.match(await page.locator('.dash-milestone[data-task="HOURS-UI"]').textContent(),/已完成/);
  await page.locator('.dash-milestone[data-task="HOURS-UI"]').click();page.once('dialog',dialog=>dialog.accept());await page.locator('[data-action="archive-task"]').click();await page.locator('#editor').waitFor({state:'hidden'});
  assert.equal(await page.locator('[data-dashboard-kpi="total"]').textContent(),'5项');assert.equal(await page.locator('[data-dashboard-kpi="completed"]').textContent(),'0项');
  await page.locator('[data-action="toggle-archive"]').click();await page.locator('[data-restore-task="HOURS-UI"]').click();await page.locator('[data-action="toggle-archive"]').click();
  assert.equal(await page.locator('[data-dashboard-kpi="total"]').textContent(),'6项');assert.equal(await page.locator('[data-dashboard-kpi="completed"]').textContent(),'1项');
  await page.locator('#search').fill('不存在的工作项');assert.equal(await page.locator('[data-dashboard-total]').getAttribute('data-dashboard-total'),'0');assert.ok(await page.locator('.dash-no-results').isVisible());
  await page.locator('[data-action="reset-dashboard-filters"]').click();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'test-results/dashboard-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile dashboard must not overflow');
  await page.setViewportSize({width:1512,height:1000});await page.locator('[data-view="list"]').click();
  const csvPromise=page.waitForEvent('download');await page.locator('[data-action="csv"]').click();const csvFile=path.join(data,'worklist.csv');await (await csvPromise).saveAs(csvFile);const csvText=await readFile(csvFile,'utf8');assert.ok(csvText.includes('计划工时H')&&csvText.includes('有效工作日')&&csvText.includes('工时计算核对'));
  const downloadPromise=page.waitForEvent('download');await page.locator('[data-action="export"]').click();const download=await downloadPromise;await download.saveAs(path.join(root,'test-results/export.json'));
  // Import previews never change tasks; editable drafts survive close/reload and save retries are idempotent.
  await page.locator('[data-action="import-worklist"]').click();
  const importCSV='编号,阶段,任务名称,工作内容,负责人,状态,开始日期,结束日期,进度\nT-001,导入阶段,导入验收,核对本地计划,王五,进行中,2026-10-01,2026-10-10,50%\nIMP-002,导入阶段,导入复核,复核交付结果,李四,未开始,2026-11-02,2026-11-03,0%\nIMP-BAD,导入阶段,日期待修正,等待补齐,张三,未开始,错误日期,,0%';
  await page.locator('#import-source-file').setInputFiles({name:'项目计划.csv',mimeType:'text/csv',buffer:Buffer.from(importCSV)});
  await page.locator('#import-read').click();await page.locator('#import-count').filter({hasText:'共 3 项'}).waitFor();
  assert.equal(await page.locator('#import-save').isDisabled(),true);
  assert.equal(await page.locator('[data-work-row]').count(),6);
  await page.locator('[data-import-select="2"]').uncheck();
  await page.locator('[data-import-row="0"][data-field="owner"]').fill('导入负责人');
  assert.notEqual(await page.locator('[data-import-row="0"][data-field="id"]').inputValue(),'T-001');
  await page.screenshot({path:path.join(root,'test-results/import-preview.png'),fullPage:true});
  await page.locator('[data-close="import-editor"]').first().click();await page.reload();await page.locator('[data-work-row]').first().waitFor();
  await page.locator('[data-action="import-worklist"]').click();await page.locator('#import-count').filter({hasText:'已选 2 项'}).waitFor();
  assert.equal(await page.locator('[data-import-row="0"][data-field="owner"]').inputValue(),'导入负责人');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'test-results/import-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.setViewportSize({width:1512,height:1000});
  await page.locator('[data-import-tab="link"]').click();await page.locator('#import-url').fill('https://127.0.0.1/private');await page.locator('#import-authorization').click();await page.locator('[data-import-auth="token"]').fill('ephemeral-test-token');
  page.once('dialog',dialog=>dialog.accept());await page.locator('#import-read').click();await page.locator('#import-error').filter({hasText:'HTTPS'}).waitFor();
  assert.equal(await page.locator('[data-import-auth="token"]').inputValue(),'');
  let dropped=false;
  await page.route('**/import-batches/*/save',async route=>{if(!dropped){dropped=true;await route.fetch();await route.abort('failed');}else await route.continue();});
  await page.locator('#import-save').click();await page.locator('#import-error').filter({hasText:'保存失败'}).waitFor();assert.ok(await page.locator('#import-editor').isVisible());
  await page.locator('#import-save').click();await page.locator('#import-editor').waitFor({state:'hidden'});await page.unroute('**/import-batches/*/save');
  assert.equal(await page.locator('[data-work-row]').count(),8);assert.match(await page.locator('.viewtab.active').textContent(),/项目工作清单/);
  const imported=page.locator('[data-work-row]').filter({hasText:'导入验收'});assert.match(await imported.textContent(),/导入负责人/);assert.match(await imported.textContent(),/24 H/);
  await page.locator('[data-view="dashboard"]').click();assert.equal(await page.locator('[data-dashboard-kpi="total"]').textContent(),'8项');await page.locator('[data-view="list"]').click();
  // Network failure cannot clear draft or close the editor.
  await page.locator('[data-task="T-001"]').click();await page.locator('[name="decision"]').fill('断网时填写的决策');await context.setOffline(true);await page.locator('#save-task').click();await page.locator('#task-error').filter({hasText:/fetch|网络|Failed/}).waitFor();assert.equal(await page.locator('[name="decision"]').inputValue(),'断网时填写的决策');await context.setOffline(false);await page.locator('#save-task').click();await page.locator('#editor').waitFor({state:'hidden'});
  await page.setViewportSize({width:390,height:844});await page.locator('[data-view="list"]').click();await page.screenshot({path:path.join(root,'test-results/worklist-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile page must not overflow');
  await page.locator('[data-action="edit-project"]').click();await page.locator('[name="name"]').fill('官网升级 · 已修改');await page.locator('#save-project').click();await page.getByRole('heading',{name:'官网升级 · 已修改',exact:true}).waitFor();
  page.once('dialog',dialog=>dialog.accept());await page.locator('[data-action="delete-project"]').click();await page.getByRole('heading',{name:'每个计划，都向前一步。'}).waitFor();
  await page.locator('#mobile-menu').click();await page.locator('#trash').click();await page.locator(`[data-restore-project="${projectId}"]`).click();await page.getByRole('heading',{name:'官网升级 · 已修改',exact:true}).waitFor();
  // Account lifecycle, including UI validation, recovery-code download and session revocation.
  await page.setViewportSize({width:1512,height:1000});await page.locator('#logout').click();await page.locator('#login-form').waitFor({state:'visible'});
  await page.screenshot({path:path.join(root,'test-results/login.png'),fullPage:true});
  await page.locator('#auth-tabs [data-auth-mode="register"]').click();
  await page.locator('#register-name').fill('林小序');await page.locator('#register-username').fill('browser.member');
  const memberPassword='member-password-2026',changedPassword='member-changed-password-2026',resetPassword='member-reset-password-2026';
  await page.locator('#register-password').fill(memberPassword);await page.locator('#register-confirm').fill('mismatch-password');await page.locator('#register-form button[type=submit]').click();
  await page.locator('#register-error').filter({hasText:'不一致'}).waitFor();
  await page.locator('#register-confirm').fill(memberPassword);await page.screenshot({path:path.join(root,'test-results/register.png'),fullPage:true});
  await page.locator('#register-form button[type=submit]').click();await page.locator('#recovery-receipt').waitFor({state:'visible'});
  const recoveryCode=await page.locator('#recovery-code').textContent();assert.match(recoveryCode,/^RC-/);assert.equal(await page.locator('#recovery-continue').isDisabled(),true);
  const recoveryDownload=page.waitForEvent('download');await page.locator('#download-recovery').click();const recoveryFile=path.join(data,'recovery.txt');await (await recoveryDownload).saveAs(recoveryFile);assert.ok((await readFile(recoveryFile,'utf8')).includes(recoveryCode));
  await page.locator('#recovery-saved').check();await page.locator('#recovery-continue').click();assert.equal(await page.locator('#username').inputValue(),'browser.member');assert.equal(await page.locator('#recovery-code').textContent(),'');
  await page.locator('#password').fill(memberPassword);await page.locator('#login-form button[type=submit]').click();await page.getByRole('heading',{name:'每个计划，都向前一步。'}).waitFor();assert.equal(await page.locator('.project-card').count(),0);
  // A second device has an independent session.
  const otherContext=await browser.newContext(),device=await otherContext.newPage();await device.goto(base);await device.locator('#username').fill('browser.member');await device.locator('#password').fill(memberPassword);await device.locator('#login-form button[type=submit]').click();await device.getByRole('heading',{name:'每个计划，都向前一步。'}).waitFor();
  await page.locator('[data-action="create-project"]').first().click();await page.locator('#project-form [name="name"]').fill('密码修改后保留的项目');await page.locator('#save-project').click();await page.getByRole('heading',{name:'密码修改后保留的项目',exact:true}).waitFor();
  await page.locator('[data-view="dashboard"]').click();assert.equal(await page.locator('[data-dashboard-kpi="total"]').textContent(),'0项');assert.ok(await page.locator('.dash-no-results').isVisible());await page.screenshot({path:path.join(root,'test-results/dashboard-empty.png'),fullPage:true});
  await page.locator('#account-button').click();await page.locator('#current-password').fill('wrong-password-2026');await page.locator('#new-password').fill(changedPassword);await page.locator('#confirm-new-password').fill(changedPassword);await page.locator('#change-password').click();await page.locator('#password-error').filter({hasText:'当前密码不正确'}).waitFor();
  await page.locator('#current-password').fill(memberPassword);await page.screenshot({path:path.join(root,'test-results/change-password.png'),fullPage:true});await page.locator('#change-password').click();await page.locator('#account-editor').waitFor({state:'hidden'});
  await device.reload();await device.locator('#login-form').waitFor({state:'visible'});await otherContext.close();
  await page.locator('#logout').click();await page.locator('#password').fill(memberPassword);await page.locator('#login-form button[type=submit]').click();await page.locator('#login-error').filter({hasText:'账号或密码不正确'}).waitFor();
  await page.locator('#password').fill(changedPassword);await page.locator('#login-form button[type=submit]').click();await page.getByRole('heading',{name:'密码修改后保留的项目',exact:true}).waitFor();await page.locator('#logout').click();
  await page.locator('#login-form [data-auth-mode="reset"]').click();await page.locator('#reset-username').fill('browser.member');await page.locator('#reset-code').fill(recoveryCode);await page.locator('#reset-password').fill(resetPassword);await page.locator('#reset-confirm').fill(resetPassword);
  await page.screenshot({path:path.join(root,'test-results/reset-password.png'),fullPage:true});
  await page.locator('#reset-form button[type=submit]').click();await page.locator('#recovery-title').filter({hasText:'密码已重置'}).waitFor();assert.notEqual(await page.locator('#recovery-code').textContent(),recoveryCode);
  await page.locator('#recovery-saved').check();await page.locator('#recovery-continue').click();await page.locator('#password').fill(resetPassword);await page.locator('#login-form button[type=submit]').click();await page.getByRole('heading',{name:'密码修改后保留的项目',exact:true}).waitFor();
  await stop();await start();await page.reload();await page.getByRole('heading',{name:'密码修改后保留的项目',exact:true}).waitFor();
  await page.locator('#logout').click();await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'test-results/login-mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.locator('#auth-tabs [data-auth-mode="register"]').click();await page.screenshot({path:path.join(root,'test-results/register-mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:['local file preview and inline corrections','import preview draft recovery','invalid rows and selection validation','import permission error and token clearing','import save retry without duplicate records','imported work hours and dashboard recalculation','mobile import dialog','automatic dashboard from saved tasks','dashboard stage and status filters','unassigned owner drilldown','chart keyboard navigation','Gantt editing and live recalculation','dashboard deletion and recovery counts','dashboard empty and zero-result states','dashboard mobile layout','dashboard navigation preserves data','default project work register','work content and responsibility columns','holiday and makeup-day hours preview','status filtering','missing-year calendar setup and recalculation','working-days and planned-hours CSV','50 seed tasks','multi-project generation','CRUD and search','process restart persistence','draft recovery','parallel conflict merge','version history','task recycle and restore','project recycle and restore','offline recovery','backup export','mobile layout','account registration','password confirmation validation','recovery-code download','user data isolation','password change and session revocation','password reset and recovery-code rotation','account persistence after restart','mobile login and registration'],consoleErrors:errors}));
}catch(error){console.error(error);console.error(logs.slice(-7000));process.exitCode=1;}
finally{if(browser)await browser.close();await stop();await rm(data,{recursive:true,force:true});}
