(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const API_TIMEOUT_MS=10000;
  const params=new URLSearchParams(location.search);
  const state={id:(params.get('id')||'').trim(),bootstrap:null,collection:null,items:[],catalog:[],catalogLoaded:false,editingBookRef:'',comments:[],commentsLoaded:false};

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
    bind();refreshIcons();renderCommentComposer();
    if(!state.id){renderFatal('Коллекция не указана.');return;}
    const [bootstrapResult,collectionResult]=await Promise.allSettled([
      api('/api/bootstrap'),
      api(`/api/collections/${encodeURIComponent(state.id)}`),
    ]);
    if(bootstrapResult.status==='fulfilled'){state.bootstrap=bootstrapResult.value;renderSession();}
    else renderSessionError();
    if(collectionResult.status==='fulfilled'){
      applyCollectionPayload(collectionResult.value);
      renderCollection();
      void loadComments();
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
    $('#editCollectionButton')?.addEventListener('click',openCollectionEditor);
    $('#editCollectionClose')?.addEventListener('click',closeCollectionEditor);
    $('#editCollectionCancel')?.addEventListener('click',closeCollectionEditor);
    $('#editCollectionForm')?.addEventListener('submit',submitCollectionEdit);
    $('#deleteCollectionButton')?.addEventListener('click',openDeleteDialog);
    $('#deleteCollectionClose')?.addEventListener('click',closeDeleteDialog);
    $('#deleteCollectionCancel')?.addEventListener('click',closeDeleteDialog);
    $('#deleteCollectionForm')?.addEventListener('submit',submitCollectionDelete);
    $('#editItemClose')?.addEventListener('click',closeItemEditor);
    $('#editItemCancel')?.addEventListener('click',closeItemEditor);
    $('#editItemForm')?.addEventListener('submit',submitItemEdit);
    $('#collectionGroups')?.addEventListener('click',handleGroupClick);
    $('#commentForm')?.addEventListener('submit',submitComment);
    $('#collectionComments')?.addEventListener('click',handleCommentClick);
    window.addEventListener('keydown',(event)=>{if(event.key==='Escape')$('#primaryNav')?.classList.remove('open');});
  }

  function applyCollectionPayload(payload){
    state.collection=payload?.collection||state.collection;
    state.items=Array.isArray(payload?.items)?payload.items:state.items;
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
    renderGroups();renderCommentComposer();refreshIcons();
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
    const controls=state.collection?.isOwner?`<div class="collection-item-edit"><button type="button" data-edit-ref="${esc(item.bookRef||'')}" aria-label="Настроить ${title}"><i data-lucide="pencil"></i></button><button type="button" class="collection-item-remove" data-remove-ref="${esc(item.bookRef||'')}" aria-label="Удалить ${title}"><i data-lucide="trash-2"></i></button></div>`:'';
    return `<article class="collection-item-card"><a class="collection-item-link" href="/title/?ref=${encodeURIComponent(item.bookRef||'')}"><img loading="lazy" src="${cover}" alt="Обложка ${title}"><span class="collection-item-copy"><strong>${title}</strong><small>${Number(item.chapterCount||0)} глав</small>${note}</span></a>${controls}</article>`;
  }

  async function handleGroupClick(event){
    const editButton=event.target.closest('[data-edit-ref]');
    if(editButton&&state.collection?.isOwner){openItemEditor(editButton.dataset.editRef||'');return;}
    const button=event.target.closest('[data-remove-ref]');if(!button||!state.collection?.isOwner)return;
    const bookRef=button.dataset.removeRef||'';if(!bookRef)return;
    button.disabled=true;
    try{
      const payload=await api(`/api/collections/${encodeURIComponent(state.id)}/items`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({bookRef})});
      applyCollectionPayload(payload);renderCollection();
    }catch(error){button.disabled=false;showInlineError(error?.message||'Не удалось удалить тайтл.');}
  }

  async function openAddDialog(){
    if(!state.collection?.isOwner)return;
    clearError('#addTitleError');
    const dialog=$('#addTitleDialog');if(typeof dialog?.showModal==='function')dialog.showModal();
    if(!state.catalogLoaded){
      setPickerMessage('Загрузка каталога…');
      try{
        const payload=await api('/api/ranobelib');
        const richer=Array.isArray(payload?.catalogTitles)?payload.catalogTitles:null;
        state.catalog=richer??(Array.isArray(payload?.titles)?payload.titles:[]);
        state.catalogLoaded=true;renderTitlePicker();
      }catch(error){showError('#addTitleError',error?.message||'Не удалось загрузить каталог.');setPickerMessage('Каталог недоступен');}
    }else renderTitlePicker();
    setTimeout(()=>$('#titleSearch')?.focus(),0);refreshIcons();
  }

  function closeAddDialog(){closeDialog('#addTitleDialog');clearError('#addTitleError');}

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
    event.preventDefault();clearError('#addTitleError');
    const bookRef=$('#titlePicker')?.value||'';if(!bookRef){showError('#addTitleError','Выберите тайтл.');return;}
    const groupName=($('#groupName')?.value||'').trim();const note=($('#titleNote')?.value||'').trim();
    const submit=$('#addTitleSubmit');setBusy(submit,true,'Добавление…');
    try{
      const payload=await api(`/api/collections/${encodeURIComponent(state.id)}/items`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bookRef,groupName,note})});
      applyCollectionPayload(payload);$('#addTitleForm')?.reset();closeAddDialog();renderCollection();
    }catch(error){showError('#addTitleError',error?.message||'Не удалось добавить тайтл.');}
    finally{setBusy(submit,false,'Добавить');}
  }

  function openCollectionEditor(){
    if(!state.collection?.isOwner)return;
    const title=$('#editCollectionTitle'),description=$('#editCollectionDescription'),visibility=$('#editCollectionPublic');
    if(title)title.value=state.collection.title||'';
    if(description)description.value=state.collection.description||'';
    if(visibility)visibility.checked=Boolean(state.collection.isPublic);
    clearError('#editCollectionError');openDialog('#editCollectionDialog');setTimeout(()=>title?.focus(),0);
  }
  function closeCollectionEditor(){closeDialog('#editCollectionDialog');clearError('#editCollectionError');}

  async function submitCollectionEdit(event){
    event.preventDefault();clearError('#editCollectionError');
    if(!state.collection?.isOwner)return;
    const title=($('#editCollectionTitle')?.value||'').trim();
    const description=($('#editCollectionDescription')?.value||'').trim();
    const isPublic=Boolean($('#editCollectionPublic')?.checked);
    if(!title){showError('#editCollectionError','Введите название коллекции.');return;}
    const submit=$('#editCollectionSubmit');setBusy(submit,true,'Сохранение…');
    try{
      const payload=await api(`/api/collections/${encodeURIComponent(state.id)}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({title,description,isPublic})});
      applyCollectionPayload(payload);closeCollectionEditor();renderCollection();
    }catch(error){showError('#editCollectionError',error?.message||'Не удалось сохранить коллекцию.');}
    finally{setBusy(submit,false,'Сохранить');}
  }

  function openDeleteDialog(){if(state.collection?.isOwner){clearError('#deleteCollectionError');openDialog('#deleteCollectionDialog');}}
  function closeDeleteDialog(){closeDialog('#deleteCollectionDialog');clearError('#deleteCollectionError');}
  async function submitCollectionDelete(event){
    event.preventDefault();if(!state.collection?.isOwner)return;
    const submit=$('#deleteCollectionConfirm');setBusy(submit,true,'Удаление…');
    try{
      await api(`/api/collections/${encodeURIComponent(state.id)}`,{method:'DELETE'});
      location.assign('/collections/?tab=mine');
    }catch(error){showError('#deleteCollectionError',error?.message||'Не удалось удалить коллекцию.');setBusy(submit,false,'Удалить');}
  }

  function openItemEditor(bookRef){
    const item=state.items.find((entry)=>entry.bookRef===bookRef);if(!item)return;
    state.editingBookRef=bookRef;setText('#editItemTitle',item.title||bookRef);
    const group=$('#editItemGroup'),note=$('#editItemNote');if(group)group.value=item.groupName||'';if(note)note.value=item.note||'';
    clearError('#editItemError');openDialog('#editItemDialog');setTimeout(()=>group?.focus(),0);
  }
  function closeItemEditor(){state.editingBookRef='';closeDialog('#editItemDialog');clearError('#editItemError');}
  async function submitItemEdit(event){
    event.preventDefault();clearError('#editItemError');
    const bookRef=state.editingBookRef;if(!bookRef||!state.collection?.isOwner)return;
    const groupName=($('#editItemGroup')?.value||'').trim();const note=($('#editItemNote')?.value||'').trim();
    const submit=$('#editItemSubmit');setBusy(submit,true,'Сохранение…');
    try{
      const payload=await api(`/api/collections/${encodeURIComponent(state.id)}/items`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({bookRef,groupName,note})});
      applyCollectionPayload(payload);closeItemEditor();renderCollection();
    }catch(error){showError('#editItemError',error?.message||'Не удалось изменить тайтл.');}
    finally{setBusy(submit,false,'Сохранить');}
  }

  async function loadComments(){
    state.commentsLoaded=false;renderComments();
    try{
      const payload=await api(`/api/collections/${encodeURIComponent(state.id)}/comments`);
      state.comments=Array.isArray(payload?.comments)?payload.comments:[];state.commentsLoaded=true;renderComments();
    }catch(error){
      state.commentsLoaded=true;renderComments(error?.message||'Не удалось загрузить комментарии.');
    }
  }

  function renderComments(errorMessage=''){
    const host=$('#collectionComments');if(!host)return;
    setText('#commentCount',String(state.comments.length));
    if(errorMessage){host.innerHTML=`<div class="collection-comments-status collection-comments-error"><i data-lucide="triangle-alert"></i><span>${esc(errorMessage)}</span></div>`;refreshIcons();return;}
    if(!state.commentsLoaded){host.innerHTML='<div class="collection-comments-status">Загрузка комментариев…</div>';return;}
    if(!state.comments.length){host.innerHTML='<div class="collection-comments-status"><i data-lucide="message-circle"></i><span>Комментариев пока нет. Будьте первым.</span></div>';refreshIcons();return;}
    host.innerHTML=state.comments.map(commentCard).join('');refreshIcons();
  }

  function commentCard(comment){
    const author=comment?.author?.username?`@${comment.author.username}`:(comment?.author?.firstName||'Пользователь');
    const remove=comment?.canDelete?`<button class="collection-comment-delete" type="button" data-comment-id="${esc(comment.id||'')}" aria-label="Удалить комментарий"><i data-lucide="trash-2"></i></button>`:'';
    const own=comment?.isOwn?'<span class="collection-comment-own">Вы</span>':'';
    return `<article class="collection-comment-card"><div class="collection-comment-meta"><div><strong>${esc(author)}</strong>${own}<time datetime="${esc(comment.createdAt||'')}">${esc(formatDateTime(comment.createdAt))}</time></div>${remove}</div><p>${esc(comment.body||'')}</p></article>`;
  }

  function renderCommentComposer(){
    const user=state.bootstrap?.user||null;const body=$('#commentBody'),submit=$('#commentSubmit'),hint=$('#commentLoginHint');
    if(body)body.disabled=!user;if(submit)submit.disabled=!user;
    if(hint)hint.textContent=user?'Комментарий будет опубликован от вашего Telegram-профиля.':'Войдите через Telegram, чтобы оставить комментарий.';
  }

  async function submitComment(event){
    event.preventDefault();clearError('#commentError');
    if(!state.bootstrap?.user){showError('#commentError','Требуется вход через Telegram.');return;}
    const body=($('#commentBody')?.value||'').trim();
    if(!body){showError('#commentError','Введите текст комментария.');return;}
    if(body.length>3000){showError('#commentError','Комментарий не должен превышать 3000 символов.');return;}
    const submit=$('#commentSubmit');setBusy(submit,true,'Отправка…');
    try{
      const payload=await api(`/api/collections/${encodeURIComponent(state.id)}/comments`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body})});
      state.comments=Array.isArray(payload?.comments)?payload.comments:state.comments;state.commentsLoaded=true;
      const field=$('#commentBody');if(field)field.value='';renderComments();
    }catch(error){showError('#commentError',error?.message||'Не удалось отправить комментарий.');}
    finally{setBusy(submit,false,'Отправить');renderCommentComposer();}
  }

  async function handleCommentClick(event){
    const button=event.target.closest('[data-comment-id]');if(!button)return;
    const commentId=button.dataset.commentId||'';if(!commentId)return;
    button.disabled=true;clearError('#commentError');
    try{
      const payload=await api(`/api/collections/${encodeURIComponent(state.id)}/comments`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({commentId})});
      state.comments=Array.isArray(payload?.comments)?payload.comments:state.comments;state.commentsLoaded=true;renderComments();
    }catch(error){button.disabled=false;showError('#commentError',error?.message||'Не удалось удалить комментарий.');}
  }

  function renderFatal(message){
    setText('#collectionTitle','Коллекция недоступна');setText('#collectionDescription',message);
    const host=$('#collectionGroups');if(host)host.innerHTML=emptyState('triangle-alert','Не удалось открыть коллекцию',message);
    const comments=$('#collectionComments');if(comments)comments.innerHTML=`<div class="collection-comments-status collection-comments-error">${esc(message)}</div>`;
    const commentBody=$('#commentBody'),commentSubmit=$('#commentSubmit');if(commentBody)commentBody.disabled=true;if(commentSubmit)commentSubmit.disabled=true;
    $('#ownerActions')?.classList.add('hidden');refreshIcons();
  }

  function openDialog(selector){const dialog=$(selector);if(typeof dialog?.showModal==='function')dialog.showModal();refreshIcons();}
  function closeDialog(selector){const dialog=$(selector);if(dialog?.open)dialog.close();}
  function showInlineError(message){const host=$('#collectionGroups');if(!host)return;const note=document.createElement('div');note.className='collection-inline-error';note.textContent=message;host.prepend(note);setTimeout(()=>note.remove(),4500);}
  function showError(selector,message){const host=$(selector);if(host){host.textContent=message;host.classList.remove('hidden');}}
  function clearError(selector){const host=$(selector);if(host){host.textContent='';host.classList.add('hidden');}}
  function setBusy(button,busy,label){if(button){button.disabled=busy;button.textContent=label;}}
  function setText(selector,value){const node=$(selector);if(node)node.textContent=value;}

  function renderSession(){
    const user=state.bootstrap?.user;$('#adminLink')?.classList.toggle('hidden',!Boolean(state.bootstrap?.isAdmin));$('#logoutButton')?.classList.toggle('hidden',!user);
    const account=$('#accountName'),panel=$('#loginPanel');
    if(user){if(account)account.textContent=user.username?`@${user.username}`:user.firstName;if(panel)panel.innerHTML='<span class="login-ready">Telegram-сессия активна</span>';}
    else{if(account)account.textContent='Войти';mountTelegramLogin();}renderCommentComposer();refreshIcons();
  }
  function renderSessionError(){const account=$('#accountName');if(account)account.textContent='Войти';const panel=$('#loginPanel');if(panel)panel.innerHTML='<span class="login-ready">Авторизация временно недоступна</span>';renderCommentComposer();}
  function mountTelegramLogin(){const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;const bot=state.bootstrap?.botUsername;if(!bot){host.textContent='BOT_USERNAME не настроен.';return;}host.dataset.ready='1';host.innerHTML='';const script=document.createElement('script');script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';host.append(script);}

  function titleCountLabel(count){const mod10=count%10,mod100=count%100;const word=mod10===1&&mod100!==11?'тайтл':mod10>=2&&mod10<=4&&(mod100<12||mod100>14)?'тайтла':'тайтлов';return`${count} ${word}`;}
  function formatDate(value){if(!value)return'—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'short',year:'numeric'}).format(date);}
  function formatDateTime(value){if(!value)return'—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(date);}
  function emptyState(icon,title,message){return`<div class="collection-detail-empty"><i data-lucide="${icon}"></i><strong>${esc(title)}</strong><span>${esc(message)}</span></div>`;}

  document.addEventListener('DOMContentLoaded',boot);
})();
