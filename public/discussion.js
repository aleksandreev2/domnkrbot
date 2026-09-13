(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const discussionId=new URLSearchParams(location.search).get('id')||'';
  const state={session:null,discussion:null,replies:[],busy:false};

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  async function boot(){
    bind();refreshIcons();
    if(!discussionId){showError('Некорректная ссылка на обсуждение.');return;}
    try{
      const [session,payload]=await Promise.all([
        api('/api/auth/session').catch(()=>null),
        api(`/api/title/discussions/${encodeURIComponent(discussionId)}`),
      ]);
      state.session=session;applyPayload(payload);renderSession();render();
    }catch(error){showError(error.message||'Не удалось открыть обсуждение.');}
  }

  function bind(){
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
    $('#mobileMenuButton')?.addEventListener('click',()=>$('#primaryNav')?.classList.toggle('open'));
    $('#discussionReplyForm')?.addEventListener('submit',(event)=>{event.preventDefault();void submitReply();});
    window.addEventListener('keydown',(event)=>{if(event.key==='Escape')$('#primaryNav')?.classList.remove('open');});
  }

  function applyPayload(payload){
    state.discussion=payload?.discussion||null;
    state.replies=Array.isArray(payload?.replies)?payload.replies:[];
  }

  function renderSession(){
    const user=state.session?.user;
    $('#adminLink')?.classList.toggle('hidden',!Boolean(state.session?.isAdmin));
    $('#logoutButton')?.classList.toggle('hidden',!user);
    const account=$('#accountName'),panel=$('#loginPanel');
    if(user){account.textContent=user.username?`@${user.username}`:user.firstName;panel.innerHTML='<span class="login-ready">Telegram-сессия активна</span>';}
    else{account.textContent='Войти';mountLogin();}
    renderComposer();refreshIcons();
  }

  function mountLogin(){
    const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;
    const bot=state.session?.botUsername;if(!bot){host.textContent='BOT_USERNAME не настроен.';return;}
    host.dataset.ready='1';
    const script=document.createElement('script');script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';host.append(script);
  }

  function render(){
    const discussion=state.discussion;if(!discussion){showError('Обсуждение не найдено.');return;}
    document.title=`${discussion.title||'Обсуждение'} · НекромантЛиб`;
    $('#discussionLoading')?.classList.add('hidden');$('#discussionError')?.classList.add('hidden');$('#discussionApp')?.classList.remove('hidden');
    setText('#discussionTitle',discussion.title||'Обсуждение');setText('#discussionBody',discussion.body||'');setText('#discussionCategory',discussion.category||'Обсуждение тайтла');
    setText('#discussionAuthor',authorName(discussion.author));setText('#discussionCreated',formatTime(discussion.createdAt));
    const titleUrl=`/title/?ref=${encodeURIComponent(discussion.bookRef||'')}&section=discussions`;
    const relation=$('#discussionRelation'),crumb=$('#discussionTitleLink');
    if(relation)relation.href=titleUrl;
    if(crumb){crumb.href=titleUrl;crumb.textContent='Тайтл';}
    setText('#discussionReplyCount',String(state.replies.length));
    renderReplies();renderComposer();refreshIcons();
  }

  function renderComposer(){
    const signedIn=Boolean(state.session?.user),textarea=$('#discussionReplyText'),submit=$('#discussionReplySubmit'),hint=$('#discussionReplyHint');
    if(textarea)textarea.disabled=!signedIn||state.busy;
    if(submit)submit.disabled=!signedIn||state.busy;
    if(hint)hint.textContent=signedIn?'Комментарий публикуется от вашего Telegram-профиля.':'Войдите через Telegram, чтобы ответить.';
  }

  function renderReplies(){
    const host=$('#discussionReplies');if(!host)return;
    if(!state.replies.length){host.innerHTML='<div class="discussion-empty"><strong>Комментариев пока нет</strong><span>Станьте первым, кто ответит в этой теме.</span></div>';return;}
    host.innerHTML=state.replies.map((reply)=>`<article class="discussion-reply-card"><div class="discussion-reply-avatar" aria-hidden="true">${esc(authorInitial(reply.author))}</div><div class="discussion-reply-copy"><div class="discussion-reply-meta"><strong>${esc(authorName(reply.author))}</strong><time>${esc(formatTime(reply.createdAt))}</time></div><p>${esc(reply.body)}</p></div></article>`).join('');
  }

  async function submitReply(){
    const textarea=$('#discussionReplyText');const body=(textarea?.value||'').trim();
    if(!state.session?.user||!body||state.busy)return;
    state.busy=true;setMessage('Отправляем комментарий…');renderComposer();
    try{
      const payload=await api(`/api/title/discussions/${encodeURIComponent(discussionId)}/replies`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body})});
      applyPayload(payload);if(textarea)textarea.value='';render();setMessage('');
    }catch(error){setMessage(error.message||'Не удалось отправить комментарий.');}
    finally{state.busy=false;renderComposer();}
  }

  function showError(message){
    $('#discussionLoading')?.classList.add('hidden');$('#discussionApp')?.classList.add('hidden');const node=$('#discussionError');if(node){node.classList.remove('hidden');node.innerHTML=`<i data-lucide="triangle-alert"></i><strong>Не удалось открыть обсуждение</strong><span>${esc(message)}</span>`;}refreshIcons();
  }

  function setMessage(value){const node=$('#discussionMessage');if(node)node.textContent=value;}
  function setText(selector,value){const node=$(selector);if(node)node.textContent=value;}
  function authorName(author){return author?.username?`@${author.username}`:(author?.firstName||'Читатель');}
  function authorInitial(author){const value=(author?.firstName||author?.username||'Ч').trim();return value.slice(0,1).toUpperCase()||'Ч';}
  function formatTime(value){if(!value)return'';const date=new Date(value);if(!Number.isFinite(date.getTime()))return'';const diff=Math.max(0,Date.now()-date.getTime());const mins=Math.max(1,Math.round(diff/60000));if(mins<60)return`${mins} мин. назад`;const hours=Math.round(mins/60);if(hours<24)return`${hours} ч. назад`;const days=Math.round(hours/24);if(days<30)return`${days} дн. назад`;return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}).format(date);}

  document.addEventListener('DOMContentLoaded',boot);
})();
