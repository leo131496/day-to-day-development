import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url),{chromium}=require('playwright');
const root=path.resolve(import.meta.dirname,'..'),base='http://127.0.0.1:8767';
let service,browser,logs='';
try{
  await mkdir(path.join(root,'test-results'),{recursive:true});
  service=spawn('python3',['-B','-m','http.server','8767','--bind','127.0.0.1','--directory','docs'],{cwd:root,stdio:['ignore','pipe','pipe']});
  service.stderr.on('data',v=>logs+=v);service.stdout.on('data',v=>logs+=v);
  for(let i=0;i<60;i++){try{if((await fetch(base+'/config.json')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:980}}),errors=[];
  page.on('pageerror',err=>errors.push(err.message));
  await page.goto(base);await page.locator('#release-status').filter({hasText:'待发布'}).waitFor();
  assert.equal(await page.locator('#enter-workspace').getAttribute('href'),null);
  assert.equal(await page.locator('input').count(),0,'Unpublished portal must not present a fake login');
  await page.screenshot({path:path.join(root,'test-results/portal-pending.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'test-results/portal-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.route('**/config.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({appUrl:'https://projects.example.com'})}));
  await page.reload();await page.locator('#release-status').filter({hasText:'已配置'}).waitFor();
  assert.equal(await page.locator('#enter-workspace').getAttribute('href'),'https://projects.example.com/');
  assert.equal(await page.locator('#enter-workspace').getAttribute('aria-disabled'),null);
  await page.unroute('**/config.json');
  await page.route('**/config.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({appUrl:'javascript:alert(1)'})}));
  await page.reload();await page.locator('#release-status').filter({hasText:'暂未就绪'}).waitFor();
  assert.equal(await page.locator('#enter-workspace').getAttribute('href'),null);
  await page.goto(base+'/deploy.html');assert.equal(await page.locator('a.primary').getAttribute('href'),'https://app.northflank.com/signup');
  assert.match(await page.locator('.setup-callout').textContent(),/免费/);
  assert.match(await page.locator('.setup-callout').textContent(),/No card needed/);
  assert.match(await page.locator('.setup-callout').textContent(),/Render.*已暂停/);
  assert.equal(await page.locator('a[href^="https://render.com/deploy"]').count(),0);
  assert.equal(await page.locator('a[href="https://turso.tech/"]').count(),1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:path.join(root,'test-results/deploy-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:980});await page.screenshot({path:path.join(root,'test-results/deploy-desktop.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:['truthful pending deployment state','no fake login or save controls','verified URL configuration','invalid URL blocked','mobile portal and setup','free plans and account authorization disclosure'],consoleErrors:errors}));
}catch(err){console.error(err);console.error(logs.slice(-2000));process.exitCode=1;}
finally{if(browser)await browser.close();if(service&&service.exitCode===null){service.kill('SIGTERM');await new Promise(r=>service.once('exit',r));}}
