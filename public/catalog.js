(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const API_TIMEOUT_MS=10000;
  const SORTS=new Set(['updated','chapters','title']);
  const DIRS=new Set(['desc','asc']);
  const state={titles:[],bootstrap:null,filters:parseCatalogState(location.search)};

  function parseCatalogState(search){
    const params=new URLSearchParams(search||'');
    const sort=params.get('sort')||'updated';
    const dir=params.get('dir')||'desc';
    return {
      q:(params.get('q')||'').trim(),
      sort:SORTS.has(sort)?sort:'updated',
      dir:DIRS.has(dir)?dir:'desc',
      chaptersMin:nonNegativeNumber(params.get('chaptersMin')),
      chaptersMax:nonNegativeNumber(params.get('chaptersMax')),
    };
  }

  function nonNegativeNumber(value){
    if(value===null||value==='')return null;
    const number=Number(value);
    return Number.isFinite(number)&&number>=0?number:null;
  }

  function dateValue(value){const time=new Date(value||0).getTime();return Number.isFinite(time)?time:0;}

  function applyCatalog(titles,filters){
    const query=String(filters.q||'').trim().toLocaleLowerCase('ru-RU');
    let result=titles.filter((item)=>{
      const title=String(item.title||'').toLocaleLowerCase('ru-RU');
      const summary=String(item.summary||'').toLocaleLowerCase('ru-RU');
      const chapters=Number(item.chapter_count||0);
      if(query&&!title.includes(query)&&!summary.includes(query))return false;
      if(filters.chaptersMin!==null&&chapters<filters.chaptersMin)return false;
      if(filters.chaptersMax!==null&&chapters>filters.chaptersMax)return false;
      return true;
    });

    result=[...result].sort((a,b)=>{
      if(filters.sort==='updated')return dateValue(a.last_release_at||a.last_synced_at)-dateValue(b.last_release_at||b.last_synced_at);
      if(filters.sort==='chapters')return Number(a.chapter_count||0)-Number(b.chapter_count||0);
      if(filters.sort==='title')return String(a.title||'').localeCompare(String(b.title||''),'ru',{sensitivity:'base'});
      return 0;
    });
    if(filters.dir==='desc')result.reverse();
    return result;
  }

  async function api(path,options={}){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),API_TIMEOUT_MS);
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
    bind();hydrateControls();refreshIcons();
    const [catalogResult,bootstrapResult]=await Promise.allSettled([api('/api/ranobelib'),api('/api/bootstrap')]);
    if(bootstrapResult.status==='fulfilled'){state.bootstrap=bootstrapResult.value;renderSession();}
    else renderSessionError();
    if(catalogResult.status==='fulfilled'){
      state.titles=Array.isArray(catalogResult.value?.titles)?catalogResult.value.titles:[];
      renderCatalog();
    }else renderCatalogError(catalogResult.reason);
  }

  function bind(){
    $('#mobileMenuButton')?.addEventListener('click',()=>$('#primaryNav')?.classList.toggle('open'));
    $('#searchNavButton')?.addEventListener('click',()=>focusSearch());
    $('#mobileSearchToggle')?.addEventListener('click',()=>focusSearch());
    $('#filterToggle')?.addEventListener('click',()=>setFilterSheet(true));
    $('#filterClose')?.addEventListener('click',()=>setFilterSheet(false));
    $('#filterBackdrop')?.addEventListener('click',()=>setFilterSheet(false));
    $('#applyFilters')?.addEventListener('click',applyDraft);
    $('#resetFilters')?.addEventListener('click',resetFilters);
    $('#catalogSearch')?.addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();applyDraft();}});
    $('#catalogSort')?.addEventListener('change',applyDraft);
    $('#catalogDirection')?.addEventListener('change',applyDraft);
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
    window.addEventListener('popstate',()=>{state.filters=parseCatalogState(location.search);hydrateControls();renderCatalog();});
    window.addEventListener('keydown',(event)=>{
      if(event.key==='Escape'){setFilterSheet(false);$('#primaryNav')?.classList.remove('open');}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();focusSearch();}
    });
  }

  function focusSearch(){setFilterSheet(true);setTimeout(()=>$('#catalogSearch')?.focus(),0);}

  function setFilterSheet(open){
    const panel=$('#catalogFilters');const backdrop=$('#filterBackdrop');
    panel?.classList.toggle('mobile-open',Boolean(open));
    backdrop?.classList.toggle('hidden',!open);
    document.body.classList.toggle('catalog-filter-open',Boolean(open));
  }

  function draftFromControls(){
    return {
      q:($('#catalogSearch')?.value||'').trim(),
      sort:SORTS.has($('#catalogSort')?.value)?$('#catalogSort').value:'updated',
      dir:DIRS.has($('#catalogDirection')?.value)?$('#catalogDirection').value:'desc',
      chaptersMin:nonNegativeNumber($('#chaptersMin')?.value??null),
      chaptersMax:nonNegativeNumber($('#chaptersMax')?.value??null),
    };
  }

  function applyDraft(){
    const next=draftFromControls();
    if(next.chaptersMin!==null&&next.chaptersMax!==null&&next.chaptersMin>next.chaptersMax){
      [next.chaptersMin,next.chaptersMax]=[next.chaptersMax,next.chaptersMin];
    }
    state.filters=next;writeUrl(next);hydrateControls();renderCatalog();setFilterSheet(false);
  }

  function resetFilters(){
    state.filters={q:'',sort:'updated',dir:'desc',chaptersMin:null,chaptersMax:null};
    writeUrl(state.filters);hydrateControls();renderCatalog();
  }

  function writeUrl(filters){
    const params=new URLSearchParams();
    if(filters.q)params.set('q',filters.q);
    if(filters.sort!=='updated')params.set('sort',filters.sort);
    if(filters.dir!=='desc')params.set('dir',filters.dir);
    if(filters.chaptersMin!==null)params.set('chaptersMin',String(filters.chaptersMin));
    if(filters.chaptersMax!==null)params.set('chaptersMax',String(filters.chaptersMax));
    const query=params.toString();const url=`${location.pathname}${query?`?${query}`:''}`;
    history.replaceState(null,'',url);
  }

  function hydrateControls(){
    if($('#catalogSearch'))$('#catalogSearch').value=state.filters.q;
    if($('#catalogSort'))$('#catalogSort').value=state.filters.sort;
    if($('#catalogDirection'))$('#catalogDirection').value=state.filters.dir;
    if($('#chaptersMin'))$('#chaptersMin').value=state.filters.chaptersMin??'';
    if($('#chaptersMax'))$('#chaptersMax').value=state.filters.chaptersMax??'';
  }

  function renderCatalog(){
    const items=applyCatalog(state.titles,state.filters);
    const count=$('#catalogCount');if(count)count.textContent=`Найдено: ${items.length} из ${state.titles.length}`;
    const host=$('#catalogGrid');if(!host)return;
    host.innerHTML=items.length?items.map(bookCard).join(''):emptyState('search-x','Ничего не найдено','Измените запрос или диапазон глав.');
    refreshIcons();
  }

  function renderCatalogError(error){
    const count=$('#catalogCount');if(count)count.textContent='Каталог недоступен';
    const host=$('#catalogGrid');if(host)host.innerHTML=emptyState('triangle-alert','Не удалось загрузить каталог',error?.message||'Обновите страницу чуть позже.');
    refreshIcons();
  }

  function bookCard(item){
    const title=esc(item.title||'Без названия');const cover=esc(item.cover_url||'/brand/team-logo.webp');
    const chapters=Number(item.chapter_count||0);const updated=esc(dateRelative(item.last_release_at||item.last_synced_at)||'');
    return `<article class="catalog-book-card"><a href="${titleUrl(item.book_ref)}"><div class="book-cover"><img loading="lazy" src="${cover}" alt="Обложка ${title}"></div><h3>${title}</h3><div class="catalog-card-meta"><span>${chapters} глав</span>${updated?`<time>${updated}</time>`:''}</div></a></article>`;
  }

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

  function titleUrl(ref){return`/title/?ref=${encodeURIComponent(ref||'')}`;}
  function emptyState(icon,title,message){return`<div class="empty-state"><i data-lucide="${icon}"></i><strong>${esc(title)}</strong><span>${esc(message)}</span></div>`;}
  function dateRelative(value){if(!value)return'';const time=new Date(value).getTime();if(!Number.isFinite(time))return'';const minutes=Math.max(1,Math.round((Date.now()-time)/60000));if(minutes<60)return`${minutes} мин. назад`;const hours=Math.round(minutes/60);if(hours<24)return`${hours} ч. назад`;const days=Math.round(hours/24);return`${days} дн. назад`;}

  document.addEventListener('DOMContentLoaded',boot);
})();
