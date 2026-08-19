(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  let session=null;

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  async function boot(){
    $('#titleProposalForm')?.addEventListener('submit',submitProposal);
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
    try{session=await api('/api/auth/session');renderSession();}catch(error){showNote(error.message);}
    refreshIcons();
  }

  function renderSession(){
    const user=session?.user;
    $('#adminLink')?.classList.toggle('hidden',!Boolean(session?.isAdmin));
    $('#logoutButton')?.classList.toggle('hidden',!user);
    $('#proposalLogin')?.classList.toggle('hidden',Boolean(user));
    $('#titleProposalForm')?.classList.toggle('hidden',!user);
    const account=$('#proposalAccount');
    if(user){if(account)account.textContent=user.username?`@${user.username}`:user.firstName;return;}
    if(account)account.textContent='LOGIN';mountTelegramLogin();
  }

  function mountTelegramLogin(){
    const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;
    const bot=session?.botUsername;if(!bot){host.textContent='BOT_USERNAME не настроен.';return;}
    host.dataset.ready='1';host.innerHTML='';
    try{localStorage.setItem('domnkr:return-after-login','/propose/');}catch{}
    const script=document.createElement('script');
    script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';
    script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';
    script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';host.append(script);
  }

  async function submitProposal(event){
    event.preventDefault();
    const button=$('#proposalSubmit');const note=$('#proposalNote');
    const title=$('#proposalTitle').value.trim();
    const raw=$('#proposalRaw').value.trim();
    const comment=$('#proposalComment').value.trim();
    if(!/^https?:\/\//i.test(raw)){showNote('RAW должен быть ссылкой, начинающейся с http:// или https://.');return;}
    button.disabled=true;note.textContent='Отправляем…';
    try{
      const result=await api('/api/proposals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({proposalType:'title',title,sourceUrl:raw,comment})});
      event.currentTarget.reset();
      note.textContent=`Заявка принята · #${String(result.id||'').slice(0,8)}`;
    }catch(error){note.textContent=error.message;}finally{button.disabled=false;}
  }

  function showNote(message){const note=$('#proposalNote');if(note)note.textContent=message;}
  document.addEventListener('DOMContentLoaded',boot);
})();
