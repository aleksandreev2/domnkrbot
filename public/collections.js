(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const API_TIMEOUT_MS=10000;
  const state={bootstrap:null,tab:'new'};

  async function api(path,options={}){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),API_TIMEOUT_MS);
    try{
      const response=await fetch(path,{credentials:'same-origin',...options,signal:controller.signal});
      const body=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
      return body;
    }catch(error){
      if(controller.signal.aborted)throw new Error('Сервер отвечает слишком долго.');
      throw error;
    }finally{clearTimeout(timer);}
  }

  async function boot(){
    bind();refreshIcons();
    try{state.bootstrap=await api('/api/bootstrap');renderSession();}
    catch{renderSessionError();}
  }

  function bind(){
    $('#mobileMenuButton')?.addEventListener('click',()=>$('#primaryNav')?.classList.toggle('open'));
    $('#createCollection')?.addEventListener('click',openCreateNotice);
    document.querySelectorAll('[data-tab]').forEach((button)=>button.addEventListener('click',()=>setTab(button.dataset.tab||'new')));
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
    window.addEventListener('keydown',(event)=>{if(event.key==='Escape')$('#primaryNav')?.classList.remove('open');});
  }

  function setTab(tab){
    state.tab=tab==='mine'?'mine':'new';
    document.querySelectorAll('[data-tab]').forEach((button)=>button.classList.toggle('active',button.dataset.tab===state.tab));
    const heading=$('#collectionsHeading');
    if(heading)heading.textContent=state.tab==='mine'?'Мои коллекции':'Новые';
    renderEmpty();
  }

  function renderEmpty(){
    const host=$('#collectionsList');if(!host)return;
    const signedIn=Boolean(state.bootstrap?.user);
    const mine=state.tab==='mine';
    const title=mine?(signedIn?'У вас пока нет коллекций':'Войдите через Telegram'):'Коллекций пока нет';
    const message=mine?(signedIn?'После подключения CRUD здесь появятся ваши собственные подборки.':'Авторизация нужна, чтобы создавать и редактировать собственные коллекции.'):'Здесь появятся новые подборки НекромантЛиб.';
    host.innerHTML=`<div class="collections-empty"><i data-lucide="${mine?'bookmark':'library-big'}"></i><strong>${title}</strong><span>${message}</span></div>`;
    refreshIcons();
  }

  function openCreateNotice(){
    const dialog=$('#collectionNotice');
    const text=$('#collectionNoticeText');
    if(text&&!state.bootstrap?.user)text.textContent='Сначала войдите через Telegram. После подключения серверного CRUD вы сможете создавать собственные коллекции.';
    else if(text)text.textContent='Форма создания появится после подключения серверного CRUD. Текущий экран уже использует вашу Telegram-сессию и не создаёт фиктивных данных.';
    if(typeof dialog?.showModal==='function')dialog.showModal();
    refreshIcons();
  }

  function renderSession(){
    const user=state.bootstrap?.user;
    $('#adminLink')?.classList.toggle('hidden',!Boolean(state.bootstrap?.isAdmin));
    $('#logoutButton')?.classList.toggle('hidden',!user);
    const account=$('#accountName');const panel=$('#loginPanel');
    if(user){
      if(account)account.textContent=user.username?`@${user.username}`:user.firstName;
      if(panel)panel.innerHTML='<span class="login-ready">Telegram-сессия активна</span>';
    }else{
      if(account)account.textContent='Войти';
      mountTelegramLogin();
    }
    renderEmpty();refreshIcons();
  }

  function renderSessionError(){
    const account=$('#accountName');if(account)account.textContent='Войти';
    const panel=$('#loginPanel');if(panel)panel.innerHTML='<span class="login-ready">Авторизация временно недоступна</span>';
    renderEmpty();
  }

  function mountTelegramLogin(){
    const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;
    const bot=state.bootstrap?.botUsername;if(!bot){host.textContent='BOT_USERNAME не настроен.';return;}
    host.dataset.ready='1';host.innerHTML='';
    const script=document.createElement('script');script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';host.append(script);
  }

  document.addEventListener('DOMContentLoaded',boot);
})();
