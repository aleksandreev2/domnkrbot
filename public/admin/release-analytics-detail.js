(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const $$=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon=(name)=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  let releaseRequest=null;
  let userRequest=null;
  let currentPublicationId=0;

  async function api(path,signal){
    const response=await fetch(path,{credentials:'same-origin',signal});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }
  function statsActive(){return Boolean($('[data-ops-route="statistics"].active'));}
  function releaseId(row){
    const text=$('.statistics-release-title small',row)?.textContent||'';
    const match=/#(\d+)/.exec(text);
    return match?Number(match[1]):0;
  }
  function setHead(title,description){
    const h=$('#pageTitle'),p=$('#pageDescription');if(h)h.textContent=title;if(p)p.textContent=description;
  }
  function content(html){const root=$('#adminContent');if(root)root.innerHTML=html;refreshIcons();}
  function fmt(value){return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(Number(value||0));}
  function dateTime(value){if(!value)return'—';const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'}):String(value);}
  function size(value){let n=Number(value||0);if(!Number.isFinite(n)||n<=0)return'0 Б';const units=['Б','КБ','МБ','ГБ'];let i=0;while(n>=1024&&i<units.length-1){n/=1024;i+=1;}return`${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:i?1:0}).format(n)} ${units[i]}`;}
  function userName(row){if(row.username)return`@${row.username}`;const name=[row.first_name,row.last_name].filter(Boolean).join(' ').trim();return name||`ID ${row.user_telegram_id}`;}
  function initial(row){return userName(row).replace(/^@/,'').slice(0,1).toLocaleUpperCase()||'?';}

  document.addEventListener('click',(event)=>{
    const row=event.target.closest?.('.statistics-release-row');
    if(row&&statsActive()){
      const id=releaseId(row);if(id){event.preventDefault();void openRelease(id);return;}
    }
    const user=event.target.closest?.('[data-release-user]');
    if(user&&currentPublicationId){event.preventDefault();void openUser(currentPublicationId,user.dataset.releaseUser,user);}
  });
  document.addEventListener('keydown',(event)=>{
    if(event.key!=='Enter'&&event.key!==' ')return;
    const row=event.target.closest?.('.statistics-release-row[data-release-detail-ready]');
    if(!row||!statsActive())return;
    const id=releaseId(row);if(!id)return;event.preventDefault();void openRelease(id);
  });

  const enhanceObserver=new MutationObserver((records)=>{
    let found=false;
    for(const record of records){for(const node of record.addedNodes){if(node.nodeType!==Node.ELEMENT_NODE)continue;const el=node;if(el.matches?.('.statistics-release-row')||el.querySelector?.('.statistics-release-row')){found=true;break;}}if(found)break;}
    if(!found)return;
    for(const row of $$('.statistics-release-row:not([data-release-detail-ready])')){
      row.dataset.releaseDetailReady='1';row.tabIndex=0;row.setAttribute('role','button');row.setAttribute('aria-label',`Открыть статистику релиза ${$('.statistics-release-title strong',row)?.textContent||''}`.trim());
    }
  });
  document.addEventListener('DOMContentLoaded',()=>{const root=$('#adminContent');if(root)enhanceObserver.observe(root,{childList:true,subtree:true});});

  async function openRelease(id){
    if(!Number.isSafeInteger(id)||id<1)return;
    currentPublicationId=id;
    releaseRequest?.abort();userRequest?.abort();
    releaseRequest=new AbortController();
    setHead('Статистика релиза',`Пользователи, файлы и точная история выдачи для публикации #${id}.`);
    content(`<div class="admin-loading">${icon('loader-circle')} Загружаем релиз #${id}…</div>`);
    try{
      const data=await api(`/api/admin/publishing-analytics/release?publication_id=${encodeURIComponent(id)}`,releaseRequest.signal);
      if(currentPublicationId!==id||!statsActive())return;
      paintRelease(data);
    }catch(error){if(error.name==='AbortError'||!statsActive())return;content(`<section class="release-detail-page"><button type="button" class="release-detail-back" data-release-back>${icon('arrow-left')} К общей статистике</button><div class="notice error">${esc(error.message)}</div></section>`);bindBack();}
  }

  function paintRelease(data){
    const p=data.publication||{},s=data.summary||{},users=data.users||[],files=data.files||[];
    const gate=gateState(p);
    content(`<section class="release-detail-page" data-release-detail-page>
      <button type="button" class="release-detail-back" data-release-back>${icon('arrow-left')} К общей статистике</button>
      <section class="admin-panel release-detail-hero">
        <div><span class="admin-kicker">РЕЛИЗ #${fmt(p.id)}</span><h2>${esc(p.internal_title||`Публикация #${p.id}`)}</h2><p>${p.published_at?`Опубликован ${dateTime(p.published_at)}`:'Не опубликован'} · ${fmt(files.length)} файл(ов)</p></div>
        <span class="statistics-status ${gate.tone}">${esc(gate.label)}</span>
      </section>
      <div class="release-detail-kpis">
        ${metric('users-round','Читатели',s.readers)}
        ${metric('bot','Открытия бота',s.download_opens)}
        ${metric('file-check-2','Выдано файлов',s.deliveries)}
        ${metric('rotate-ccw','Повторы',s.repeat_deliveries)}
        ${metric('heart','Спасибо',s.thanks)}
        ${metric('heart-handshake','Поддержка',s.support_clicks)}
        ${metric('triangle-alert','Ошибки',s.delivery_failures)}
        ${metric('percent','Open → reader',`${fmt(s.open_to_reader_rate)}%`)}
      </div>
      <div class="release-detail-top-grid">
        <section class="admin-panel release-detail-panel">
          ${panelHead('paperclip','Файлы','Что именно выдаёт бот и насколько стабильно.')}
          ${fileRows(files)}
        </section>
        <section class="admin-panel release-detail-panel">
          ${panelHead('messages-square','Comment gate','Привязка канального поста к discussion и служебному комментарию.')}
          ${gateCard(p)}
        </section>
      </div>
      <div class="release-reader-layout">
        <section class="admin-panel release-detail-panel release-reader-list-panel">
          ${panelHead('users-round','Пользователи','Кликните на человека: справа будет точная история его действий.')}
          <label class="release-reader-search">${icon('search')}<input type="search" data-release-user-search placeholder="Имя, @username или Telegram ID" autocomplete="off"></label>
          <div class="release-reader-list" data-release-user-list>${userRows(users)}</div>
        </section>
        <section class="admin-panel release-detail-panel release-user-detail" data-release-user-detail>
          <div class="release-detail-empty">${icon('mouse-pointer-click')}<strong>Выберите пользователя</strong><span>Покажем «Спасибо», открытие бота, каждую выдачу, повторы, ошибки, способ доставки и состояние подписки.</span></div>
        </section>
      </div>
    </section>`);
    bindBack();
    $('[data-release-user-search]')?.addEventListener('input',(event)=>filterUsers(event.currentTarget.value));
    refreshIcons();
  }

  function bindBack(){$('[data-release-back]')?.addEventListener('click',()=>{currentPublicationId=0;releaseRequest?.abort();userRequest?.abort();$('[data-ops-route="statistics"]')?.click();});}
  function metric(ic,label,value){return`<article><span>${icon(ic)}</span><div><small>${esc(label)}</small><strong>${typeof value==='string'?esc(value):fmt(value)}</strong></div></article>`;}
  function panelHead(ic,title,subtitle){return`<div class="statistics-panel-head"><div><span class="statistics-panel-icon">${icon(ic)}</span><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div></div></div>`;}

  function fileRows(rows){
    if(!rows.length)return`<div class="release-detail-empty">${icon('inbox')}<span>Файлы к релизу не прикреплены.</span></div>`;
    return`<div class="release-file-list">${rows.map((row)=>`<article><span class="release-file-icon">${icon('file-archive')}</span><div><strong>${esc(row.file_name)}</strong><small>${size(row.size_bytes)} · ${row.telegram_file_id?'Telegram file_id готов':'R2 upload при первой выдаче'}</small></div><div class="release-file-metrics"><span><b>${fmt(row.readers)}</b> чит.</span><span><b>${fmt(row.deliveries)}</b> выдач</span><span><b>${fmt(row.repeats)}</b> повт.</span>${Number(row.failures||0)?`<span class="bad"><b>${fmt(row.failures)}</b> ошибок</span>`:''}</div></article>`).join('')}</div>`;
  }
  function gateState(p){const status=String(p.gate_status||'missing');if(status==='sent')return{label:'Готов',tone:'good'};if(status==='waiting_forward'||status==='pending')return{label:'Ожидает',tone:'wait'};if(status==='failed')return{label:'Ошибка',tone:'bad'};return{label:'Legacy',tone:'neutral'};}
  function gateCard(p){
    const state=gateState(p);
    return`<div class="release-gate-card ${state.tone}"><div class="release-gate-main"><span>${icon(state.tone==='good'?'message-circle-check':'message-circle-warning')}</span><div><small>STATUS</small><strong>${esc(state.label)}</strong><p>${p.gate_error?esc(p.gate_error):state.tone==='good'?'Служебный комментарий связан с automatic forward Telegram.':'Проверьте связку discussion и состояние публикации.'}</p></div></div><dl><div><dt>Channel message</dt><dd>${fmt(p.channel_message_id)||'—'}</dd></div><div><dt>Discussion</dt><dd>${fmt(p.discussion_message_id)||'—'}</dd></div><div><dt>Gate message</dt><dd>${fmt(p.gate_message_id)||'—'}</dd></div><div><dt>Попытки</dt><dd>${fmt(p.gate_attempts)}</dd></div></dl></div>`;
  }

  function userRows(rows){
    if(!rows.length)return`<div class="release-detail-empty">${icon('users')}<span>По этому релизу пока нет действий пользователей.</span></div>`;
    return rows.map((row)=>{
      const name=userName(row),search=[row.username,row.first_name,row.last_name,row.user_telegram_id].filter(Boolean).join(' ').toLocaleLowerCase();
      const access=row.blacklisted_at?'<span class="statistics-status bad">ЧС</span>':row.last_status==='member'||row.last_status==='administrator'||row.last_status==='creator'?'<span class="statistics-status good">В канале</span>':'<span class="statistics-status neutral">'+esc(row.last_status||'unknown')+'</span>';
      return`<button type="button" class="release-reader-row" data-release-user="${esc(row.user_telegram_id)}" data-release-user-search="${esc(search)}"><span class="release-reader-avatar">${esc(initial(row))}</span><span class="release-reader-main"><strong>${esc(name)}</strong><small>ID ${esc(row.user_telegram_id)} · ${dateTime(row.last_seen)}</small><span><b>${fmt(row.download_opens)}</b> open · <b>${fmt(row.deliveries)}</b> файлов · <b>${fmt(row.repeat_deliveries)}</b> повторов${Number(row.delivery_failures||0)?` · <em>${fmt(row.delivery_failures)} ошибок</em>`:''}</span></span><span class="release-reader-side">${row.thanked?'<span class="release-thanks">♥ Спасибо</span>':'<span class="release-no-thanks">без спасибо</span>'}${access}${icon('chevron-right')}</span></button>`;
    }).join('');
  }
  function filterUsers(query){const needle=String(query||'').trim().toLocaleLowerCase();$$('[data-release-user]').forEach((row)=>{row.hidden=Boolean(needle)&&!String(row.dataset.releaseUserSearch||'').includes(needle);});}

  async function openUser(publicationId,userId,button){
    if(!/^\d+$/.test(String(userId||'')))return;
    userRequest?.abort();userRequest=new AbortController();
    $$('[data-release-user]').forEach((row)=>row.classList.toggle('active',row===button));
    const host=$('[data-release-user-detail]');if(!host)return;
    host.innerHTML=`<div class="admin-loading">${icon('loader-circle')} Загружаем историю…</div>`;refreshIcons();
    try{
      const data=await api(`/api/admin/publishing-analytics/release?publication_id=${encodeURIComponent(publicationId)}&user_id=${encodeURIComponent(userId)}`,userRequest.signal);
      if(currentPublicationId!==publicationId||!host.isConnected)return;
      host.innerHTML=userDetail(data.user||{},data.deliveries||[],data.events||[]);refreshIcons();
    }catch(error){if(error.name==='AbortError'||!host.isConnected)return;host.innerHTML=`<div class="notice error">${esc(error.message)}</div>`;}
  }

  function userDetail(user,deliveries,events){
    const name=userName(user);
    const access=user.blacklisted_at?'Чёрный список':user.last_status==='member'||user.last_status==='administrator'||user.last_status==='creator'?'Подписан':'Не подтверждён';
    return`<div class="release-user-profile">
      <div class="release-user-profile-head"><span class="release-reader-avatar large">${esc(initial(user))}</span><div><span class="admin-kicker">TELEGRAM USER</span><h3>${esc(name)}</h3><p>ID ${esc(user.user_telegram_id||'—')} · ${esc(access)}${user.blacklisted_at?` · ЧС с ${dateTime(user.blacklisted_at)}`:''}</p></div></div>
      <div class="release-user-kpis">${smallMetric('message-circle-more','CTA',user.gate_clicks)}${smallMetric('bot','Open',user.download_opens)}${smallMetric('file-check-2','Файлы',user.deliveries)}${smallMetric('rotate-ccw','Повторы',user.repeat_deliveries)}${smallMetric('heart','Спасибо',user.thanked?'Да':'Нет')}${smallMetric('heart-handshake','Boosty',user.support_clicks)}</div>
      <section><h4>Состояние файлов</h4>${deliveryRows(deliveries)}</section>
      <section><h4>Точная история</h4>${timeline(events)}</section>
    </div>`;
  }
  function smallMetric(ic,label,value){return`<div>${icon(ic)}<span>${esc(label)}</span><strong>${typeof value==='string'?esc(value):fmt(value)}</strong></div>`;}
  function deliveryRows(rows){if(!rows.length)return`<div class="release-detail-empty compact">${icon('inbox')}<span>Записей выдачи нет.</span></div>`;return`<div class="release-delivery-list">${rows.map((row)=>`<article><div><strong>${esc(row.file_name)}</strong><small>${esc(row.status)} · попыток ${fmt(row.attempts)}</small></div><span>${dateTime(row.last_delivered_at||row.updated_at)}</span>${row.last_error?`<p>${esc(row.last_error)}</p>`:''}</article>`).join('')}</div>`;}

  const EVENT_LABELS={download_gate_click:['Нажал gate','message-circle-more'],thank_you_click:['Нажал «Спасибо»','heart'],thank_you_required:['Попытка без «Спасибо»','circle-alert'],download_open:['Открыл бота','bot'],delivery_started:['Началась выдача','send'],delivery_success:['Получил файл','file-check-2'],delivery_failed:['Ошибка выдачи','file-x-2'],support_click:['Перешёл на Boosty','heart-handshake']};
  function timeline(rows){
    if(!rows.length)return`<div class="release-detail-empty compact">${icon('history')}<span>Событий пока нет.</span></div>`;
    return`<div class="release-timeline">${rows.map((row)=>{const [label,ic]=EVENT_LABELS[row.event_type]||[String(row.event_type||'Событие'),'activity'];const details=row.details&&typeof row.details==='object'?row.details:{};const bits=[row.file_name||'',row.repeat?'повтор':'',details.transport==='telegram_file_id'?'Telegram file_id':details.transport==='r2_upload'?'R2 upload':'',Number.isFinite(Number(details.latency_ms))?`${fmt(details.latency_ms)} мс`:''].filter(Boolean);return`<article class="${row.success===false?'bad':''}"><span>${icon(ic)}</span><div><strong>${esc(label)}</strong>${bits.length?`<small>${esc(bits.join(' · '))}</small>`:''}${details.error?`<p>${esc(details.error)}</p>`:''}</div><time>${dateTime(row.created_at)}</time></article>`;}).join('')}</div>`;
  }
})();