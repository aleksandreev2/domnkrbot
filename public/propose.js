(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const state={session:null,file:null,uploadId:null,uploadReady:false,uploading:false,failed:false,tab:'file'};
  const DRAFT_KEY='domnkr:title-proposal-draft:v2';

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  async function boot(){
    bind();restoreDraft();refreshIcons();
    try{state.session=await api('/api/auth/session');renderSession();}catch(error){showNote(error.message);}
    updateSubmitState();
  }

  function bind(){
    $('#titleProposalForm')?.addEventListener('submit',submitProposal);
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
    $('#mobileMenuButton')?.addEventListener('click',()=>$('#primaryNav')?.classList.toggle('open'));
    document.querySelectorAll('[data-raw-tab]').forEach((button)=>button.addEventListener('click',()=>setTab(button.dataset.rawTab)));
    $('#rawChoose')?.addEventListener('click',()=>chooseFile());
    $('#rawFile')?.addEventListener('change',(event)=>{const file=event.target.files?.[0];if(file)void selectFile(file);});
    $('#rawDrop')?.addEventListener('keydown',(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();chooseFile();}});
    for(const eventName of ['dragenter','dragover'])$('#rawDrop')?.addEventListener(eventName,(event)=>{event.preventDefault();$('#rawDrop').classList.add('drag');});
    for(const eventName of ['dragleave','drop'])$('#rawDrop')?.addEventListener(eventName,(event)=>{event.preventDefault();$('#rawDrop').classList.remove('drag');});
    $('#rawDrop')?.addEventListener('drop',(event)=>{const file=event.dataTransfer?.files?.[0];if(file)void selectFile(file);});
    $('#rawRemove')?.addEventListener('click',()=>void removeUpload());
    $('#rawRetry')?.addEventListener('click',()=>void startUpload());
    for(const id of ['proposalTitle','proposalOriginalTitle','proposalRawUrl','proposalExtraUrl','proposalComment']){
      $('#'+id)?.addEventListener('input',()=>{saveDraft();updateSubmitState();});
    }
  }

  function renderSession(){
    const user=state.session?.user;
    $('#adminLink')?.classList.toggle('hidden',!Boolean(state.session?.isAdmin));
    $('#logoutButton')?.classList.toggle('hidden',!user);
    const account=$('#proposalAccount');if(account)account.textContent=user?(user.username?`@${user.username}`:user.firstName):'Войти';
    $('#loginRequired')?.classList.toggle('hidden',Boolean(user));
    if(!user)mountTelegramLogin();
    updateSubmitState();refreshIcons();
  }

  function mountTelegramLogin(){
    const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;
    const bot=state.session?.botUsername;if(!bot){host.textContent='BOT_USERNAME не настроен.';return;}
    host.dataset.ready='1';host.innerHTML='';
    try{localStorage.setItem('domnkr:return-after-login','/propose/');}catch{}
    const script=document.createElement('script');script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';
    script.dataset.telegramLogin=bot;script.dataset.size='medium';script.dataset.userpic='false';script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';host.append(script);
  }

  function setTab(tab){
    state.tab=tab==='url'?'url':'file';
    $('#rawFilePanel').classList.toggle('hidden',state.tab!=='file');$('#rawUrlPanel').classList.toggle('hidden',state.tab!=='url');
    document.querySelectorAll('[data-raw-tab]').forEach((button)=>button.classList.toggle('active',button.dataset.rawTab===state.tab));
    updateSubmitState();
  }

  function chooseFile(){
    if(!state.session?.user){showNote('Сначала войдите через Telegram, затем выберите RAW-файл.');return;}
    $('#rawFile')?.click();
  }

  async function selectFile(file){
    state.file=file;state.uploadId=null;state.uploadReady=false;state.failed=false;
    $('#rawFileState').classList.remove('hidden');$('#rawRetry').classList.add('hidden');
    $('#rawFileName').textContent=file.name;$('#rawFileExt').textContent=(file.name.split('.').pop()||'RAW').slice(0,5).toUpperCase();
    $('#rawFileMeta').textContent=`${formatBytes(file.size)} · ${file.type||'файл'}`;setProgress(0,'Подготовка…');updateSubmitState();refreshIcons();
    await startUpload();
  }

  async function startUpload(){
    if(!state.file||!state.session?.user||state.uploading)return;
    state.uploading=true;state.failed=false;$('#rawRetry').classList.add('hidden');updateSubmitState();
    try{
      let intent;
      if(!state.uploadId){
        intent=await api('/api/proposal-raw/init',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({filename:state.file.name,size:state.file.size,contentType:state.file.type||'application/octet-stream'})});
        state.uploadId=intent.id;
      }else{
        const status=await api(`/api/proposal-raw/${encodeURIComponent(state.uploadId)}`);intent={...status,partCount:Math.ceil(status.size/status.partSize)};
      }
      const status=await api(`/api/proposal-raw/${encodeURIComponent(state.uploadId)}`);
      const uploaded=new Set((status.parts||[]).map((part)=>Number(part.partNumber)));
      const partSize=Number(status.partSize||intent.partSize);const partCount=Math.ceil(state.file.size/partSize);
      let completedBytes=(status.parts||[]).reduce((sum,part)=>sum+Number(part.size||0),0);
      setProgress(Math.round(completedBytes/state.file.size*100),`Загружено ${uploaded.size}/${partCount} частей`);

      const queue=[];for(let partNumber=1;partNumber<=partCount;partNumber+=1)if(!uploaded.has(partNumber))queue.push(partNumber);
      const workers=Array.from({length:Math.min(3,queue.length||1)},async()=>{
        while(queue.length){
          const partNumber=queue.shift();if(!partNumber)break;
          const start=(partNumber-1)*partSize;const end=Math.min(start+partSize,state.file.size);const blob=state.file.slice(start,end);
          await uploadPartWithRetry(state.uploadId,partNumber,blob);
          completedBytes+=blob.size;const percent=Math.min(99,Math.round(completedBytes/state.file.size*100));
          setProgress(percent,`Загрузка · часть ${partNumber}/${partCount}`);
        }
      });
      await Promise.all(workers);
      await api(`/api/proposal-raw/${encodeURIComponent(state.uploadId)}/complete`,{method:'POST'});
      state.uploadReady=true;setProgress(100,'RAW загружен и проверен');showNote('RAW-файл готов. Теперь можно отправить заявку.');
    }catch(error){
      state.failed=true;$('#rawRetry').classList.remove('hidden');showNote(`Загрузка RAW остановлена: ${error.message}`);$('#rawFileMeta').textContent=`${formatBytes(state.file.size)} · можно продолжить загрузку`;
    }finally{state.uploading=false;updateSubmitState();refreshIcons();}
  }

  async function uploadPartWithRetry(uploadId,partNumber,blob){
    let lastError=null;
    for(let attempt=1;attempt<=3;attempt+=1){
      try{
        const response=await fetch(`/api/proposal-raw/${encodeURIComponent(uploadId)}/parts/${partNumber}`,{method:'PUT',credentials:'same-origin',body:blob});
        const body=await response.json().catch(()=>null);if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);return body;
      }catch(error){lastError=error;if(attempt<3)await sleep(350*Math.pow(2,attempt-1));}
    }
    throw lastError||new Error(`Не удалось загрузить часть ${partNumber}`);
  }

  async function removeUpload(){
    if(state.uploading){showNote('Дождитесь завершения текущей части или обновите страницу.');return;}
    if(state.uploadId){try{await api(`/api/proposal-raw/${encodeURIComponent(state.uploadId)}`,{method:'DELETE'});}catch(error){showNote(error.message);return;}}
    state.file=null;state.uploadId=null;state.uploadReady=false;state.failed=false;$('#rawFile').value='';$('#rawFileState').classList.add('hidden');setProgress(0,'');showNote('RAW-файл удалён.');updateSubmitState();
  }

  async function submitProposal(event){
    event.preventDefault();saveDraft();
    const title=$('#proposalTitle').value.trim();const originalTitle=$('#proposalOriginalTitle').value.trim();
    const sourceUrl=$('#proposalRawUrl').value.trim();const extraUrl=$('#proposalExtraUrl').value.trim();const comment=$('#proposalComment').value.trim();
    if(!state.session?.user){showNote('Войдите через Telegram, чтобы отправить заявку.');return;}
    if(title.length<2){showNote('Введите название тайтла.');return;}
    if(!state.uploadReady&&!/^https?:\/\//i.test(sourceUrl)){showNote('Приложите RAW-файл или укажите рабочую RAW-ссылку.');return;}
    const button=$('#proposalSubmit');button.disabled=true;showNote('Отправляем заявку…');
    try{
      const result=await api('/api/title-proposals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title,originalTitle,sourceUrl,extraUrl,comment,rawUploadId:state.uploadReady?state.uploadId:null})});
      clearDraft();event.currentTarget.reset();state.file=null;state.uploadId=null;state.uploadReady=false;$('#rawFileState').classList.add('hidden');setTab('file');
      showNote(`Заявка принята · #${String(result.id||'').slice(0,8)}. Спасибо!`);
    }catch(error){showNote(error.message);}finally{updateSubmitState();}
  }

  function updateSubmitState(){
    const button=$('#proposalSubmit');if(!button)return;const title=$('#proposalTitle')?.value.trim()||'';const rawUrl=$('#proposalRawUrl')?.value.trim()||'';
    const canRaw=state.uploadReady||/^https?:\/\//i.test(rawUrl);const enabled=Boolean(state.session?.user)&&title.length>=2&&canRaw&&!state.uploading;
    button.disabled=!enabled;button.innerHTML=enabled?'<i data-lucide="send"></i>Отправить заявку':'<i data-lucide="lock"></i>Отправить заявку';refreshIcons();
  }

  function saveDraft(){
    try{localStorage.setItem(DRAFT_KEY,JSON.stringify({title:$('#proposalTitle')?.value||'',originalTitle:$('#proposalOriginalTitle')?.value||'',rawUrl:$('#proposalRawUrl')?.value||'',extraUrl:$('#proposalExtraUrl')?.value||'',comment:$('#proposalComment')?.value||'',tab:state.tab}));}catch{}
  }
  function restoreDraft(){
    try{const draft=JSON.parse(localStorage.getItem(DRAFT_KEY)||'null');if(!draft)return;$('#proposalTitle').value=draft.title||'';$('#proposalOriginalTitle').value=draft.originalTitle||'';$('#proposalRawUrl').value=draft.rawUrl||'';$('#proposalExtraUrl').value=draft.extraUrl||'';$('#proposalComment').value=draft.comment||'';setTab(draft.tab||'file');}catch{}
  }
  function clearDraft(){try{localStorage.removeItem(DRAFT_KEY);}catch{}}
  function setProgress(percent,label){$('#rawProgressBar').style.width=`${Math.max(0,Math.min(100,percent))}%`;$('#rawProgress').textContent=`${Math.max(0,Math.min(100,percent))}%`;if(label&&state.file)$('#rawFileMeta').textContent=`${formatBytes(state.file.size)} · ${label}`;}
  function formatBytes(bytes){if(bytes>=1024**3)return`${(bytes/1024**3).toFixed(2)} ГиБ`;if(bytes>=1024**2)return`${(bytes/1024**2).toFixed(1)} МиБ`;if(bytes>=1024)return`${(bytes/1024).toFixed(1)} КиБ`;return`${bytes} Б`;}
  function showNote(message){const note=$('#proposalNote');if(note)note.textContent=message;}
  const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
  document.addEventListener('DOMContentLoaded',boot);
})();
