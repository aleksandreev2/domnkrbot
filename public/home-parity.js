(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();

  async function api(path){
    const response=await fetch(path,{credentials:'same-origin'});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  async function boot(){
    try{
      const data=await api('/api/ranobelib');
      renderCatalog(data||{});
    }catch(error){
      for(const selector of ['#popularUpdates','#topViewsNew','#topViewsRising','#topViewsPopular','#releaseFeed','#newestRail']){
        const host=$(selector);if(host)host.innerHTML=empty(error.message||'Данные временно недоступны');
      }
    }
    try{
      const bootstrap=await api('/api/bootstrap');
      renderProposals(bootstrap?.proposals||[]);
    }catch(error){
      const host=$('#proposalRail');if(host)host.innerHTML=empty('Предложения временно недоступны');
    }
    refreshIcons();
  }

  function renderCatalog(data){
    const titles=Array.isArray(data.titles)?data.titles:[];
    const releases=Array.isArray(data.releases)?data.releases:[];
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

  function renderProposals(items){
    const host=$('#proposalRail');if(!host)return;
    host.innerHTML=items.length?items.slice(0,6).map((item)=>`<a class="home-proposal-row" href="/propose/"><span class="home-proposal-copy"><strong>${esc(item.title)}</strong><small>${esc(item.comment||item.source_url||'Заявка читателя')}</small></span><span class="home-proposal-votes"><i data-lucide="flame"></i>${Number(item.vote_count||0)+(item.is_owner?1:0)}</span></a>`).join(''):empty('Предложений пока нет');
    refreshIcons();
  }

  function metaLabel(item){const value=String(item.country||item.origin_country||item.original_language||'').trim();return value||'Новелла';}
  function titleUrl(ref){return`/title/?ref=${encodeURIComponent(ref||'')}`;}
  function readerUrl(ref,chapter){return`/reader/?ref=${encodeURIComponent(ref||'')}&chapter=${encodeURIComponent(chapter||'')}`;}
  function chapterLabel(item){const volume=item.last_volume||item.latest_volume;const number=item.last_number||item.latest_number;return[volume?`Том ${volume}`:'',number?`Глава ${number}`:''].filter(Boolean).join(' · ')||'Главы доступны';}
  function empty(message){return`<div class="home-compact-empty">${esc(message)}</div>`;}
  function dateValue(value){const time=new Date(value||0).getTime();return Number.isFinite(time)?time:0;}
  function dateRelative(value){if(!value)return'';const time=new Date(value).getTime();if(!Number.isFinite(time))return'';const minutes=Math.max(1,Math.round((Date.now()-time)/60000));if(minutes<60)return`${minutes} мин. назад`;const hours=Math.round(minutes/60);if(hours<24)return`${hours} ч. назад`;return`${Math.round(hours/24)} дн. назад`;}

  document.addEventListener('DOMContentLoaded',boot);
})();
