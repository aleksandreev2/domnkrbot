(() => {
  const state={bootstrap:null,ranobelib:null};
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  async function boot(){
    bind();refreshIcons();
    try{
      const [bootstrap,ranobelib]=await Promise.all([api('/api/bootstrap'),api('/api/ranobelib')]);
      state.bootstrap=bootstrap;state.ranobelib=ranobelib;
      if(restorePostLoginRoute())return;
      renderSession();renderRanobelib();renderProposals(bootstrap.proposals||[]);
    }catch(error){
      $('#releaseList').innerHTML=emptyState('triangle-alert','Не удалось загрузить релизы',error.message);
      $('#proposalList').innerHTML=emptyState('triangle-alert','Не удалось загрузить очередь','Обновите страницу чуть позже.');
      refreshIcons();
    }
  }

  function bind(){
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
  }

  function restorePostLoginRoute(){
    if(!state.bootstrap?.user||location.pathname!=='/')return false;
    try{
      const target=localStorage.getItem('domnkr:return-after-login');
      if(target==='/propose/'){
        localStorage.removeItem('domnkr:return-after-login');
        location.replace(target);return true;
      }
    }catch{}
    return false;
  }

  function renderSession(){
    const user=state.bootstrap?.user;
    const admin=Boolean(state.bootstrap?.isAdmin);
    $('#adminLink')?.classList.toggle('hidden',!admin);
    $('#logoutButton')?.classList.toggle('hidden',!user);
    const account=$('#accountName');
    const panel=$('#loginPanel');
    if(user){
      if(account)account.textContent=user.username?`@${user.username}`:user.firstName;
      if(panel)panel.innerHTML='<span class="login-ready">Telegram-сессия активна</span>';
      refreshIcons();
      return;
    }
    if(account)account.textContent='LOGIN';
    mountTelegramLogin();refreshIcons();
  }

  function mountTelegramLogin(){
    const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;
    const bot=state.bootstrap?.botUsername;if(!bot){host.textContent='BOT_USERNAME не настроен.';return;}
    host.dataset.ready='1';host.innerHTML='';
    const script=document.createElement('script');
    script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';
    script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';
    script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';host.append(script);
  }

  function renderRanobelib(){
    const data=state.ranobelib||{};const stats=data.stats||{};
    $('#statTitles').textContent=stats.activeTitles??0;
    $('#statSynced').textContent=stats.syncedTitles??0;
    $('#statReleases').textContent=stats.releases??0;
    const releases=(data.releases||[]).slice(0,8);
    $('#releaseList').innerHTML=releases.length
      ?releases.map(releaseCard).join('')
      :emptyState('book-dashed','Новых глав пока нет','Когда синхронизация найдёт релиз, он появится на этой полке.');
    refreshIcons();
  }

  function releaseCard(item,index){
    const title=esc(item.title||'Без названия');
    const meta=esc(item.summary||chapterLabel(item));
    const mark=esc((item.title||'DN').trim().slice(0,2).toUpperCase()||'DN');
    return `<article class="release-card"><div class="release-cover cover-${index%3+1}"><span class="cover-mark">${mark}</span><small>ДОМ НЕКРОМАНТА</small></div><div class="release-card-copy"><strong>${title}</strong><span>${meta}</span><time>${dateLabel(item.created_at)||'сейчас'}</time></div></article>`;
  }

  function chapterLabel(item){
    if(Number(item.chapter_count)>1)return`${item.chapter_count} новых глав`;
    const volume=item.last_volume?`Том ${item.last_volume}`:'';const number=item.last_number?`глава ${item.last_number}`:'';
    return[volume,number].filter(Boolean).join(' · ')||'Новая глава';
  }

  function renderProposals(items){
    const host=$('#proposalList');if(!host)return;
    host.innerHTML=items.length
      ?items.slice(0,8).map((item,index)=>`<article class="queue-row" data-id="${esc(item.id)}"><span class="queue-rank">${String(index+1).padStart(2,'0')}</span><div class="queue-copy"><strong>${esc(item.title)}</strong><span>${esc(item.comment||item.source_url||'Без комментария')}</span></div><span class="status ${esc(item.status)}">${statusLabel(item.status)}</span><button class="vote ${item.viewer_voted?'active':''}" type="button" data-vote ${!state.bootstrap?.user||item.is_owner?'disabled':''} aria-label="Поддержать заявку"><i data-lucide="arrow-up" aria-hidden="true"></i><span>${Number(item.vote_count||0)+(item.is_owner?1:0)}</span></button></article>`).join('')
      :emptyState('inbox','Очередь пока пустая','Предложите первый тайтл на отдельной странице.');
    host.querySelectorAll('[data-vote]').forEach((button)=>button.addEventListener('click',()=>void vote(button.closest('[data-id]')?.dataset.id,button)));
    refreshIcons();
  }

  async function vote(id,button){
    if(!id)return;button.disabled=true;
    try{const result=await api(`/api/proposals/${encodeURIComponent(id)}/vote`,{method:'POST'});button.classList.toggle('active',result.voted);button.querySelector('span').textContent=String(result.voteCount);}
    catch(error){window.alert(error.message);}finally{button.disabled=false;}
  }

  function emptyState(icon,title,text){return`<div class="empty-state"><i data-lucide="${icon}" aria-hidden="true"></i><div><strong>${esc(title)}</strong><span>${esc(text)}</span></div></div>`;}
  function statusLabel(status){return({pending:'Новая',approved:'Одобрено',planned:'В плане',in_progress:'В работе',done:'Готово',rejected:'Отклонено'})[status]||status;}
  function dateLabel(value){if(!value)return'';const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleDateString('ru-RU',{day:'2-digit',month:'short'});}
  document.addEventListener('DOMContentLoaded',boot);
})();
