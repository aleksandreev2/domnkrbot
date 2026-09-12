(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const API_TIMEOUT_MS=10000;
  const params=new URLSearchParams(location.search);
  const state={id:(params.get('id')||'').trim(),bootstrap:null,collection:null,items:[],catalog:[],catalogLoaded:false};

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
    if(!state.id){renderFatal('Коллекция не указана.');return;}
    const [bootstrapResult,collectionResult]=await Promise.allSettled([
      api('/api/bootstrap'),
      api(`/api/collections/${encodeURIComponent(state.id)}`),
    ]);
    if(bootstrapResult.status==='fulfilled'){state.bootstrap=bootstrapResult.value;renderSession();}
    else renderSessionError();
    if(collectionResult.status==='fulfilled'){
      state.collection=collectionResult.value?.collection||null;
      state.items=Array.isArray(collectionResult.value?.items)?collectionResult.value.items:[];
      renderCollection();
    }else renderFatal(collectionResult.reason?.message||'Не удалось загрузить коллекцию.');
  }

  function bind(){
    $('#mobileMenuButton')?.addEventListener('click',()=>$('#primaryNav')?.classList.toggle('open'));
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
    $('#addTitleButton')?.addEventListener('click',openAddDialog);
    $('#addTitleClose')?.addEventListener('click',closeAddDialog);
    $('#addTitleCancel')?.addEventListener('click',closeAddDialog);
    $('#addTitleForm')?.addEventListener('submit',submitTitle);
    $('#titleSearch')?.addEventListener('input',renderTitlePicker);
    $('#collectionGroups')?.addEventListener('click',handleGroupClick);
    window.addEventListener('keydown',(event)=>{if(event.key==='Escape')$('#primaryNav')?.classList.remove('open');});
  }

  function renderCollection(){
    const item=state.collection;if(!item){renderFatal('Коллекция не найдена.');return;}
    document.title=`${item.title||'Коллекция'} · НекромантЛиб`;
    setText('#collectionTitle',item.title||'Без названия');
    setText('#collectionDescription',item.description||'Автор не добавил описание.');
    const owner=item.owner?.username?`@${item.owner.username}`:(item.owner?.firstName||'Пользователь');
    const visibility=item.isPublic?'Публичная':'Приватная';
    setText('#collectionOwner',owner);setText('#collectionOwnerAside',owner);
    setText('#collectionVisibility',visibility);setText('#collectionVisibilityAside',visibility);
    setText('#collectionItemCount',titleCountLabel(state.items.length));setText('#collectionCountAside',String(state.items.length));
    setText('#collectionUpdatedAside',formatDate(item.updatedAt));
    $('#ownerActions')?.classList.toggle('hidden',!item.isOwner);
    renderGroups();refreshIcons();
  }

  function renderGroups(){
    const host=$('#collectionGroups');if(!host)return;
    if(!state.items.length){host.innerHTML=emptyState('library-big','В коллекции пока нет тайтлов',state.collection?.isOwner?'Добавьте первый тайтл из каталога НекромантЛиб.':'Автор пока не наполнил эту подборку.');refreshIcons();return;}
    const groups=new Map();
    for(const item of state.items){const key=(item.groupName||'').trim()||'Без группы';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
    host.innerHTML=[...groups.entries()].map(([name,items])=>`<section class="collection-group"><div class="collection-group-head"><div><h3>${esc(name)}</h3><span>${titleCountLabel(items.length)}</span></div></div><div class="collection-group-grid">${items.map(titleCard).join('')}</div></section>`).join('');
    refreshIcons();
  }

  function titleCard(item){
    const cover=esc(item.coverUrl||'/brand/team-logo.webp');const title=esc(item.title||item.bookRef||'Без названия');
    const note=item.note?`<p class="collection-item-note">${esc(item.note)}</p>`:'';
    const remove=state.collection?.isOwner?`<button class="collection-item-remove" type="button" data-remove-ref="${esc(item.bookRef||'')}" aria-label="Удалить ${title}"><i data-lucide="trash-2"></i></button>`:'';
    return `<article class="collection-item-card"><a class="collection-item-link" href="/title/?ref=${encodeURIComponent(item.bookRef||'')}"><img loading="lazy" src="${cover}" alt="Обложка ${title}"><span class="collection-item-copy"><strong>${title}</strong><small>${Number(item.chapterCount||0)} глав</small>${note}</span></a>${remove}</article>`;
  }

  async function handleGroupClick(event){
    const button=event.target.closest('[data-remove-ref]');if(!button||!state.collection?.isOwner)return;
    const bookRef=button.dataset.removeRef||'';if(!bookRef)return;
    button.disabled=true;
    try{
      const payload=await api(`/api/collections/${encodeURIComponent(state.id)}/items`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({bookRef})});
      state.collection=payload.collection||state.collection;state.items=Array.isArray(payload.items)?payload.items:[];renderCollection();
    }catch(error){button.disabled=false;showInlineError(error?.message||'Не удалось удалить тайтл.');}
  }

  async function openAddDialog(){
    if(!state.collection?.isOwner)return;
    clearAddError();
    const dialog=$('#addTitleDialog');if(typeof dialog?.showModal==='function')dialog.showModal();
    if(!state.catalogLoaded){
      setPickerMessage('Загрузка каталога…');
      try{
        const payload=await api('/api/ranobelib');
        const richer=Array.isArray(payload?.catalogTitles)?payload.catalogTitles:null;
        state.catalog=richer??(Array.isArray(payload?.titles)?payload.titles:[]);
        state.catalogLoaded=true;renderTitlePicker();
      }catch(error){showAddError(error?.message||'Не удалось загрузить каталог.');setPickerMessage('Каталог недоступен');}
    }else renderTitlePicker();
    setTimeout(()=>$('#titleSearch')?.focus(),0);refreshIcons();
  }

  function closeAddDialog(){const dialog=$('#addTitleDialog');if(dialog?.open)dialog.close();clearAddError();}

  function renderTitlePicker(){
    const picker=$('#titlePicker');if(!picker)return;
    const query=($('#titleSearch')?.value||'').trim().toLocaleLowerCase('ru-RU');
    const existing=new Set(state.items.map((item)=>item.bookRef));
    const candidates=state.catalog.filter((item)=>!existing.has(item.book_ref)&&(!query||String(item.title||'').toLocaleLowerCase('ru-RU').includes(query))).slice(0,150);
    picker.innerHTML='<option value="">Выберите тайтл</option>'+candidates.map((item)=>`<option value="${esc(item.book_ref||'')}">${esc(item.title||item.book_ref||'Без названия')} · ${Number(item.chapter_count||0)} глав</option>`).join('');
    picker.disabled=!candidates.length;
    if(!candidates.length)picker.innerHTML='<option value="">Ничего не найдено</option>';
  }

  function setPickerMessage(message){const picker=$('#titlePicker');if(picker){picker.disabled=true;picker.innerHTML=`<option value="">${esc(message)}</option>`;}}

  async function submitTitle(event){
    event.preventDefault();clearAddError();
    const bookRef=$('#titlePicker')?.value||'';if(!bookRef){showAddError('Выберите тайтл.');return;}
    const groupName=($('#groupName')?.value||'').trim();const note=($('#titleNote')?.value||'').trim();
    const submit=$('#addTitleSubmit');if(submit){submit.disabled=true;submit.textContent='Добавление…';}
    try{
      const payload=await api(`/api/collections/${encodeURIComponent(state.id)}/items`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bookRef,groupName,note})});
      state.collection=payload.collection||state.collection;state.items=Array.isArray(payload.items)?payload.items:[];
      $('#addTitleForm')?.reset();closeAddDialog();renderCollection();
    }catch(error){showAddError(error?.message||'Не удалось добавить тайтл.');}
    finally{if(submit){submit.disabled=false;submit.textContent='Добавить';}}
  }

  function renderFatal(message){
    setText('#collectionTitle','Коллекция недоступна');setText('#collectionDescription',message);
    const host=$('#collectionGroups');if(host)host.innerHTML=emptyState('triangle-alert','Не удалось открыть коллекцию',message);
    $('#ownerActions')?.classList.add('hidden');refreshIcons();
  }

  function showInlineError(message){const host=$('#collectionGroups');if(!host)return;const note=document.createElement('div');note.className='collection-inline-error';note.textContent=message;host.prepend(note);setTimeout(()=>note.remove(),4500);}
  function showAddError(message){const host=$('#addTitleError');if(host){host.textContent=message;host.classList.remove('hidden');}}
  function clearAddError(){const host=$('#addTitleError');if(host){host.textContent='';host.classList.add('hidden');}}
  function setText(selector,value){const node=$(selector);if(node)node.textContent=value;}

  function renderSession(){
    const user=state.bootstrap?.user;$('#adminLink')?.classList.toggle('hidden',!Boolean(state.bootstrap?.isAdmin));$('#logoutButton')?.classList.toggle('hidden',!user);
    const account=$('#accountName'),panel=$('#loginPanel');
    if(user){if(account)account.textContent=user.username?`@${user.username}`:user.firstName;if(panel)panel.innerHTML='<span class="login-ready">Telegram-сессия активна</span>';}
    else{if(account)account.textContent='Войти';mountTelegramLogin();}refreshIcons();
  }
  function renderSessionError(){const account=$('#accountName');if(account)account.textContent='Войти';const panel=$('#loginPanel');if(panel)panel.innerHTML='<span class="login-ready">Авторизация временно недоступна</span>';}
  function mountTelegramLogin(){const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;const bot=state.bootstrap?.botUsername;if(!bot){host.textContent='BOT_USERNAME не настроен.';return;}host.dataset.ready='1';host.innerHTML='';const script=document.createElement('script');script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';host.append(script);}

  function titleCountLabel(count){const mod10=count%10,mod100=count%100;const word=mod10===1&&mod100!==11?'тайтл':mod10>=2&&mod10<=4&&(mod100<12||mod100>14)?'тайтла':'тайтлов';return`${count} ${word}`;}
  function formatDate(value){if(!value)return'—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'short',year:'numeric'}).format(date);}
  function emptyState(icon,title,message){return`<div class="collection-detail-empty"><i data-lucide="${icon}"></i><strong>${esc(title)}</strong><span>${esc(message)}</span></div>`;}

  document.addEventListener('DOMContentLoaded',boot);
})();
