(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const LIST_LABELS={reading:'Читаю',planned:'В планах',dropped:'Брошено',completed:'Прочитано',favorite:'Любимые',other:'Другое'};
  const state={session:null,data:null,sort:'new',activeTab:'chapters',titleState:null,titleStateLoaded:false,titleStateBusy:false};
  const ref=new URLSearchParams(location.search).get('ref')||'';

  async function api(path,options={}){const response=await fetch(path,{credentials:'same-origin',...options});const body=await response.json().catch(()=>null);if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);return body;}
  async function boot(){
    bind();refreshIcons();
    try{
      const [session,data,titleState]=await Promise.all([
        api('/api/auth/session'),
        api(`/api/title?ref=${encodeURIComponent(ref)}`),
        api(`/api/title/state?ref=${encodeURIComponent(ref)}`).catch(()=>null),
      ]);
      state.session=session;state.data=data;state.titleState=titleState;state.titleStateLoaded=Boolean(titleState);
      renderSession();render();renderTitleState();
    }catch(error){$('#titleLoading').innerHTML=`<i data-lucide="triangle-alert"></i><strong>Не удалось открыть тайтл</strong><span>${esc(error.message)}</span>`;refreshIcons();}
  }
  function bind(){
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
    $('#mobileMenuButton')?.addEventListener('click',()=>$('#primaryNav')?.classList.toggle('open'));
    $('#chapterSearch')?.addEventListener('input',renderChapters);
    $('#sortNew')?.addEventListener('click',()=>{state.sort='new';setSortButtons();closeSortMenu();renderChapters();});
    $('#sortOld')?.addEventListener('click',()=>{state.sort='old';setSortButtons();closeSortMenu();renderChapters();});
    document.querySelectorAll('[data-title-tab]').forEach((button)=>button.addEventListener('click',()=>{if(!button.disabled)setTitleTab(button.dataset.titleTab||'');}));
    $('#titlePlanButton')?.addEventListener('click',togglePlanMenu);
    $('#titleMyRatingButton')?.addEventListener('click',toggleRatingPicker);
    document.querySelectorAll('[data-list-status]').forEach((button)=>button.addEventListener('click',()=>void mutateTitleList(button.dataset.listStatus||null)));
    document.querySelectorAll('[data-title-rating]').forEach((button)=>button.addEventListener('click',()=>{const raw=button.dataset.titleRating||'';void mutateTitleRating(raw?Number(raw):null);}));
    document.addEventListener('click',(event)=>{const target=event.target;if(!(target instanceof Element))return;if(!target.closest('.title-plan-control'))closePlanMenu();if(!target.closest('.title-rating-slot'))closeRatingPicker();});
    window.addEventListener('keydown',(event)=>{if(event.key==='Escape'){$('#primaryNav')?.classList.remove('open');closeSortMenu();closeTitleStateMenus();}});
  }
  function closeSortMenu(){const menu=$('.chapter-sort-menu');if(menu?.open)menu.open=false;}
  function closePlanMenu(){const menu=$('#titlePlanMenu'),button=$('#titlePlanButton');menu?.classList.add('hidden');button?.setAttribute('aria-expanded','false');}
  function closeRatingPicker(){const picker=$('#titleRatingPicker'),button=$('#titleMyRatingButton');picker?.classList.add('hidden');button?.setAttribute('aria-expanded','false');}
  function closeTitleStateMenus(){closePlanMenu();closeRatingPicker();}
  function togglePlanMenu(){const button=$('#titlePlanButton'),menu=$('#titlePlanMenu');if(!button||button.disabled||!menu)return;const opening=menu.classList.contains('hidden');closeRatingPicker();menu.classList.toggle('hidden',!opening);button.setAttribute('aria-expanded',String(opening));}
  function toggleRatingPicker(){const button=$('#titleMyRatingButton'),picker=$('#titleRatingPicker');if(!button||button.disabled||!picker)return;const opening=picker.classList.contains('hidden');closePlanMenu();picker.classList.toggle('hidden',!opening);button.setAttribute('aria-expanded',String(opening));}
  function setTitleTab(tab){
    if(tab!=='about'&&tab!=='chapters')return;
    state.activeTab=tab;
    document.querySelectorAll('[data-title-tab]').forEach((button)=>{const active=button.dataset.titleTab===tab;button.classList.toggle('active',active);if(!button.disabled)button.setAttribute('aria-selected',String(active));});
    $('#titleAboutPanel')?.classList.toggle('hidden',tab!=='about');
    $('#titleChaptersPanel')?.classList.toggle('hidden',tab!=='chapters');
  }
  function renderSession(){const user=state.session?.user;$('#adminLink')?.classList.toggle('hidden',!Boolean(state.session?.isAdmin));$('#logoutButton')?.classList.toggle('hidden',!user);const account=$('#accountName');const panel=$('#loginPanel');if(user){account.textContent=user.username?`@${user.username}`:user.firstName;panel.innerHTML='<span class="login-ready">Telegram-сессия активна</span>';}else{account.textContent='Войти';mountLogin();}refreshIcons();}
  function mountLogin(){const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;const bot=state.session?.botUsername;if(!bot){host.textContent='BOT_USERNAME не настроен.';return;}host.dataset.ready='1';const script=document.createElement('script');script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';host.append(script);}
  function render(){
    const title=state.data?.title||{};
    document.title=`${title.title||'Тайтл'} · НекромантЛиб`;
    $('#titleLoading')?.classList.add('hidden');$('#titleApp')?.classList.remove('hidden');
    setText('#titleName',title.title||'Без названия');
    const cover=$('#titleCover');if(cover){cover.src=title.cover_url||'/brand/team-logo.webp';cover.alt=`Обложка ${title.title||'тайтла'}`;}
    const secondary=$('#titleOriginal');if(secondary){secondary.textContent='';secondary.classList.add('hidden');}
    setText('#titleSource',sourceLabel(title.url));
    const status=translationLabel(title);
    setText('#translationStatus',status);
    const chapterCount=Number(title.chapter_count||state.data?.chapters?.length||0);
    const updated=dateRelative(title.last_release_at||title.last_synced_at)||'—';
    setText('#titleChapterCount',String(chapterCount));
    setText('#titleLatest',latestLabel(title));setText('#titleUpdated',updated);
    setText('#titleDescription',title.summary||'Описание пока не получено из каталога.');
    const crumb=$('#breadcrumbs span');if(crumb)crumb.textContent=title.title||'Тайтл';
    const available=(state.data?.chapters||[]).filter((chapter)=>chapter.readerAvailable);
    setText('#readerStatus',available.length?`${available.length} из ${chapterCount||available.length}`:'Тексты ещё не импортированы');
    renderProgress();renderChapters();setTitleTab(state.activeTab);refreshIcons();
  }
  function renderTitleState(){
    const value=state.titleState||{};
    const ratingCount=Math.max(0,Number(value.ratingCount)||0);
    const average=Number(value.ratingAverage);
    setText('#titleRatingValue',ratingCount&&Number.isFinite(average)?formatRating(average):'—');
    setText('#titleRatingVotes',ratingCount?`${ratingCount} ${ratingWord(ratingCount)}`:'Нет оценок');
    const ratingSlot=$('.title-rating-slot');if(ratingSlot)ratingSlot.setAttribute('aria-disabled',String(!state.titleStateLoaded));

    const myListStatus=typeof value.myListStatus==='string'?value.myListStatus:null;
    const myRating=Number.isInteger(Number(value.myRating))?Number(value.myRating):null;
    const signedIn=Boolean(state.session?.user);
    const interactive=signedIn&&state.titleStateLoaded&&!state.titleStateBusy;
    const planButton=$('#titlePlanButton');
    if(planButton){planButton.disabled=!interactive;planButton.setAttribute('aria-disabled',String(!interactive));const label=planButton.querySelector('span');if(label)label.textContent=myListStatus&&LIST_LABELS[myListStatus]?LIST_LABELS[myListStatus]:'Добавить в планы';}
    document.querySelectorAll('[data-list-status]').forEach((button)=>button.classList.toggle('active',Boolean(button.dataset.listStatus)&&button.dataset.listStatus===myListStatus));

    const ratingButton=$('#titleMyRatingButton');
    if(ratingButton){ratingButton.disabled=!interactive;ratingButton.setAttribute('aria-disabled',String(!interactive));ratingButton.textContent=`Моя оценка: ${myRating??'—'}`;}
    document.querySelectorAll('[data-title-rating]').forEach((button)=>button.classList.toggle('active',Boolean(button.dataset.titleRating)&&Number(button.dataset.titleRating)===myRating));

    const counts=value.listCounts&&typeof value.listCounts==='object'?value.listCounts:{};
    const listTotal=Math.max(0,Number(value.listTotal)||0);setText('#titleListTotal',String(listTotal));
    document.querySelectorAll('[data-list-stat]').forEach((node)=>{const key=node.dataset.listStat||'';const count=Math.max(0,Number(counts[key])||0);const strong=node.querySelector('strong');if(strong)strong.textContent=String(count);node.style.setProperty('--list-share',listTotal?`${Math.round(count/listTotal*100)}%`:'0%');});
    if(!interactive)closeTitleStateMenus();
  }
  async function mutateTitleList(value){
    if(!state.session?.user||!state.titleStateLoaded||state.titleStateBusy)return;
    state.titleStateBusy=true;renderTitleState();
    try{state.titleState=await api('/api/title/state/list',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({bookRef:ref,value})});state.titleStateLoaded=true;}catch(error){console.error('Title list update failed',error);}finally{state.titleStateBusy=false;closePlanMenu();renderTitleState();}
  }
  async function mutateTitleRating(value){
    if(!state.session?.user||!state.titleStateLoaded||state.titleStateBusy)return;
    state.titleStateBusy=true;renderTitleState();
    try{state.titleState=await api('/api/title/state/rating',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({bookRef:ref,value})});state.titleStateLoaded=true;}catch(error){console.error('Title rating update failed',error);}finally{state.titleStateBusy=false;closeRatingPicker();renderTitleState();}
  }
  function renderProgress(){
    const chapters=state.data?.chapters||[];const read=readSet();const readCount=chapters.filter((chapter)=>read.has(String(chapter.chapter_id))).length;const percent=chapters.length?Math.round(readCount/chapters.length*100):0;
    setText('#readingProgressText',`${readCount} / ${chapters.length}`);setText('#readingProgressPercent',`${percent}%`);
    const continueReading=$('#continueReading');const action=$('#readingProgressAction');const last=lastRead();let target=null;let actionText='Начать читать';
    if(last){const chapter=chapters.find((item)=>String(item.chapter_id)===String(last));if(chapter?.readerAvailable){target=chapter;actionText=`Продолжить · Глава ${chapter.number}`;}}
    if(!target){target=[...chapters].reverse().find((item)=>item.readerAvailable)||null;}
    if(continueReading){continueReading.href=target?readerUrl(target.chapter_id):'#chapters';continueReading.setAttribute('aria-label',target?actionText:'Доступных текстов пока нет');continueReading.classList.toggle('is-disabled',!target);}
    if(action)action.textContent=target?actionText:'Тексты пока недоступны';
  }
  function renderChapters(){const host=$('#chapterList');if(!host||!state.data)return;const query=($('#chapterSearch')?.value||'').trim().toLowerCase();let chapters=[...(state.data.chapters||[])];if(query)chapters=chapters.filter((chapter)=>`${chapter.number||''} ${chapter.name||''} ${chapter.volume||''}`.toLowerCase().includes(query));chapters.sort((a,b)=>Number(a.chapter_id)-Number(b.chapter_id));if(state.sort==='new')chapters.reverse();const read=readSet();host.innerHTML=chapters.length?chapters.map((chapter)=>chapterRow(chapter,read)).join(''):'<div class="title-empty"><i data-lucide="search-x"></i><strong>Главы не найдены</strong><span>Измените номер или название в поиске.</span></div>';refreshIcons();}
  function chapterRow(chapter,read){const isRead=read.has(String(chapter.chapter_id));const href=chapter.readerAvailable?readerUrl(chapter.chapter_id):(state.data.title?.url||'#');const external=!chapter.readerAvailable&&state.data.title?.url;const prefix=chapterPrefix(chapter);const name=String(chapter.name||'').trim();const stateIcon=isRead?'circle-check':chapter.readerAvailable?'book-open':'external-link';const stateLabel=isRead?'Прочитано':chapter.readerAvailable?'Открыть в читалке':'Открыть источник перевода';return`<a class="chapter-row" href="${esc(href)}" ${external?'target="_blank" rel="noreferrer"':''}><span class="chapter-row-copy"><strong><span class="chapter-row-prefix">${esc(prefix)}</span>${name?`<span class="chapter-row-name"> - ${esc(name)}</span>`:''}</strong></span><time>${esc(dateShort(chapter.first_seen_at))}</time><span class="chapter-read" title="${esc(stateLabel)}" aria-label="${esc(stateLabel)}"><i data-lucide="${stateIcon}"></i></span></a>`;}
  function chapterPrefix(chapter){const volume=String(chapter.volume||'').trim();const number=String(chapter.number||chapter.chapter_id||'').trim();return`${volume?`Том ${volume} `:''}Глава ${number}`;}
  function setSortButtons(){$('#sortNew')?.classList.toggle('active',state.sort==='new');$('#sortOld')?.classList.toggle('active',state.sort==='old');}
  function storageKey(){return`domnkr:reader:${ref}:read`;}
  function readSet(){try{return new Set(JSON.parse(localStorage.getItem(storageKey())||'[]').map(String));}catch{return new Set();}}
  function lastRead(){try{return localStorage.getItem(`domnkr:reader:${ref}:last`);}catch{return null;}}
  function readerUrl(chapter){return`/reader/?ref=${encodeURIComponent(ref)}&chapter=${encodeURIComponent(chapter)}`;}
  function latestLabel(title){return[title.latest_volume?`Том ${title.latest_volume}`:'',title.latest_number?`Глава ${title.latest_number}`:''].filter(Boolean).join(' · ')||'—';}
  function translationLabel(title){const label=String(title.translation_status_label||'').trim();if(label)return label;switch(String(title.translation_semantic_status||'')){case'active':return'Продолжается';case'completed':return'Завершён';default:return'Неизвестно';}}
  function sourceLabel(value){if(!value)return'Не указан';try{const url=new URL(value);return url.hostname.replace(/^www\./,'');}catch{return String(value);}}
  function formatRating(value){return Number.isInteger(value)?String(value):value.toFixed(1);}
  function ratingWord(value){const mod10=value%10,mod100=value%100;if(mod10===1&&mod100!==11)return'оценка';if(mod10>=2&&mod10<=4&&(mod100<12||mod100>14))return'оценки';return'оценок';}
  function dateRelative(value){if(!value)return'';const time=new Date(value).getTime();if(!Number.isFinite(time))return'';const mins=Math.max(1,Math.round((Date.now()-time)/60000));if(mins<60)return`${mins} мин. назад`;const h=Math.round(mins/60);if(h<24)return`${h} ч. назад`;const d=Math.round(h/24);return`${d} дн. назад`;}
  function dateShort(value){if(!value)return'';const date=new Date(value);if(!Number.isFinite(date.getTime()))return'';return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}).format(date);}
  function setText(selector,value){const node=$(selector);if(node)node.textContent=value;}
  document.addEventListener('DOMContentLoaded',boot);
})();