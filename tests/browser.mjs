// Run with the installed Playwright runtime (see README). No browser dependency ships with the app.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
  await page.goto(base);await page.locator('#password').fill(password);await page.locator('#login-form button').click();
  await page.getByRole('heading',{name:'每个计划，都向前一步。'}).waitFor();
  await page.screenshot({path:path.join(root,'test-results/home.png'),fullPage:true});
  await page.locator('.project-card [data-project="haikang"]').click();await page.locator('.task-card').first().waitFor();
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
  assert.equal(await page.locator('.task-card').count(),3);
  await page.locator('[data-task="T-001"]').click();
  await page.locator('[name="nextAction"]').fill('已完成访谈并整理纪要');await page.locator('[name="status"]').selectOption('进行中');await page.locator('[name="progress"]').fill('45');
  await page.locator('#save-task').click();await page.locator('#editor').waitFor({state:'hidden'});
  // A real process restart must retain the login session, new project, and saved edits.
  await stop();await start();await page.reload();await page.locator('[data-task="T-001"]').waitFor();await page.locator('[data-task="T-001"]').click();
  assert.equal(await page.locator('[name="nextAction"]').inputValue(),'已完成访谈并整理纪要');assert.equal(await page.locator('[name="progress"]').inputValue(),'45');
  // Closing and refreshing before save must preserve the local draft.
  await page.locator('[name="blocker"]').fill('草稿：等待客户确认');await page.locator('[data-close="editor"]').click();await page.reload();await page.locator('[data-task="T-001"]').click();
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
  await page.locator('[data-view="todo"]').click();await page.screenshot({path:path.join(root,'test-results/todo.png'),fullPage:true});
  const downloadPromise=page.waitForEvent('download');await page.locator('[data-action="export"]').click();const download=await downloadPromise;await download.saveAs(path.join(root,'test-results/export.json'));
  // Network failure cannot clear draft or close the editor.
  await page.locator('[data-task="T-001"]').click();await page.locator('[name="decision"]').fill('断网时填写的决策');await context.setOffline(true);await page.locator('#save-task').click();await page.locator('#task-error').filter({hasText:/fetch|网络|Failed/}).waitFor();assert.equal(await page.locator('[name="decision"]').inputValue(),'断网时填写的决策');await context.setOffline(false);await page.locator('#save-task').click();await page.locator('#editor').waitFor({state:'hidden'});
  await page.setViewportSize({width:390,height:844});await page.locator('[data-view="board"]').click();await page.screenshot({path:path.join(root,'test-results/mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile page must not overflow');
  await page.locator('[data-action="edit-project"]').click();await page.locator('[name="name"]').fill('官网升级 · 已修改');await page.locator('#save-project').click();await page.getByRole('heading',{name:'官网升级 · 已修改',exact:true}).waitFor();
  page.once('dialog',dialog=>dialog.accept());await page.locator('[data-action="delete-project"]').click();await page.getByRole('heading',{name:'每个计划，都向前一步。'}).waitFor();
  await page.locator('#mobile-menu').click();await page.locator('#trash').click();await page.locator(`[data-restore-project="${projectId}"]`).click();await page.getByRole('heading',{name:'官网升级 · 已修改',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:['50 seed tasks','multi-project generation','CRUD and search','process restart persistence','draft recovery','parallel conflict merge','version history','task recycle and restore','project recycle and restore','offline recovery','backup export','mobile layout'],consoleErrors:errors}));
}catch(error){console.error(error);console.error(logs.slice(-7000));process.exitCode=1;}
finally{if(browser)await browser.close();await stop();await rm(data,{recursive:true,force:true});}
