(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const ref=new URLSearchParams(location.search).get('ref')||'';
  const state={session:null,comments:[],sort:'new',replyTo:null,loaded:false,busy:false};

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  async function boot(){
    bindTabs();bindComposer();bindList();bindSort();
    try{state.session=await api('/api/auth/session');}catch{state.session=null;}
    renderComposer();
  }

  function bindTabs(){
    document.querySelectorAll('[data-title-tab]').forEach((button)=>{
      button.addEventListener('click',()=>{
        const tab=button.dataset.titleTab||'';
        if(tab==='comments'){
          activateCommentsTab();
          if(!state.loaded)void loadTitleComments();
        }else{
          $('#titleCommentsPanel')?.classList.add('hidden');
          const commentsTab=$('[data-title-tab="comments"]');
          commentsTab?.classList.remove('active');
          commentsTab?.setAttribute('aria-selected','false');
        }
      });
    });
  }

  function activateCommentsTab(){
    document.querySelectorAll('[data-title-tab]').forEach((button)=>{
      const active=button.dataset.titleTab==='comments';
      button.classList.toggle('active',active);
      if(!button.disabled)button.setAttribute('aria-selected',String(active));
    });
    $('#titleAboutPanel')?.classList.add('hidden');
    $('#titleChaptersPanel')?.classList.add('hidden');
    $('#titleCommentsPanel')?.classList.remove('hidden');
  }

  function bindComposer(){
    $('#titleCommentForm')?.addEventListener('submit',(event)=>{event.preventDefault();void submitComment();});
    $('#titleReplyCancel')?.addEventListener('click',()=>{state.replyTo=null;renderReplyTarget();$('#titleCommentText')?.focus();});
  }

  function bindSort(){
    $('#titleCommentsNew')?.addEventListener('click',()=>void changeSort('new'));
    $('#titleCommentsTop')?.addEventListener('click',()=>void changeSort('top'));
  }

  function bindList(){
    $('#titleCommentsList')?.addEventListener('click',(event)=>{
      const target=event.target instanceof Element?event.target.closest('[data-comment-action]'):null;
      if(!target)return;
      const id=target.getAttribute('data-comment-id')||'';
      const action=target.getAttribute('data-comment-action')||'';
      const comment=state.comments.find((item)=>item.id===id);
      if(!comment)return;
      if(action==='reply')startReply(comment);
      if(action==='up')void voteComment(comment,1);
      if(action==='down')void voteComment(comment,-1);
      if(action==='delete')void deleteComment(comment);
      if(action==='report')void reportComment(comment);
      if(action==='pin')void pinComment(comment);
    });
  }

  async function changeSort(sort){
    if(sort===state.sort)return;
    state.sort=sort;
    $('#titleCommentsNew')?.classList.toggle('active',sort==='new');
    $('#titleCommentsTop')?.classList.toggle('active',sort==='top');
    await loadTitleComments(true);
  }

  async function loadTitleComments(force=false){
    if(state.busy||(!force&&state.loaded))return;
    state.busy=true;setMessage('Загружаем комментарии…');
    try{
      const payload=await api(`/api/title/comments?ref=${encodeURIComponent(ref)}&sort=${encodeURIComponent(state.sort)}`);
      applyPayload(payload);state.loaded=true;setMessage('');
    }catch(error){setMessage(error.message||'Не удалось загрузить комментарии.');}
    finally{state.busy=false;renderComposer();}
  }

  function applyPayload(payload){
    state.comments=Array.isArray(payload?.comments)?payload.comments:[];
    if(payload?.sort==='top'||payload?.sort==='new')state.sort=payload.sort;
    $('#titleCommentsNew')?.classList.toggle('active',state.sort==='new');
    $('#titleCommentsTop')?.classList.toggle('active',state.sort==='top');
    renderTitleComments();
  }

  function renderTitleComments(){
    const host=$('#titleCommentsList');if(!host)return;
    if(!state.comments.length){host.innerHTML='<div class="title-comments-empty"><strong>Комментариев пока нет</strong><span>Будьте первым, кто обсудит этот тайтл.</span></div>';return;}
    const children=new Map();
    const ids=new Set(state.comments.map((comment)=>comment.id));
    for(const comment of state.comments){
      const parent=comment.parentCommentId&&ids.has(comment.parentCommentId)?comment.parentCommentId:null;
      if(!children.has(parent))children.set(parent,[]);
      children.get(parent).push(comment);
    }
    const renderBranch=(parent,depth=0)=>(children.get(parent)||[]).map((comment)=>`${renderComment(comment,depth)}${renderBranch(comment.id,Math.min(depth+1,4))}`).join('');
    host.innerHTML=renderBranch(null);
    refreshIcons();
  }

  function renderComment(comment,depth){
    const deleted=Boolean(comment.deleted);
    const author=comment.author?.username?`@${comment.author.username}`:(comment.author?.firstName||'Читатель');
    const score=Number(comment.score)||0;
    const myVote=Number(comment.myVote)||0;
    const canDelete=Boolean(comment.canDelete);
    const canPin=Boolean(comment.canPin);
    const canReport=Boolean(comment.canReport);
    const actions=deleted?'':[
      `<button type="button" data-comment-action="up" data-comment-id="${esc(comment.id)}" class="${myVote===1?'active':''}" aria-label="Нравится"><i data-lucide="chevron-up"></i></button>`,
      `<span class="title-comment-score">${score}</span>`,
      `<button type="button" data-comment-action="down" data-comment-id="${esc(comment.id)}" class="${myVote===-1?'active':''}" aria-label="Не нравится"><i data-lucide="chevron-down"></i></button>`,
      state.session?.user?`<button type="button" data-comment-action="reply" data-comment-id="${esc(comment.id)}">Ответить</button>`:'',
      canReport?`<button type="button" data-comment-action="report" data-comment-id="${esc(comment.id)}">${comment.reportedByMe?'Жалоба отправлена':'Пожаловаться'}</button>`:'',
      canPin?`<button type="button" data-comment-action="pin" data-comment-id="${esc(comment.id)}">${comment.pinned?'Открепить':'Закрепить'}</button>`:'',
      canDelete?`<button type="button" data-comment-action="delete" data-comment-id="${esc(comment.id)}">Удалить</button>`:'',
    ].filter(Boolean).join('');
    return `<article class="title-comment-card${comment.pinned?' is-pinned':''}${deleted?' is-deleted':''}" style="--comment-depth:${depth}">
      <header class="title-comment-head"><strong>${esc(author)}</strong>${comment.pinned?'<span class="title-comment-pin"><i data-lucide="pin"></i> Закреплён</span>':''}<time>${esc(formatTime(comment.createdAt))}</time></header>
      <div class="title-comment-body">${deleted?'<em>Комментарий удалён.</em>':esc(comment.body)}</div>
      ${actions?`<div class="title-comment-actions">${actions}</div>`:''}
    </article>`;
  }

  function startReply(comment){
    if(!state.session?.user)return;
    state.replyTo=comment;renderReplyTarget();
    const field=$('#titleCommentText');if(field){field.focus();field.scrollIntoView({block:'nearest'});}
  }

  function renderReplyTarget(){
    const host=$('#titleReplyTarget'),cancel=$('#titleReplyCancel');if(!host)return;
    if(!state.replyTo){host.classList.add('hidden');host.textContent='';cancel?.classList.add('hidden');return;}
    const author=state.replyTo.author?.username?`@${state.replyTo.author.username}`:(state.replyTo.author?.firstName||'читателю');
    host.textContent=`Ответ ${author}`;host.classList.remove('hidden');cancel?.classList.remove('hidden');
  }

  function renderComposer(){
    const signedIn=Boolean(state.session?.user);
    const field=$('#titleCommentText'),submit=$('#titleCommentSubmit'),hint=$('#titleCommentLoginHint');
    if(field)field.disabled=!signedIn||state.busy;
    if(submit)submit.disabled=!signedIn||state.busy;
    if(hint)hint.textContent=signedIn?'Публикация от вашего Telegram-профиля.':'Войдите через Telegram, чтобы комментировать.';
    renderReplyTarget();
  }

  async function submitComment(){
    const field=$('#titleCommentText');const body=(field?.value||'').trim();
    if(!state.session?.user||!body||state.busy)return;
    state.busy=true;renderComposer();setMessage('Отправляем…');
    try{
      const payload=await api('/api/title/comments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bookRef:ref,body,parentCommentId:state.replyTo?.id||null,sort:state.sort})});
      if(field)field.value='';state.replyTo=null;applyPayload(payload);setMessage('');
    }catch(error){setMessage(error.message||'Не удалось отправить комментарий.');}
    finally{state.busy=false;renderComposer();}
  }

  async function voteComment(comment,value){
    if(!state.session?.user||state.busy)return;
    const next=Number(comment.myVote)===value?0:value;
    await mutateComment(`/api/title/comments/${encodeURIComponent(comment.id)}/vote`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({value:next,sort:state.sort})});
  }

  async function deleteComment(comment){
    if(!comment.canDelete||state.busy)return;
    if(!window.confirm('Удалить комментарий?'))return;
    await mutateComment(`/api/title/comments/${encodeURIComponent(comment.id)}`,{method:'DELETE'});
  }

  async function reportComment(comment){
    if(!comment.canReport||state.busy)return;
    const reason=window.prompt('Причина жалобы (необязательно):','');
    if(reason===null)return;
    await mutateComment(`/api/title/comments/${encodeURIComponent(comment.id)}/report`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason,sort:state.sort})});
  }

  async function pinComment(comment){
    if(!comment.canPin||state.busy)return;
    await mutateComment(`/api/title/comments/${encodeURIComponent(comment.id)}/pin`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({pinned:!comment.pinned,sort:state.sort})});
  }

  async function mutateComment(path,options){
    state.busy=true;renderComposer();setMessage('Сохраняем…');
    try{const payload=await api(path,options);applyPayload(payload);setMessage('');}
    catch(error){setMessage(error.message||'Не удалось выполнить действие.');}
    finally{state.busy=false;renderComposer();}
  }

  function setMessage(value){const node=$('#titleCommentsMessage');if(node)node.textContent=value;}
  function formatTime(value){if(!value)return'';const date=new Date(value);if(!Number.isFinite(date.getTime()))return'';return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(date);}
  document.addEventListener('DOMContentLoaded',boot);
})();
