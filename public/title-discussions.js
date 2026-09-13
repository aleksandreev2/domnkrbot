(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const ref=new URLSearchParams(location.search).get('ref')||'';
  const DISCUSSION_SECTION_QUERY='section=discussions';
  const state={session:null,discussions:[],loaded:false,busy:false};

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  function ensureStyles(){
    if(document.querySelector('link[data-title-discussions-style]'))return;
    const link=document.createElement('link');
    link.rel='stylesheet';link.href='/title-discussions.css?v=20260913-discussions2';link.dataset.titleDiscussionsStyle='1';
    document.head.append(link);
  }

  function ensureDiscussionSurface(){
    const tab=$('[data-title-tab="discussions"]');
    if(tab){tab.disabled=false;tab.removeAttribute('disabled');tab.removeAttribute('aria-disabled');tab.removeAttribute('title');tab.setAttribute('aria-selected','false');tab.setAttribute('aria-controls','titleDiscussionsPanel');}
    if($('#titleDiscussionsPanel'))return;
    const reviews=$('#titleReviewsPanel');
    const comments=$('#titleCommentsPanel');
    const host=reviews?.parentElement||comments?.parentElement;
    if(!host)return;
    const panel=document.createElement('section');
    panel.id='titleDiscussionsPanel';panel.className='title-tab-panel title-discussions-shell hidden';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-label','Обсуждения тайтла');
    panel.innerHTML=`
      <div class="title-discussion-toolbar">
        <select id="titleDiscussionSort" class="title-discussion-sort" aria-label="Сортировка обсуждений"><option value="updates">Обновления</option></select>
        <button id="titleDiscussionNew" class="title-discussion-new" type="button">Новая тема</button>
      </div>
      <form id="titleDiscussionComposer" class="title-discussion-composer hidden">
        <input id="titleDiscussionTitle" maxlength="140" autocomplete="off" placeholder="Заголовок темы" aria-label="Заголовок темы">
        <textarea id="titleDiscussionBody" rows="5" maxlength="6000" placeholder="О чём хотите поговорить?" aria-label="Текст темы"></textarea>
        <div class="title-discussion-composer-actions"><span id="titleDiscussionLoginHint"></span><div><button id="titleDiscussionCancel" type="button">Отмена</button><button type="submit">Создать тему</button></div></div>
      </form>
      <div id="titleDiscussionMessage" class="title-discussion-message" role="status" aria-live="polite"></div>
      <div id="titleDiscussionList" class="title-discussion-list"></div>`;
    if(reviews)host.insertBefore(panel,reviews);else host.append(panel);
  }

  async function boot(){
    ensureStyles();ensureDiscussionSurface();bindTabs();bindComposer();
    try{state.session=await api('/api/auth/session');}catch{state.session=null;}
    renderComposer();
    if(new URLSearchParams(location.search).get('section')==='discussions')activateInitialDiscussionWhenReady();
  }

  function activateInitialDiscussionWhenReady(attempt=0){
    if(new URLSearchParams(location.search).get('section')!=='discussions')return;
    const app=$('#titleApp');
    if(app&&!app.classList.contains('hidden')){
      activateDiscussionsTab();
      if(!state.loaded)void loadTitleDiscussions();
      return;
    }
    if(attempt<100)setTimeout(()=>activateInitialDiscussionWhenReady(attempt+1),50);
  }

  function bindTabs(){
    document.querySelectorAll('[data-title-tab]').forEach((button)=>{
      button.addEventListener('click',()=>{
        const tab=button.dataset.titleTab||'';
        if(tab==='discussions'){
          activateDiscussionsTab();syncDiscussionSection(true);
          if(!state.loaded)void loadTitleDiscussions();
        }else{
          $('#titleDiscussionsPanel')?.classList.add('hidden');
          const discussionsTab=$('[data-title-tab="discussions"]');
          discussionsTab?.classList.remove('active');discussionsTab?.setAttribute('aria-selected','false');
          syncDiscussionSection(false);
        }
      });
    });
  }

  function syncDiscussionSection(active){
    const params=new URLSearchParams(location.search);
    const [key,value]=DISCUSSION_SECTION_QUERY.split('=');
    if(active)params.set(key,value);else if(params.get(key)===value)params.delete(key);
    const query=params.toString();
    history.replaceState(history.state,'',`${location.pathname}${query?`?${query}`:''}${location.hash}`);
  }

  function activateDiscussionsTab(){
    document.querySelectorAll('[data-title-tab]').forEach((button)=>{
      const active=button.dataset.titleTab==='discussions';
      button.classList.toggle('active',active);
      if(!button.disabled)button.setAttribute('aria-selected',String(active));
    });
    $('#titleAboutPanel')?.classList.add('hidden');
    $('#titleChaptersPanel')?.classList.add('hidden');
    $('#titleCommentsPanel')?.classList.add('hidden');
    $('#titleReviewsPanel')?.classList.add('hidden');
    $('#titleDiscussionsPanel')?.classList.remove('hidden');
  }

  function bindComposer(){
    $('#titleDiscussionNew')?.addEventListener('click',()=>openComposer());
    $('#titleDiscussionCancel')?.addEventListener('click',closeComposer);
    $('#titleDiscussionComposer')?.addEventListener('submit',(event)=>{event.preventDefault();void createDiscussion();});
  }

  function openComposer(){
    if(!state.session?.user){setMessage('Войдите через Telegram, чтобы создать тему.');return;}
    $('#titleDiscussionComposer')?.classList.remove('hidden');
    $('#titleDiscussionTitle')?.focus();renderComposer();
  }

  function closeComposer(){
    const title=$('#titleDiscussionTitle'),body=$('#titleDiscussionBody');
    if(title)title.value='';if(body)body.value='';
    $('#titleDiscussionComposer')?.classList.add('hidden');renderComposer();
  }

  function renderComposer(){
    const signedIn=Boolean(state.session?.user);
    const hint=$('#titleDiscussionLoginHint');
    if(hint)hint.textContent=signedIn?'Тема публикуется от вашего Telegram-профиля.':'Войдите через Telegram, чтобы создать тему.';
    const submit=$('#titleDiscussionComposer button[type="submit"]');if(submit)submit.disabled=!signedIn||state.busy;
    const create=$('#titleDiscussionNew');if(create)create.disabled=state.busy;
  }

  async function loadTitleDiscussions(force=false){
    if(state.busy||(!force&&state.loaded))return;
    state.busy=true;setMessage('Загружаем обсуждения…');renderComposer();
    try{
      const payload=await api(`/api/title/discussions?ref=${encodeURIComponent(ref)}`);
      state.discussions=Array.isArray(payload?.discussions)?payload.discussions:[];
      state.loaded=true;renderTitleDiscussions();setMessage('');
    }catch(error){setMessage(error.message||'Не удалось загрузить обсуждения.');}
    finally{state.busy=false;renderComposer();}
  }

  async function createDiscussion(){
    const title=($('#titleDiscussionTitle')?.value||'').trim();
    const body=($('#titleDiscussionBody')?.value||'').trim();
    if(!state.session?.user||!title||!body||state.busy)return;
    state.busy=true;setMessage('Создаём тему…');renderComposer();
    try{
      const payload=await api('/api/title/discussions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bookRef:ref,title,body,category:'Обсуждение тайтла'})});
      state.discussions=Array.isArray(payload?.discussions)?payload.discussions:[];state.loaded=true;closeComposer();renderTitleDiscussions();setMessage('');
    }catch(error){setMessage(error.message||'Не удалось создать тему.');}
    finally{state.busy=false;renderComposer();}
  }

  function discussionUrl(discussion){
    return `/discussion/?id=${encodeURIComponent(discussion?.id||'')}`;
  }

  function renderTitleDiscussions(){
    const host=$('#titleDiscussionList');if(!host)return;
    if(!state.discussions.length){host.innerHTML='<div class="title-discussion-empty"><strong>Обсуждений пока нет</strong><span>Создайте первую тему об этом тайтле.</span></div>';return;}
    host.innerHTML=state.discussions.map((discussion)=>{
      const author=discussion.author?.username?`@${discussion.author.username}`:(discussion.author?.firstName||'Читатель');
      const replyCount=Math.max(0,Number(discussion.replyCount)||0);
      return `<article class="title-discussion-card"><a class="title-discussion-card-link" href="${esc(discussionUrl(discussion))}"><div class="title-discussion-copy"><h3>${esc(discussion.title)}</h3><div class="title-discussion-meta"><strong>${esc(author)}</strong><time>${esc(formatTime(discussion.updatedAt||discussion.createdAt))}</time><span class="title-discussion-category">${esc(discussion.category||'Обсуждение тайтла')}</span></div><p class="title-discussion-preview">${esc(discussion.body)}</p></div><div class="title-discussion-metrics" title="Ответов"><i data-lucide="message-square"></i><span>${replyCount}</span></div></a></article>`;
    }).join('');refreshIcons();
  }

  function setMessage(value){const node=$('#titleDiscussionMessage');if(node)node.textContent=value;}
  function formatTime(value){if(!value)return'';const date=new Date(value);if(!Number.isFinite(date.getTime()))return'';const diff=Math.max(0,Date.now()-date.getTime());const mins=Math.max(1,Math.round(diff/60000));if(mins<60)return`${mins} мин. назад`;const hours=Math.round(mins/60);if(hours<24)return`${hours} ч. назад`;const days=Math.round(hours/24);if(days<30)return`${days} дн. назад`;return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}).format(date);}

  document.addEventListener('DOMContentLoaded',boot);
})();
