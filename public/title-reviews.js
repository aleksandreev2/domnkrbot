(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const ref=new URLSearchParams(location.search).get('ref')||'';
  const state={session:null,reviews:[],sort:'new',loaded:false,busy:false,editingId:null};

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
        if(tab==='reviews'){
          activateReviewsTab();
          if(!state.loaded)void loadTitleReviews();
        }else{
          $('#titleReviewsPanel')?.classList.add('hidden');
          const reviewsTab=$('[data-title-tab="reviews"]');
          reviewsTab?.classList.remove('active');
          reviewsTab?.setAttribute('aria-selected','false');
        }
      });
    });
  }

  function activateReviewsTab(){
    document.querySelectorAll('[data-title-tab]').forEach((button)=>{
      const active=button.dataset.titleTab==='reviews';
      button.classList.toggle('active',active);
      if(!button.disabled)button.setAttribute('aria-selected',String(active));
    });
    $('#titleAboutPanel')?.classList.add('hidden');
    $('#titleChaptersPanel')?.classList.add('hidden');
    $('#titleCommentsPanel')?.classList.add('hidden');
    $('#titleReviewsPanel')?.classList.remove('hidden');
  }

  function bindComposer(){
    $('#titleWriteReview')?.addEventListener('click',()=>openComposer());
    $('#titleReviewCancel')?.addEventListener('click',closeComposer);
    $('#titleReviewForm')?.addEventListener('submit',(event)=>{event.preventDefault();void submitReview();});
  }

  function bindSort(){
    $('#titleReviewsNew')?.addEventListener('click',()=>void changeSort('new'));
    $('#titleReviewsTop')?.addEventListener('click',()=>void changeSort('top'));
  }

  function bindList(){
    $('#titleReviewsList')?.addEventListener('click',(event)=>{
      const target=event.target instanceof Element?event.target.closest('[data-review-action]'):null;
      if(!target)return;
      const id=target.getAttribute('data-review-id')||'';
      const action=target.getAttribute('data-review-action')||'';
      const review=state.reviews.find((item)=>item.id===id);
      if(!review)return;
      if(action==='edit')openComposer(review);
      if(action==='delete')void deleteReview(review);
      if(action==='vote')void voteReview(review);
    });
  }

  async function changeSort(sort){
    if(sort===state.sort)return;
    state.sort=sort;
    $('#titleReviewsNew')?.classList.toggle('active',sort==='new');
    $('#titleReviewsTop')?.classList.toggle('active',sort==='top');
    await loadTitleReviews(true);
  }

  async function loadTitleReviews(force=false){
    if(state.busy||(!force&&state.loaded))return;
    state.busy=true;setMessage('Загружаем отзывы…');renderComposer();
    try{
      const payload=await api(`/api/title/reviews?ref=${encodeURIComponent(ref)}&sort=${encodeURIComponent(state.sort)}`);
      applyPayload(payload);state.loaded=true;setMessage('');
    }catch(error){setMessage(error.message||'Не удалось загрузить отзывы.');}
    finally{state.busy=false;renderComposer();}
  }

  function applyPayload(payload){
    state.reviews=Array.isArray(payload?.reviews)?payload.reviews:[];
    if(payload?.sort==='top'||payload?.sort==='new')state.sort=payload.sort;
    $('#titleReviewsNew')?.classList.toggle('active',state.sort==='new');
    $('#titleReviewsTop')?.classList.toggle('active',state.sort==='top');
    renderTitleReviews();
  }

  function renderTitleReviews(){
    const host=$('#titleReviewsList');if(!host)return;
    if(!state.reviews.length){host.innerHTML='<div class="title-reviews-empty"><strong>Отзывов пока нет</strong><span>Станьте первым читателем, который поделится впечатлением.</span></div>';return;}
    host.innerHTML=state.reviews.map(renderReview).join('');
    refreshIcons();
  }

  function renderReview(review){
    const author=review.author?.username?`@${review.author.username}`:(review.author?.firstName||'Читатель');
    const myVote=Number(review.myVote)||0;
    const score=Number(review.score)||0;
    const owner=Boolean(review.isOwn);
    const canDelete=Boolean(review.canDelete);
    return `<article class="title-review-card">
      <header class="title-review-head"><div><strong>${esc(author)}</strong><time>${esc(formatTime(review.updatedAt||review.createdAt))}</time></div>${owner?'<span class="title-review-owner">Ваш отзыв</span>':''}</header>
      <div class="title-review-body">${esc(review.body)}</div>
      <div class="title-review-actions">
        <button type="button" data-review-action="vote" data-review-id="${esc(review.id)}" class="title-review-vote${myVote===1?' active':''}" ${state.session?.user?'':'disabled'} aria-pressed="${myVote===1?'true':'false'}"><i data-lucide="thumbs-up"></i><span>Полезно</span><strong>${score}</strong></button>
        ${owner?`<button type="button" data-review-action="edit" data-review-id="${esc(review.id)}">Редактировать</button>`:''}
        ${canDelete?`<button type="button" data-review-action="delete" data-review-id="${esc(review.id)}">Удалить</button>`:''}
      </div>
    </article>`;
  }

  function ownReview(){return state.reviews.find((review)=>review.isOwn)||null;}

  function openComposer(review=null){
    if(!state.session?.user){setMessage('Войдите через Telegram в меню профиля, чтобы написать отзыв.');return;}
    const current=review||ownReview();
    state.editingId=current?.id||null;
    const field=$('#titleReviewText');if(field)field.value=current?.body||'';
    $('#titleReviewForm')?.classList.remove('hidden');
    const submit=$('#titleReviewSubmit');if(submit)submit.textContent=state.editingId?'Сохранить':'Опубликовать';
    field?.focus();field?.scrollIntoView({block:'nearest'});
    renderComposer();
  }

  function closeComposer(){
    state.editingId=null;
    const field=$('#titleReviewText');if(field)field.value='';
    $('#titleReviewForm')?.classList.add('hidden');
    const submit=$('#titleReviewSubmit');if(submit)submit.textContent='Опубликовать';
    renderComposer();
  }

  function renderComposer(){
    const signedIn=Boolean(state.session?.user);
    const existing=ownReview();
    const write=$('#titleWriteReview');
    if(write){write.disabled=state.busy;write.textContent=existing?'Редактировать отзыв':'Написать отзыв';}
    const field=$('#titleReviewText'),submit=$('#titleReviewSubmit'),hint=$('#titleReviewLoginHint');
    if(field)field.disabled=!signedIn||state.busy;
    if(submit)submit.disabled=!signedIn||state.busy;
    if(hint)hint.textContent=signedIn?'Отзыв публикуется от вашего Telegram-профиля.':'Войдите через Telegram, чтобы написать отзыв.';
  }

  async function submitReview(){
    const field=$('#titleReviewText');const body=(field?.value||'').trim();
    if(!state.session?.user||!body||state.busy)return;
    state.busy=true;renderComposer();setMessage('Сохраняем отзыв…');
    const editing=state.editingId;
    try{
      const path=editing?`/api/title/reviews/${encodeURIComponent(editing)}`:'/api/title/reviews';
      const payload=await api(path,{method:editing?'PATCH':'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bookRef:ref,body,sort:state.sort})});
      applyPayload(payload);closeComposer();setMessage('');
    }catch(error){setMessage(error.message||'Не удалось сохранить отзыв.');}
    finally{state.busy=false;renderComposer();}
  }

  async function deleteReview(review){
    if(!review.canDelete||state.busy)return;
    if(!window.confirm('Удалить отзыв?'))return;
    state.busy=true;renderComposer();setMessage('Удаляем отзыв…');
    try{
      await api(`/api/title/reviews/${encodeURIComponent(review.id)}`,{method:'DELETE'});
      closeComposer();await loadTitleReviews(true);setMessage('');
    }catch(error){setMessage(error.message||'Не удалось удалить отзыв.');}
    finally{state.busy=false;renderComposer();}
  }

  async function voteReview(review){
    if(!state.session?.user||state.busy)return;
    const value=Number(review.myVote)===1?0:1;
    state.busy=true;renderComposer();
    try{
      const payload=await api(`/api/title/reviews/${encodeURIComponent(review.id)}/vote`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({value,sort:state.sort})});
      applyPayload(payload);setMessage('');
    }catch(error){setMessage(error.message||'Не удалось оценить отзыв.');}
    finally{state.busy=false;renderComposer();}
  }

  function setMessage(value){const node=$('#titleReviewsMessage');if(node)node.textContent=value;}
  function formatTime(value){if(!value)return'';const date=new Date(value);if(!Number.isFinite(date.getTime()))return'';return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(date);}
  document.addEventListener('DOMContentLoaded',boot);
})();
