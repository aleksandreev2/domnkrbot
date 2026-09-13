(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const MAX_CONTINUE=8;
  let titleIndex=new Map();
  let bootstrapState=null;

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  async function boot(){
    bind();refreshIcons();
    const bootstrapPromise=api('/api/bootstrap');
    const catalogPromise=api('/api/ranobelib');
    const socialPromise=api('/api/home/social');
    try{bootstrapState=await bootstrapPromise;if(restorePostLoginRoute())return;renderSession();}catch{renderSessionError();}
    try{
      const data=await catalogPromise;
      renderCatalog(data||{});
      await renderContinueReading();
    }catch(error){
      for(const selector of ['#popularUpdates','#topViewsNew','#topViewsRising','#topViewsPopular','#releaseFeed','#newestRail']){
        const host=$(selector);if(host)host.innerHTML=empty(error.message||'Данные временно недоступны');
      }
      await renderContinueReading();
    }
    try{renderSocial(await socialPromise);}catch{
      renderSocial({discussions:[],reviews:[],collections:[],topUsers:[]});
    }
    refreshIcons();
  }

  function bind(){
    $('#continueClearButton')?.addEventListener('click',clearContinueReading);
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
    $('#mobileMenuButton')?.addEventListener('click',()=>$('#primaryNav')?.classList.toggle('open'));
    $('#searchNavButton')?.addEventListener('click',openSearch);
    $('#titleSearch')?.addEventListener('input',(event)=>renderSearch(event.currentTarget.value));
    document.addEventListener('click',(event)=>{
      const target=event.target;if(!(target instanceof Element))return;
      if(!target.closest('.nl-search')&&!target.closest('#searchNavButton')){$('#searchResults')?.classList.add('hidden');$('#titleSearch')?.closest('.nl-search')?.classList.remove('mobile-open');}
      if(!target.closest('.nl-nav')&&!target.closest('#mobileMenuButton'))$('#primaryNav')?.classList.remove('open');
    });
    window.addEventListener('keydown',(event)=>{
      if(event.key==='Escape'){$('#searchResults')?.classList.add('hidden');$('#titleSearch')?.closest('.nl-search')?.classList.remove('mobile-open');$('#primaryNav')?.classList.remove('open');}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openSearch();}
    });
  }

  function openSearch(){const input=$('#titleSearch');if(!input)return;input.closest('.nl-search')?.classList.add('mobile-open');$('#primaryNav')?.classList.remove('open');input.focus();}

  function renderSearch(query){
    const host=$('#searchResults');if(!host)return;
    const value=String(query||'').trim().toLocaleLowerCase('ru-RU');
    if(value.length<2){host.classList.add('hidden');host.innerHTML='';return;}
    const matches=Array.from(titleIndex.values()).filter((item)=>String(item.title||'').toLocaleLowerCase('ru-RU').includes(value)).slice(0,8);
    host.innerHTML=matches.length?matches.map((item)=>`<a class="search-result" href="${titleUrl(item.book_ref)}"><img src="${esc(item.cover_url||'/brand/team-logo.webp')}" alt=""><span><strong>${esc(item.title||'Без названия')}</strong><small>${esc(chapterLabel(item))}</small></span></a>`).join(''):'<div class="home-compact-empty">Ничего не найдено.</div>';
    host.classList.remove('hidden');refreshIcons();
  }

  function restorePostLoginRoute(){
    if(!bootstrapState?.user||location.pathname!=='/')return false;
    try{const target=localStorage.getItem('domnkr:return-after-login');if(target&&target.startsWith('/')&&!target.startsWith('//')){localStorage.removeItem('domnkr:return-after-login');location.replace(target);return true;}}catch{}
    return false;
  }

  function renderSession(){
    const user=bootstrapState?.user;
    $('#adminLink')?.classList.toggle('hidden',!Boolean(bootstrapState?.isAdmin));$('#logoutButton')?.classList.toggle('hidden',!user);
    const account=$('#accountName');const panel=$('#loginPanel');
    if(user){if(account)account.textContent=user.username?`@${user.username}`:user.firstName;if(panel)panel.innerHTML='<span class="login-ready">Telegram-сессия активна</span>';}else{if(account)account.textContent='Войти';mountTelegramLogin();}
    refreshIcons();
  }

  function renderSessionError(){const account=$('#accountName');if(account)account.textContent='Войти';const panel=$('#loginPanel');if(panel)panel.innerHTML='<span class="login-ready">Авторизация временно недоступна</span>';}

  function mountTelegramLogin(){
    const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;
    const bot=bootstrapState?.botUsername;if(!bot){host.textContent='BOT_USERNAME не настроен.';return;}
    host.dataset.ready='1';host.innerHTML='';const script=document.createElement('script');script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';host.append(script);
  }

  function renderCatalog(data){
    const titles=Array.isArray(data.titles)?data.titles:[];
    const releases=Array.isArray(data.releases)?data.releases:[];
    titleIndex=new Map(titles.map((item)=>[String(item.book_ref||''),item]));
    const recent=[...titles].sort((a,b)=>dateValue(b.last_release_at||b.last_synced_at)-dateValue(a.last_release_at||a.last_synced_at));
    const popular=[...titles].sort((a,b)=>Number(b.chapter_count||0)-Number(a.chapter_count||0));
    const active=uniqueReleaseTitles(releases,titles);

    const popularHost=$('#popularUpdates');
    if(popularHost){
      const items=fillUnique(active,recent,10);
      popularHost.innerHTML=items.length?items.map(coverCard).join(''):empty('Обновлений пока нет');
    }
    renderTop('#topViewsNew',recent.slice(0,3));
    renderTop('#topViewsRising',fillUnique(active,recent.slice(3),3));
    renderTop('#topViewsPopular',popular.slice(0,3));

    const releaseHost=$('#releaseFeed');
    if(releaseHost)releaseHost.innerHTML=releases.length?releases.slice(0,14).map(releaseRow).join(''):empty('Новые главы появятся после синхронизации');

    const newest=$('#newestRail');
    if(newest)newest.innerHTML=recent.length?recent.slice(0,6).map(newestCard).join(''):empty('Новинок пока нет');
    refreshIcons();
  }

  async function renderContinueReading(){
    const host=$('#continueReadingRail');if(!host)return;
    const refs=readerRefs().slice(0,MAX_CONTINUE);
    const clear=$('#continueClearButton');if(clear)clear.disabled=!refs.length;
    if(!refs.length){host.innerHTML=empty('Здесь появятся недавно открытые тайтлы.');return;}
    const items=(await Promise.all(refs.map(async(ref)=>{
      try{
        const cached=titleIndex.get(ref);
        const payload=await api(`/api/title?ref=${encodeURIComponent(ref)}`);
        const title=payload?.title||cached||{};
        const chapters=Array.isArray(payload?.chapters)?payload.chapters:[];
        const last=localStorage.getItem(`domnkr:reader:${ref}:last`)||'';
        const current=chapters.find((chapter)=>String(chapter.chapter_id)===String(last));
        const read=readSet(ref);
        const percent=chapters.length?Math.min(100,Math.round(read.size/chapters.length*100)):0;
        return {ref,title,current,last,percent};
      }catch{return null;}
    }))).filter(Boolean);
    host.innerHTML=items.length?items.map(continueCard).join(''):empty('Не удалось восстановить историю чтения.');
    refreshIcons();
  }

  function readerRefs(){
    const refs=[];const seen=new Set();
    try{
      for(let index=0;index<localStorage.length;index+=1){
        const key=localStorage.key(index)||'';
        const match=/^domnkr:reader:(.+):last$/.exec(key);if(!match)continue;
        const ref=match[1];if(!ref||seen.has(ref))continue;seen.add(ref);refs.push(ref);
      }
    }catch{}
    return refs.reverse();
  }

  function clearContinueReading(){
    try{
      const keys=[];
      for(let index=0;index<localStorage.length;index+=1){const key=localStorage.key(index)||'';if(/^domnkr:reader:.+:last$/.test(key))keys.push(key);}
      keys.forEach((key)=>localStorage.removeItem(key));
    }catch{}
    renderContinueReading();
  }

  function continueCard(item){
    const title=item.title||{};const name=esc(title.title||item.ref);const cover=esc(title.cover_url||'/brand/team-logo.webp');
    const chapter=item.current?chapterLabel(item.current):item.last?`Глава ${esc(item.last)}`:'Продолжить';
    const percent=Math.max(0,Math.min(100,Number(item.percent)||0));
    return `<a class="home-continue-card" href="${readerUrl(item.ref,item.last)}"><img class="home-continue-cover" loading="lazy" src="${cover}" alt=""><span class="home-continue-copy"><strong>${name}</strong><span class="home-continue-progress-label">${esc(chapter)} — ${percent}%</span><span class="home-continue-progress" aria-hidden="true"><span style="width:${percent}%"></span></span></span></a>`;
  }

  function renderSocial(data){
    renderForum(Array.isArray(data?.discussions)?data.discussions:[]);
    renderReviews(Array.isArray(data?.reviews)?data.reviews:[]);
    renderCollections(Array.isArray(data?.collections)?data.collections:[]);
    renderTopUsers(Array.isArray(data?.topUsers)?data.topUsers:[]);
  }

  function renderForum(items){
    const host=$('#forumRail');if(!host)return;
    host.innerHTML=items.length?items.map((item)=>`<a class="home-forum-row" href="${sectionUrl(item.bookRef,'discussions')}"><span class="home-forum-title">${esc(item.title||item.bookTitle||'Обсуждение')}</span><span class="home-forum-meta" title="Ответы"><i data-lucide="messages-square"></i>${Number(item.replyCount||0)}</span></a>`).join(''):empty('Тем пока нет');
  }

  function renderReviews(items){
    const host=$('#reviewsRail');if(!host)return;
    host.innerHTML=items.length?items.slice(0,4).map((item)=>{
      const score=Number(item.score||0);
      const sentiment=score>0?'positive':score<0?'negative':'neutral';
      const reviewKind=esc(item.kind||'Отзыв');
      const scoreIcon=score<0?'thumbs-down':'thumbs-up';
      return `<a class="home-review-card" href="${sectionUrl(item.bookRef,'review')}"><span class="home-review-sentiment ${sentiment}" aria-hidden="true"></span><span class="home-review-head"><img class="home-review-cover" loading="lazy" src="${esc(item.coverUrl||'/brand/team-logo.webp')}" alt=""><span class="home-review-head-copy"><span class="home-review-kind">${reviewKind}</span><strong>${esc(item.bookTitle||'Тайтл')}</strong><small>${esc(item.author||'Читатель')}</small></span></span><span class="home-review-body">${esc(item.body||'')}</span><span class="home-review-foot"><span>${esc(dateRelative(item.updatedAt)||'')}</span><span class="home-review-score ${sentiment}"><i data-lucide="${scoreIcon}"></i>${score}</span></span></a>`;
    }).join(''):empty('Отзывов пока нет');
  }

  function renderCollections(items){
    const host=$('#collectionsRail');if(!host)return;
    host.innerHTML=items.length?items.slice(0,4).map(collectionCard).join(''):empty('Коллекций пока нет');
  }

  function collectionCard(item){
    const covers=Array.isArray(item.coverUrls)?item.coverUrls.filter(Boolean).slice(0,2):[];
    const stack=covers.map((src)=>`<img loading="lazy" src="${esc(src)}" alt="">`).join('');
    return `<a class="home-collection-card" href="/collection/?id=${encodeURIComponent(item.id||'')}"><span class="home-collection-stack" aria-hidden="true">${stack}</span><span class="home-collection-copy"><strong>${esc(item.title||'Коллекция')}</strong><small><span>${Number(item.itemCount||0)} тайтлов</span></small></span></a>`;
  }

  function renderTopUsers(items){
    const host=$('#topUsersRail');if(!host)return;
    const leaders=items.slice(0,10);
    const maxActivity=Math.max(1,...leaders.map((item)=>Math.max(0,Number(item.activityCount)||0)));
    host.innerHTML=leaders.length?leaders.map((item)=>{
      const name=String(item.name||'Читатель');
      const initial=esc((name.replace(/^@/,'').trim()[0]||'?').toUpperCase());
      const activity=Math.max(0,Number(item.activityCount)||0);
      const percent=Math.max(0,Math.min(100,Math.round(activity/maxActivity*100)));
      const rank=Number(item.rank||0)||'—';
      return `<div class="home-user-card"><span class="home-user-avatar">${initial}</span><span class="home-user-head"><span class="home-user-name">${esc(name)}</span><span class="home-user-rank">#${rank}</span></span><span class="home-user-stat">${activity} чтений за неделю</span><span class="home-user-progress" role="progressbar" aria-label="Активность ${esc(name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span class="home-user-progress-fill" style="width:${percent}%"></span></span></div>`;
    }).join(''):empty('Статистика чтения ещё собирается');
  }

  function uniqueReleaseTitles(releases,titles){
    const byRef=new Map(titles.map((item)=>[String(item.book_ref||''),item]));
    const result=[];const seen=new Set();
    for(const release of releases){
      const ref=String(release.book_ref||'');if(!ref||seen.has(ref))continue;
      seen.add(ref);result.push(byRef.get(ref)||release);if(result.length>=12)break;
    }
    return result;
  }

  function fillUnique(primary,fallback,limit){
    const result=[];const seen=new Set();
    for(const item of [...primary,...fallback]){
      const key=String(item.book_ref||item.title||'');if(!key||seen.has(key))continue;
      seen.add(key);result.push(item);if(result.length>=limit)break;
    }
    return result;
  }

  function coverCard(item){
    const title=esc(item.title||'Без названия');const cover=esc(item.cover_url||'/brand/team-logo.webp');
    const number=item.last_number||item.latest_number;const badge=number?`Глава ${esc(number)}`:`${Number(item.chapter_count||0)} глав`;
    return `<a class="home-cover-card" href="${titleUrl(item.book_ref)}"><span class="home-cover-media"><img loading="lazy" src="${cover}" alt="Обложка ${title}"><span class="home-cover-badge">${badge}</span></span><span class="home-cover-caption"><strong class="home-cover-title">${title}</strong><small class="home-cover-meta">${esc(metaLabel(item))}</small></span></a>`;
  }

  function renderTop(selector,items){const host=$(selector);if(host)host.innerHTML=items.length?items.map(topItem).join(''):empty('Пока пусто');}
  function topItem(item){
    const title=esc(item.title||'Без названия');const cover=esc(item.cover_url||'/brand/team-logo.webp');
    return `<a class="home-top-item" href="${titleUrl(item.book_ref)}"><img loading="lazy" src="${cover}" alt=""><span class="home-top-copy"><strong>${title}</strong><small>${esc(metaLabel(item))}</small></span></a>`;
  }

  function releaseRow(item){
    const ref=item.book_ref||'';const cover=esc(item.cover_url||'/brand/team-logo.webp');const title=esc(item.title||'Без названия');
    const chapter=esc(chapterLabel(item));const when=esc(dateRelative(item.created_at||item.first_seen_at||item.last_release_at)||'');
    const href=item.latest_chapter_id?readerUrl(ref,item.latest_chapter_id):titleUrl(ref);
    return `<article class="release-row"><a class="release-cover" href="${titleUrl(ref)}"><img loading="lazy" src="${cover}" alt=""></a><div class="release-copy"><a class="release-title" href="${titleUrl(ref)}">${title}</a><div class="release-meta"><a class="release-chapter" href="${href}">${chapter}</a><span class="release-team">Дом Некроманта</span></div></div><time class="release-time">${when}</time></article>`;
  }

  function newestCard(item){
    const title=esc(item.title||'Без названия');const cover=esc(item.cover_url||'/brand/team-logo.webp');
    return `<a class="home-newest-card" href="${titleUrl(item.book_ref)}"><span class="home-cover-media"><img loading="lazy" src="${cover}" alt="Обложка ${title}"></span><span class="home-cover-caption"><strong class="home-cover-title">${title}</strong><small class="home-cover-meta">${esc(metaLabel(item))}</small></span></a>`;
  }

  function readSet(ref){try{return new Set(JSON.parse(localStorage.getItem(`domnkr:reader:${ref}:read`)||'[]').map(String));}catch{return new Set();}}
  function metaLabel(item){const value=String(item.country||item.origin_country||item.original_language||'').trim();return value||'Новелла';}
  function titleUrl(ref){return`/title/?ref=${encodeURIComponent(ref||'')}`;}
  function sectionUrl(ref,section){return`/title/?ref=${encodeURIComponent(ref||'')}&section=${encodeURIComponent(section||'')}`;}
  function readerUrl(ref,chapter){return`/reader/?ref=${encodeURIComponent(ref||'')}&chapter=${encodeURIComponent(chapter||'')}`;}
  function chapterLabel(item){const volume=item.last_volume||item.latest_volume||item.volume;const number=item.last_number||item.latest_number||item.number||item.chapter_id;return[volume?`Том ${volume}`:'',number?`Глава ${number}`:''].filter(Boolean).join(' · ')||'Главы доступны';}
  function empty(message){return`<div class="home-compact-empty">${esc(message)}</div>`;}
  function dateValue(value){const time=new Date(value||0).getTime();return Number.isFinite(time)?time:0;}
  function dateRelative(value){if(!value)return'';const time=new Date(value).getTime();if(!Number.isFinite(time))return'';const minutes=Math.max(1,Math.round((Date.now()-time)/60000));if(minutes<60)return`${minutes} мин. назад`;const hours=Math.round(minutes/60);if(hours<24)return`${hours} ч. назад`;return`${Math.round(hours/24)} дн. назад`;}

  document.addEventListener('DOMContentLoaded',boot);
})();