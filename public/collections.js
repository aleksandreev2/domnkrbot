(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const API_TIMEOUT_MS=10000;
  const state={bootstrap:null,tab:'new',collections:[],loading:true};

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
    await loadCollections();
  }

  function bind(){
    $('#mobileMenuButton')?.addEventListener('click',()=>$('#primaryNav')?.classList.toggle('open'));
    $('#createCollection')?.addEventListener('click',openCreateDialog);
    $('#collectionClose')?.addEventListener('click',closeCreateDialog);
    $('#collectionCancel')?.addEventListener('click',closeCreateDialog);
    $('#collectionForm')?.addEventListener('submit',submitCollection);
    document.querySelectorAll('[data-tab]').forEach((button)=>button.addEventListener('click',()=>setTab(button.dataset.tab||'new')));
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
    window.addEventListener('keydown',(event)=>{if(event.key==='Escape')$('#primaryNav')?.classList.remove('open');});
  }

  async function setTab(tab){
    state.tab=tab==='mine'?'mine':'new';
    document.querySelectorAll('[data-tab]').forEach((button)=>button.classList.toggle('active',button.dataset.tab===state.tab));
    const heading=$('#collectionsHeading');if(heading)heading.textContent=state.tab==='mine'?'Мои коллекции':'Новые';
    await loadCollections();
  }

  async function loadCollections(){
    state.loading=true;renderLoading();
    if(state.tab==='mine'&&!state.bootstrap?.user){
      state.loading=false;state.collections=[];renderCollections();return;
    }
    try{
      const payload=state.tab==='mine'?await api('/api/collections?mine=1'):await api('/api/collections');
      state.collections=Array.isArray(payload?.collections)?payload.collections:[];
      state.loading=false;renderCollections();
    }catch(error){state.loading=false;renderCollectionsError(error);}
  }

  function renderLoading(){
    const count=$('#collectionsCount');if(count)count.textContent='Загрузка…';
    const host=$('#collectionsList');if(host)host.innerHTML='<div class="collections-loading"><span></span><span></span><span></span></div>';
  }

  function renderCollections(){
    const host=$('#collectionsList');if(!host)return;
    const count=$('#collectionsCount');if(count)count.textContent=collectionCountLabel(state.collections.length);
    if(!state.collections.length){
      const mine=state.tab==='mine';const signedIn=Boolean(state.bootstrap?.user);
      const title=mine&&!signedIn?'Войдите через Telegram':mine?'У вас пока нет коллекций':'Коллекций пока нет';
      const message=mine&&!signedIn?'Авторизация нужна, чтобы создавать и редактировать собственные подборки.':mine?'Нажмите «Создать», чтобы собрать первую подборку.':'Новые публичные подборки появятся здесь.';
      host.innerHTML=emptyState(mine?'bookmark':'library-big',title,message);refreshIcons();return;
    }
    host.innerHTML=state.collections.map(collectionCard).join('');refreshIcons();
  }

  function renderCollectionsError(error){
    const count=$('#collectionsCount');if(count)count.textContent='Не удалось загрузить';
    const host=$('#collectionsList');if(host)host.innerHTML=emptyState('triangle-alert','Коллекции недоступны',error?.message||'Обновите страницу чуть позже.');
    refreshIcons();
  }

  function collectionCard(item){
    const owner=item.owner?.username?`@${item.owner.username}`:(item.owner?.firstName||'Пользователь');
    const privacy=item.isPublic?'Публичная':'Приватная';
    const description=item.description?`<p>${esc(item.description)}</p>`:'<p class="collection-card-muted">Без описания</p>';
    return `<article class="collection-card" data-collection-id="${esc(item.id||'')}"><div class="collection-card-head"><span class="collection-card-icon"><i data-lucide="layers-3"></i></span><span class="collection-card-privacy">${privacy}</span></div><h3>${esc(item.title||'Без названия')}</h3>${description}<div class="collection-card-meta"><span>${esc(owner)}</span><span>${Number(item.itemCount||0)} тайтлов</span></div>${item.isOwner?'<span class="collection-owner-badge">Ваша коллекция</span>':''}</article>`;
  }

  function openCreateDialog(){
    clearFormError();
    if(!state.bootstrap?.user){
      showFormError('Сначала войдите через Telegram, чтобы создать коллекцию.');
    }
    const dialog=$('#collectionDialog');if(typeof dialog?.showModal==='function')dialog.showModal();refreshIcons();
    setTimeout(()=>$('#collectionTitle')?.focus(),0);
  }

  function closeCreateDialog(){const dialog=$('#collectionDialog');if(dialog?.open)dialog.close();clearFormError();}

  async function submitCollection(event){
    event.preventDefault();clearFormError();
    if(!state.bootstrap?.user){showFormError('Сначала войдите через Telegram.');return;}
    const title=($('#collectionTitle')?.value||'').trim();
    const description=($('#collectionDescription')?.value||'').trim();
    const isPublic=Boolean($('#collectionPublic')?.checked);
    if(!title){showFormError('Введите название коллекции.');return;}
    const submit=$('#collectionSubmit');if(submit){submit.disabled=true;submit.textContent='Создание…';}
    try{
      await api('/api/collections',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title,description,isPublic})});
      $('#collectionForm')?.reset();if($('#collectionPublic'))$('#collectionPublic').checked=true;
      closeCreateDialog();state.tab='mine';document.querySelectorAll('[data-tab]').forEach((button)=>button.classList.toggle('active',button.dataset.tab==='mine'));
      const heading=$('#collectionsHeading');if(heading)heading.textContent='Мои коллекции';
      await loadCollections();
    }catch(error){showFormError(error?.message||'Не удалось создать коллекцию.');}
    finally{if(submit){submit.disabled=false;submit.textContent='Создать';}}
  }

  function showFormError(message){const host=$('#collectionFormError');if(host){host.textContent=message;host.classList.remove('hidden');}}
  function clearFormError(){const host=$('#collectionFormError');if(host){host.textContent='';host.classList.add('hidden');}}

  function renderSession(){
    const user=state.bootstrap?.user;
    $('#adminLink')?.classList.toggle('hidden',!Boolean(state.bootstrap?.isAdmin));
    $('#logoutButton')?.classList.toggle('hidden',!user);
    const account=$('#accountName');const panel=$('#loginPanel');
    if(user){if(account)account.textContent=user.username?`@${user.username}`:user.firstName;if(panel)panel.innerHTML='<span class="login-ready">Telegram-сессия активна</span>';}
    else{if(account)account.textContent='Войти';mountTelegramLogin();}
    refreshIcons();
  }

  function renderSessionError(){const account=$('#accountName');if(account)account.textContent='Войти';const panel=$('#loginPanel');if(panel)panel.innerHTML='<span class="login-ready">Авторизация временно недоступна</span>';}

  function mountTelegramLogin(){
    const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;
    const bot=state.bootstrap?.botUsername;if(!bot){host.textContent='BOT_USERNAME не настроен.';return;}
    host.dataset.ready='1';host.innerHTML='';
    const script=document.createElement('script');script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';host.append(script);
  }

  function collectionCountLabel(count){const mod10=count%10,mod100=count%100;const word=mod10===1&&mod100!==11?'коллекция':mod10>=2&&mod10<=4&&(mod100<12||mod100>14)?'коллекции':'коллекций';return`${count} ${word}`;}
  function emptyState(icon,title,message){return`<div class="collections-empty"><i data-lucide="${icon}"></i><strong>${esc(title)}</strong><span>${esc(message)}</span></div>`;}

  document.addEventListener('DOMContentLoaded',boot);
})();
