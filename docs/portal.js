'use strict';
(async()=>{
  const status=document.getElementById('release-status'),entry=document.getElementById('enter-workspace'),note=document.getElementById('entry-note');
  try{
    const response=await fetch('config.json',{cache:'no-store'});
    if(!response.ok)throw Error('config unavailable');
    const config=await response.json();
    if(!config.appUrl){status.textContent='云端工作台待发布';note.textContent='云服务正在准备，发布完成后即可进入。请联系项目管理员了解进展。';return;}
    const url=new URL(config.appUrl);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.port&&url.port!=='443'||['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('invalid URL');
    entry.href=url.href;entry.classList.remove('disabled');entry.removeAttribute('aria-disabled');
    status.textContent='云端访问入口已配置';status.classList.add('connected');
    note.textContent='登录你的账号后继续。首次使用可注册账号；项目填写内容保存在云端数据库。';
  }catch{
    status.textContent='访问入口暂未就绪';note.textContent='暂时无法读取工作台地址，请稍后刷新或联系项目管理员。';
  }
})();
