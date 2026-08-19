(() => {
  const state={bootstrap:null,ranobelib:null,titles:[]};
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const API_TIMEOUT_MS=10000;

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
    }finally{
      clearTimeout(timer);
    }
  }

  function boot(){
    bind();refreshIcons();
    void loadBootstrap();
    void loadCatalog();
  }

  async function loadBootstrap(){
    try{
      const bootstrap=await api('/api/bootstrap');
      state.bootstrap=bootstrap;
      if(restorePostLoginRoute())return;
      renderSession();
      renderProposals(bootstrap.proposals||[]);
    }catch(error){
      const proposal=$('#proposalGrid');
      if(proposal)proposal.innerHTML=emptyState('triangle-alert','Не удалось загрузить заявки',error.message||'Обновите страницу чуть позже.');
      const account=$('#accountName');if(account)account.textContent='Войти';
      const panel=$('#loginPanel');if(panel)panel.innerHTML='<span class="login-ready">Авторизация временно недоступна</span>';
      refreshIcons();
    }
  }

  async function loadCatalog(){
    try{
      const ranobelib=await api('/api/ranobelib');
      state.ranobelib=ranobelib;state.titles=ranobelib.titles||[];
      renderCatalog();
    }catch(error){
      const release=$('#releaseGrid');
      const titles=$('#titleGrid');
      if(release)release.innerHTML=emptyState('triangle-alert','Не удалось загрузить обновления',error.message||'Обновите страницу чуть позже.');
      if(titles)titles.innerHTML=emptyState('triangle-alert','Не удалось загрузить каталог','Остальная часть сайта продолжает работать.');
      refreshIcons();
    }
  }

  function bind(){
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
    $('#mobileMenuButton')?.addEventListener('click',()=>$('#primaryNav')?.classList.toggle('open'));
    $('#titleSearch')?.addEventListener('input',(event)=>renderSearch(event.currentTarget.value));
    document.addEventListener('click',(event)=>{if(!event.target.closest?.('.search-wrap'))$('#searchResults')?.classList.add('hidden');});
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
    $('#adminLink')?.classList.toggle('hidden',!Boolean(state.bootstrap?.isAdmin));
    $('#logoutButton')?.classList.toggle('hidden',!user);
    const account=$('#accountName');const panel=$('#loginPanel');
    if(user){
      if(account)account.textContent=user.username?`@${user.username}`:user.firstName;
      if(panel)panel.innerHTML='<span class="login-ready">Telegram-сессия активна</span>';
    }else{
      if(account)account.textContent='Войти';mountTelegramLogin();
    }
    refreshIcons();
  }

  function mountTelegramLogin(){
    const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;
    const bot=state.bootstrap?.botUsername;if(!bot){host.textContent='BOT_USERNAME не настроен.';return;}
    host.dataset.ready='1';host.innerHTML='';
    const script=document.createElement('script');script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';
    script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';host.append(script);
  }

  function renderCatalog(){
    const data=state.ranobelib||{};const titles=data.titles||[];const releases=data.releases||[];
    $('#catalogCount').textContent=`${titles.length} тайтл(ов) в каталоге`;
    const hero=titles.find((item)=>item.cover_url)||titles[0];if(hero)renderHero(hero);
    $('#releaseGrid').innerHTML=releases.length?releases.slice(0,6).map((item)=>bookCard(item,true)).join(''):emptyState('book-open','Обновлений пока нет','Новые главы появятся здесь после синхронизации.');
    $('#titleGrid').innerHTML=titles.length?titles.slice(0,6).map((item)=>bookCard(item,false)).join(''):emptyState('library','Каталог пока пуст','Синхронизация ещё не добавила тайтлы.');
    refreshIcons();
  }

  function renderHero(item){
    const cover=item.cover_url||'/brand/team-logo.webp';
    $('#heroCover').src=cover;$('#heroCover').alt=`Обложка ${item.title||'тайтла'}`;
    $('#heroBackdrop').style.backgroundImage=`url(${JSON.stringify(cover).slice(1,-1)})`;
    $('#heroTitle').textContent=item.title||'Дом Некроманта';
    $('#heroOriginal').textContent='Перевод команды «Дом Некроманта»';
    $('#heroSummary').textContent=item.summary||'Новые главы, редактура и собственная читалка команды переводчиков.';
    $('#heroChapter').textContent=chapterLabel(item);
    const titleHref=titleUrl(item.book_ref);const readerHref=item.latest_chapter_id?readerUrl(item.book_ref,item.latest_chapter_id):titleHref;
    $('#heroCoverLink').href=titleHref;$('#heroDetails').href=titleHref;$('#heroRead').href=readerHref;
  }

  function bookCard(item,isRelease){
    const ref=item.book_ref;const cover=esc(item.cover_url||'/brand/team-logo.webp');const title=esc(item.title||'Без названия');
    const meta=isRelease?chapterLabel(item):`${Number(item.chapter_count||0)} глав`;
    const date=isRelease?dateRelative(item.created_at):dateRelative(item.last_release_at||item.last_synced_at);
    return `<article class="book-card"><a href="${titleUrl(ref)}"><div class="book-cover"><img loading="lazy" src="${cover}" alt="Обложка ${title}"></div><h3>${title}</h3><div class="book-meta">${esc(meta)}</div><div class="book-time">${esc(date||'')}</div>${isRelease?'':`<div class="book-rating"><i data-lucide="star"></i><span>${Number(item.chapter_count||0)} глав</span></div>`}</a></article>`;
  }

  function renderProposals(items){
    const host=$('#proposalGrid');if(!host)return;
    host.innerHTML=items.length?items.slice(0,5).map((item,index)=>`<article class="proposal-card"><div class="proposal-cover">${String(index+1).padStart(2,'0')}</div><div><strong>${esc(item.title)}</strong><small>${esc(item.comment||item.source_url||'Заявка сообщества')}</small><div class="proposal-votes"><i data-lucide="flame"></i><span>${Number(item.vote_count||0)+(item.is_owner?1:0)} голосов</span></div></div></article>`).join(''):emptyState('inbox','Заявок пока нет','Предложите первый тайтл.');
    refreshIcons();
  }

  function renderSearch(query){
    const host=$('#searchResults');if(!host)return;const value=String(query||'').trim().toLocaleLowerCase('ru-RU');
    if(value.length<2){host.classList.add('hidden');host.innerHTML='';return;}
    const matches=state.titles.filter((item)=>String(item.title||'').toLocaleLowerCase('ru-RU').includes(value)).slice(0,8);
    host.innerHTML=matches.length?matches.map((item)=>`<a class="search-result" href="${titleUrl(item.book_ref)}"><img src="${esc(item.cover_url||'/brand/team-logo.webp')}" alt=""><span><strong>${esc(item.title||'Без названия')}</strong><small>${esc(chapterLabel(item))}</small></span></a>`).join(''):'<div class="empty-state"><span>Ничего не найдено.</span></div>';
    host.classList.remove('hidden');
  }

  function titleUrl(ref){return`/title/?ref=${encodeURIComponent(ref||'')}`;}
  function readerUrl(ref,chapter){return`/reader/?ref=${encodeURIComponent(ref||'')}&chapter=${encodeURIComponent(chapter||'')}`;}
  function chapterLabel(item){const volume=item.last_volume||item.latest_volume;const number=item.last_number||item.latest_number;return[volume?`Том ${volume}`:'',number?`Глава ${number}`:''].filter(Boolean).join(' · ')||'Главы доступны';}
  function emptyState(icon,title,message){return`<div class="empty-state"><i data-lucide="${icon}"></i><strong>${esc(title)}</strong><span>${esc(message)}</span></div>`;}
  function dateRelative(value){if(!value)return'';const time=new Date(value).getTime();if(!Number.isFinite(time))return'';const minutes=Math.max(1,Math.round((Date.now()-time)/60000));if(minutes<60)return`${minutes} мин. назад`;const hours=Math.round(minutes/60);if(hours<24)return`${hours} ч. назад`;const days=Math.round(hours/24);return`${days} дн. назад`;}
  document.addEventListener('DOMContentLoaded',boot);
})();
