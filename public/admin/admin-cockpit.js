(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const $$=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon=(name)=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const FILTERS=[['all','Все'],['active','Активные 7д'],['downloaded','Скачивали'],['proposals','С заявками'],['monitoring','Контроль 7д'],['blacklisted','ЧС'],['inactive','Неактивные']];
  const SORTS=[['recent','Недавняя активность'],['downloads','Больше скачиваний'],['proposals','Больше заявок'],['newest','Новые'],['id','Telegram ID']];
  const state={route:'',query:'',filter:'all',sort:'recent',offset:0,limit:30,total:0,selected:null,searchTimer:0,activitySource:'all',activity:[],overviewLoading:false};

  async function api(path,options={}){
    const init={credentials:'same-origin',...options};
    if(init.body&&!init.headers)init.headers={'content-type':'application/json'};
    const response=await fetch(path,init);
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  function setHead(title,description){
    const h=$('#pageTitle'),p=$('#pageDescription');if(h)h.textContent=title;if(p)p.textContent=description;
  }
  function content(html){const root=$('#adminContent');if(root)root.innerHTML=html;refreshIcons();}
  function toast(text,error=false){
    const node=$('#toast');if(!node)return;node.textContent=text;node.classList.toggle('error',error);node.classList.remove('hidden');clearTimeout(node.__cockpitTimer);node.__cockpitTimer=setTimeout(()=>node.classList.add('hidden'),2600);
  }
  function loading(label){content(`<div class="admin-loading">${icon('loader-circle')} ${esc(label)}</div>`);}

  function installNavigation(){
    const app=$('#adminApp');if(!app)return;
    installNavButton($('.admin-side-nav'),'users','users-round','Пользователи','requests');
    installNavButton($('.admin-side-nav'),'activity','activity','Активность','settings');
    installNavButton($('.admin-mobile-nav'),'users','users-round','Пользователи','requests');
    installNavButton($('.admin-mobile-nav'),'activity','activity','Активность','settings');
    $$('[data-route],[data-ops-route]').forEach((button)=>{
      if(button.dataset.cockpitBound)return;button.dataset.cockpitBound='1';
      button.addEventListener('click',()=>deactivate());
    });
    syncActive();refreshIcons();
  }
  function installNavButton(nav,id,ic,label,anchorRoute){
    if(!nav||nav.querySelector(`[data-cockpit-route="${id}"]`))return;
    const button=document.createElement('button');button.type='button';button.dataset.cockpitRoute=id;button.innerHTML=`<span class="nav-icon">${icon(ic)}</span><span>${label}</span>`;
    const anchor=nav.querySelector(`[data-route="${anchorRoute}"]`);if(anchor)anchor.after(button);else nav.append(button);
    button.addEventListener('click',()=>id==='users'?void openUsers():void openActivity());
  }
  function syncActive(){
    $$('[data-cockpit-route]').forEach((button)=>button.classList.toggle('active',button.dataset.cockpitRoute===state.route));
    if(state.route)$$('[data-route],[data-ops-route]').forEach((button)=>button.classList.remove('active'));
  }
  function deactivate(){state.route='';state.selected=null;clearTimeout(state.searchTimer);syncActive();}

  async function openUsers(){
    state.route='users';syncActive();setHead('Пользователи','Поиск, скачивания, заявки, доступ, внутренние заметки и сообщения.');loading('Загружаем пользователей…');
    await renderUsers();
  }
  async function renderUsers(){
    if(state.route!=='users')return;
    const params=new URLSearchParams({filter:state.filter,sort:state.sort,offset:String(state.offset),limit:String(state.limit)});if(state.query)params.set('q',state.query);
    try{
      const data=await api(`/api/admin/users?${params}`);if(state.route!=='users')return;
      state.total=Number(data.total||0);const rows=data.users||[];
      content(`<section class="cockpit-users">
        <div class="admin-panel cockpit-users-toolbar">
          <label class="cockpit-search">${icon('search')}<span class="sr-only">Поиск пользователей</span><input id="cockpitUserSearch" value="${esc(state.query)}" placeholder="@username, имя, Telegram ID, тег или заметка"></label>
          <div class="cockpit-filter-row">${FILTERS.map(([value,label])=>`<button type="button" data-user-filter="${value}" class="${state.filter===value?'active':''}">${label}</button>`).join('')}</div>
          <label class="cockpit-sort"><span>Сортировка</span><select id="cockpitUserSort">${SORTS.map(([value,label])=>`<option value="${value}" ${state.sort===value?'selected':''}>${label}</option>`).join('')}</select></label>
          <span class="cockpit-count">${fmt(state.total)} пользователей</span>
        </div>
        <div class="cockpit-users-layout">
          <section class="admin-panel cockpit-user-list">
            <div class="cockpit-user-list-body">${rows.length?rows.map(userRow).join(''):'<div class="admin-empty">Пользователи не найдены.</div>'}</div>
            <div class="cockpit-pagination"><button type="button" data-user-page="prev" ${state.offset<=0?'disabled':''}>${icon('chevron-left')} Назад</button><span>${rows.length?`${state.offset+1}–${state.offset+rows.length}`:'0'} из ${fmt(state.total)}</span><button type="button" data-user-page="next" ${data.hasMore?'':'disabled'}>Дальше ${icon('chevron-right')}</button></div>
          </section>
          <section class="admin-panel cockpit-user-detail" id="cockpitUserDetail"><div class="cockpit-user-placeholder">${icon('user-round-search')}<strong>Выберите пользователя</strong><span>Профиль покажет выдачи, заявки, ЧС, историю и административные действия.</span></div></section>
        </div>
      </section>`);
      bindUsers(rows,Boolean(data.hasMore));
      if(state.selected&&rows.some((row)=>String(row.telegram_id)===String(state.selected)))void openUser(state.selected);
    }catch(error){if(state.route==='users')content(`<div class="notice error">${esc(error.message)}</div>`);}
  }

  function userRow(user){
    const name=user.first_name||user.username||`ID ${user.telegram_id}`;
    const status=user.blacklisted_at?'ЧС':isMonitored(user.last_download_at)?'Контроль 7д':user.last_status==='member'?'В канале':Number(user.deliveries)>0?'Читатель':'Пользователь';
    const tone=user.blacklisted_at?'danger':isMonitored(user.last_download_at)?'warning':Number(user.deliveries)>0?'good':'neutral';
    return `<button type="button" class="cockpit-user-row ${user.blacklisted_at?'blocked':''}" data-user-id="${esc(user.telegram_id)}">
      <span class="cockpit-user-avatar">${esc(initial(name))}</span>
      <span class="cockpit-user-copy"><strong>${esc(name)}</strong><span>${user.username?`@${esc(user.username)} · `:''}${esc(user.telegram_id)}</span><small>${fmt(user.deliveries)} файлов · ${fmt(user.releases)} релизов · ${fmt(user.proposals)} заявок</small></span>
      <span class="cockpit-user-side"><span class="cockpit-status ${tone}">${esc(status)}</span><small>${dateTime(user.last_activity)}</small></span>
    </button>`;
  }

  function bindUsers(rows,hasMore){
    const input=$('#cockpitUserSearch');
    input?.addEventListener('input',(event)=>{clearTimeout(state.searchTimer);const value=event.currentTarget.value.trim();state.searchTimer=setTimeout(()=>{if(state.route!=='users'||value===state.query)return;state.query=value;state.offset=0;void renderUsers();},350);});
    input?.addEventListener('keydown',(event)=>{if(event.key!=='Enter')return;clearTimeout(state.searchTimer);const value=event.currentTarget.value.trim();if(value===state.query)return;state.query=value;state.offset=0;void renderUsers();});
    $$('[data-user-filter]').forEach((button)=>button.addEventListener('click',()=>{state.filter=button.dataset.userFilter||'all';state.offset=0;state.selected=null;void renderUsers();}));
    $('#cockpitUserSort')?.addEventListener('change',(event)=>{state.sort=event.currentTarget.value;state.offset=0;void renderUsers();});
    $$('[data-user-page]').forEach((button)=>button.addEventListener('click',()=>{if(button.disabled)return;state.offset=Math.max(0,state.offset+(button.dataset.userPage==='next'&&hasMore?state.limit:-state.limit));state.selected=null;void renderUsers();}));
    $$('[data-user-id]').forEach((button)=>button.addEventListener('click',()=>void openUser(button.dataset.userId)));
    refreshIcons();
  }

  async function openUser(id){
    if(state.route!=='users')return;state.selected=String(id);$$('[data-user-id]').forEach((node)=>node.classList.toggle('selected',String(node.dataset.userId)===state.selected));
    const box=$('#cockpitUserDetail');if(!box)return;box.innerHTML=`<div class="admin-loading">${icon('loader-circle')} Загружаем профиль…</div>`;refreshIcons();
    try{
      const data=await api(`/api/admin/users/${encodeURIComponent(state.selected)}`);if(state.route!=='users'||String(state.selected)!==String(id)||!box.isConnected)return;
      paintUserDetail(box,data);
    }catch(error){if(box.isConnected)box.innerHTML=`<div class="notice error">${esc(error.message)}</div>`;}
  }

  function paintUserDetail(box,data){
    const user=data.user||{},stats=data.stats||{},blacklisted=Boolean(user.blacklisted_at),monitoring=!blacklisted&&isMonitored(stats.last_download_at);
    const name=user.first_name||user.username||`ID ${user.telegram_id}`;
    box.innerHTML=`<div class="cockpit-profile-head"><span class="cockpit-profile-avatar">${esc(initial(name))}</span><div><span class="admin-kicker">TELEGRAM USER</span><h2>${esc(name)}</h2><p>${user.username?`<a href="https://t.me/${esc(user.username)}" target="_blank" rel="noopener noreferrer">@${esc(user.username)}</a> · `:''}${esc(user.telegram_id)}${user.language_code?` · ${esc(user.language_code)}`:''}</p></div><span class="cockpit-status ${blacklisted?'danger':monitoring?'warning':'good'}">${blacklisted?'Чёрный список':monitoring?'Контроль 7д':'Доступен'}</span></div>
      <div class="cockpit-profile-stats"><div><span>Файлов</span><strong>${fmt(stats.deliveries)}</strong></div><div><span>Релизов</span><strong>${fmt(stats.releases)}</strong></div><div><span>Заявок</span><strong>${fmt(stats.proposals)}</strong></div><div><span>Спасибо</span><strong>${fmt(stats.thanks)}</strong></div><div><span>Boosty</span><strong>${fmt(stats.support_clicks)}</strong></div><div><span>Последняя выдача</span><strong class="small">${dateTime(stats.last_download_at)}</strong></div></div>
      <div class="cockpit-access-grid"><article class="cockpit-access-card ${blacklisted?'bad':'good'}">${icon(blacklisted?'shield-x':'shield-check')}<div><small>DOWNLOAD ACCESS</small><strong>${blacklisted?'Заблокирован':'Разрешён'}</strong><span>${blacklisted?esc(user.blacklist_reason||'Внутренний blacklist'):monitoring?'Идёт 7-дневное окно контроля':'Активного ограничения нет'}</span></div></article><article class="cockpit-access-card">${icon('radio')}<div><small>CHANNEL</small><strong>${esc(channelStatus(user.last_status))}</strong><span>${user.last_checked_at?`Проверено ${dateTime(user.last_checked_at)}`:'Ещё не проверялся'}</span></div></article></div>
      ${blacklisted?`<div class="cockpit-commandbar"><button type="button" class="danger-outline" id="cockpitUnblock">${icon('shield-check')} Снять ЧС</button></div>`:''}
      <section class="cockpit-profile-section"><div class="admin-panel-head"><div><h3>Внутренние данные</h3><p>Теги и заметки видны только в админке.</p></div><button type="button" id="cockpitSaveControl">${icon('save')} Сохранить</button></div><label class="cockpit-field"><span>Теги</span><input id="cockpitUserTags" value="${esc((user.tags||[]).join(', '))}" maxlength="500" placeholder="trusted, translator, problematic"></label><label class="cockpit-field"><span>Заметки</span><textarea id="cockpitUserNotes" rows="4" maxlength="2000" placeholder="Контекст, договорённости, важные замечания…">${esc(user.notes||'')}</textarea></label></section>
      <section class="cockpit-profile-section cockpit-message-user"><div class="admin-panel-head"><div><h3>Написать пользователю</h3><p>Прямое plain-text сообщение от Telegram-бота. Действие пишется в audit.</p></div></div><textarea id="cockpitMessageText" rows="4" maxlength="3500" placeholder="Сообщение…"></textarea><div><span id="cockpitMessageCount">0 / 3500</span><button type="button" id="cockpitSendMessage">${icon('send')} Отправить</button></div></section>
      <section class="cockpit-profile-section"><div class="admin-panel-head"><div><h3>Последние релизы</h3><p>Фактически выданные файлы.</p></div></div>${deliveryRows(data.deliveries||[])}</section>
      <section class="cockpit-profile-section"><div class="admin-panel-head"><div><h3>Заявки</h3><p>Последние предложения пользователя.</p></div></div>${proposalRows(data.proposals||[])}</section>
      <section class="cockpit-profile-section"><div class="admin-panel-head"><div><h3>Timeline</h3><p>Выдачи, действия читателя и админские изменения.</p></div></div>${timelineRows(data.timeline||[])}</section>
      <section class="cockpit-profile-section"><div class="admin-panel-head"><div><h3>Сообщения администратора</h3><p>История последних отправок.</p></div></div>${messageRows(data.messages||[])}</section>`;
    bindUserActions(user);refreshIcons();
  }

  function bindUserActions(user){
    $('#cockpitSaveControl')?.addEventListener('click',()=>void saveControl(user.telegram_id));
    $('#cockpitUnblock')?.addEventListener('click',()=>void unblock(user.telegram_id));
    const text=$('#cockpitMessageText'),count=$('#cockpitMessageCount');text?.addEventListener('input',()=>{if(count)count.textContent=`${text.value.length} / 3500`;});
    $('#cockpitSendMessage')?.addEventListener('click',()=>void sendMessage(user.telegram_id));
  }
  async function saveControl(userId){
    const button=$('#cockpitSaveControl');if(button)button.disabled=true;
    try{await api(`/api/admin/users/${userId}/control`,{method:'POST',body:JSON.stringify({tags:$('#cockpitUserTags')?.value||'',notes:$('#cockpitUserNotes')?.value||''})});toast('Данные пользователя сохранены.');await openUser(userId);}catch(error){toast(error.message,true);}finally{if(button)button.disabled=false;}
  }
  async function unblock(userId){
    if(!confirm('Снять внутренний blacklist и снова разрешить скачивания?'))return;
    const button=$('#cockpitUnblock');if(button)button.disabled=true;
    try{await api(`/api/admin/membership-access/${userId}/unblock`,{method:'POST'});toast('Пользователь разблокирован.');await openUser(userId);void enhanceOverview(true);}catch(error){toast(error.message,true);}finally{if(button)button.disabled=false;}
  }
  async function sendMessage(userId){
    const text=$('#cockpitMessageText')?.value.trim()||'';if(!text){toast('Введите сообщение.',true);return;}if(!confirm(`Отправить сообщение пользователю ${userId}?`))return;
    const button=$('#cockpitSendMessage');if(button)button.disabled=true;
    try{await api(`/api/admin/users/${userId}/message`,{method:'POST',body:JSON.stringify({text})});toast('Сообщение отправлено.');await openUser(userId);}catch(error){toast(error.message,true);}finally{if(button)button.disabled=false;}
  }

  function deliveryRows(rows){if(!rows.length)return'<div class="admin-empty">Файлы через бота ещё не выдавались.</div>';return`<div class="cockpit-detail-list">${rows.map((row)=>`<div><span class="cockpit-detail-icon">${icon('file-down')}</span><div><strong>${esc(row.internal_title||`Публикация #${row.publication_id}`)}</strong><span>${fmt(row.files)} файл(ов)${Number(row.repeats)>0?` · ${fmt(row.repeats)} повторов`:''}</span></div><time>${dateTime(row.last_delivered_at)}</time></div>`).join('')}</div>`;}
  function proposalRows(rows){if(!rows.length)return'<div class="admin-empty">Заявок нет.</div>';return`<div class="cockpit-detail-list">${rows.map((row)=>`<div><span class="cockpit-detail-icon">${icon('inbox')}</span><div><strong>${esc(row.title)}</strong><span>${esc(row.proposal_type||'title')} · ${esc(row.status||'pending')}</span></div><time>${dateTime(row.created_at)}</time></div>`).join('')}</div>`;}
  function timelineRows(rows){if(!rows.length)return'<div class="admin-empty">История пока пуста.</div>';return`<div class="cockpit-timeline">${rows.map((row)=>`<div class="${row.tone==='danger'?'danger':row.tone==='success'?'success':''}"><span>${icon(timelineIcon(row.type))}</span><div><strong>${esc(row.title)}</strong><small>${esc(row.detail||'')}</small></div><time>${dateTime(row.at)}</time></div>`).join('')}</div>`;}
  function messageRows(rows){if(!rows.length)return'<div class="admin-empty">Сообщений ещё не было.</div>';return`<div class="cockpit-detail-list">${rows.map((row)=>`<div><span class="cockpit-detail-icon">${icon(row.status==='sent'?'send':'circle-x')}</span><div><strong>${row.status==='sent'?'Отправлено':'Ошибка доставки'}</strong><span>${esc(String(row.text||'').slice(0,180))}${row.error_text?` · ${esc(row.error_text)}`:''}</span></div><time>${dateTime(row.created_at)}</time></div>`).join('')}</div>`;}

  async function openActivity(){
    state.route='activity';syncActive();setHead('Активность','Единая лента публикаций, читателей, заявок и административных действий.');loading('Собираем журнал…');
    try{const data=await api('/api/admin/activity?limit=120');if(state.route!=='activity')return;state.activity=data.events||[];paintActivity();}catch(error){if(state.route==='activity')content(`<div class="notice error">${esc(error.message)}</div>`);}
  }
  function paintActivity(){
    const sources=[['all','Всё'],['admin','Админ'],['publication','Публикации'],['reader','Читатели'],['proposal','Заявки']];const rows=state.activity.filter((row)=>state.activitySource==='all'||row.source===state.activitySource);
    content(`<section class="cockpit-activity"><div class="admin-panel cockpit-activity-toolbar"><div class="cockpit-filter-row">${sources.map(([value,label])=>`<button type="button" data-activity-source="${value}" class="${state.activitySource===value?'active':''}">${label}</button>`).join('')}</div><span>${fmt(rows.length)} событий</span></div><section class="admin-panel cockpit-activity-feed">${rows.length?rows.map(activityRow).join(''):'<div class="admin-empty">Событий нет.</div>'}</section></section>`);
    $$('[data-activity-source]').forEach((button)=>button.addEventListener('click',()=>{state.activitySource=button.dataset.activitySource||'all';paintActivity();}));refreshIcons();
  }
  function activityRow(row){return`<article class="${Number(row.success)===0?'failed':''}"><span class="cockpit-activity-icon">${icon(activityIcon(row.source,row.kind))}</span><div><strong>${esc(activityLabel(row.kind))}</strong><span>${esc(activityDetail(row))}</span></div><time>${dateTime(row.created_at)}</time></article>`;}

  async function enhanceOverview(force=false){
    if(state.route||$('#pageTitle')?.textContent!=='Обзор')return;const root=$('#adminContent');if(!root)return;if(!force&&root.querySelector('[data-cockpit-overview]'))return;if(state.overviewLoading)return;state.overviewLoading=true;
    try{
      const data=await api('/api/admin/users/summary');if(state.route||$('#pageTitle')?.textContent!=='Обзор'||!root.isConnected)return;root.querySelector('[data-cockpit-overview]')?.remove();const s=data.summary||{};
      const section=document.createElement('section');section.dataset.cockpitOverview='1';section.className='cockpit-overview-strip';section.innerHTML=`<button type="button" data-cockpit-jump="users"><span>${icon('users-round')}</span><div><small>Пользователи</small><strong>${fmt(s.users)}</strong><em>${fmt(s.active_readers_7d)} читателей · 7д</em></div></button><button type="button" data-cockpit-jump="users-monitoring"><span>${icon('shield-check')}</span><div><small>Под контролем</small><strong>${fmt(s.monitoring)}</strong><em>7 дней после выдачи</em></div></button><button type="button" data-cockpit-jump="users-blacklisted" class="${Number(s.blacklisted)>0?'attention':''}"><span>${icon('shield-x')}</span><div><small>Чёрный список</small><strong>${fmt(s.blacklisted)}</strong><em>ручная разблокировка</em></div></button><button type="button" data-cockpit-jump="activity" class="${Number(s.delivery_failures_24h)>0?'attention':''}"><span>${icon('activity')}</span><div><small>Delivery ошибки</small><strong>${fmt(s.delivery_failures_24h)}</strong><em>за последние 24 часа</em></div></button>`;
      root.prepend(section);section.querySelector('[data-cockpit-jump="users"]')?.addEventListener('click',()=>void openUsers());section.querySelector('[data-cockpit-jump="users-monitoring"]')?.addEventListener('click',()=>{state.filter='monitoring';state.offset=0;void openUsers();});section.querySelector('[data-cockpit-jump="users-blacklisted"]')?.addEventListener('click',()=>{state.filter='blacklisted';state.offset=0;void openUsers();});section.querySelector('[data-cockpit-jump="activity"]')?.addEventListener('click',()=>void openActivity());refreshIcons();
    }catch{}finally{state.overviewLoading=false;}
  }

  function isMonitored(value){const time=Date.parse(value||'');return Number.isFinite(time)&&Date.now()-time<=7*24*60*60*1000;}
  function channelStatus(status){return({creator:'В канале',administrator:'В канале',member:'В канале',restricted:'Ограничен',left:'Вышел',kicked:'Удалён'})[status]||status||'Не проверен';}
  function initial(value){return String(value||'?').trim().charAt(0).toUpperCase()||'?';}
  function fmt(value){return new Intl.NumberFormat('ru-RU').format(Number(value||0));}
  function dateTime(value){if(!value)return'—';const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'}):String(value);}
  function timelineIcon(type){return({created:'user-plus',blacklist:'shield-x',delivery:'file-down',proposal:'inbox',download_open:'mouse-pointer-click',delivery_success:'file-check-2',delivery_failed:'triangle-alert',thank_you_click:'heart',support_click:'heart-handshake',admin_message:'send',admin:'shield'})[type]||'circle';}
  function activityIcon(source,kind){if(source==='admin')return'shield';if(source==='publication')return'send';if(source==='proposal')return'inbox';if(kind==='delivery_failed')return'triangle-alert';if(kind==='delivery_success')return'file-check-2';if(kind==='support_click')return'heart-handshake';return'activity';}
  function activityLabel(kind){return({delivery_success:'Файл выдан',delivery_failed:'Ошибка выдачи',download_open:'Скачивание открыто',thank_you_click:'Спасибо',support_click:'Переход на Boosty',user_control_update:'Изменён профиль пользователя',user_message:'Сообщение пользователю',user_message_failed:'Ошибка сообщения',published_with_download_gate:'Релиз опубликован'})[kind]||String(kind||'Событие').replace(/^proposal_/,'Заявка: ');}
  function activityDetail(row){if(row.source==='proposal')return`${row.detail||'Без названия'} · user ${row.subject||'—'}`;if(row.source==='reader')return`user ${row.subject||'—'}${row.detail?` · ${safeJson(row.detail)}`:''}`;if(row.source==='publication')return`publication #${row.subject||'—'} · ${row.detail||''}`;if(row.source==='admin')return`target ${row.subject||'—'}${row.detail?` · ${safeJson(row.detail)}`:''}`;return row.detail||'';}
  function safeJson(value){try{const parsed=JSON.parse(String(value));if(parsed?.message)return String(parsed.message);if(parsed?.error)return String(parsed.error);return JSON.stringify(parsed).slice(0,180);}catch{return String(value).slice(0,180);}}

  const observer=new MutationObserver(()=>queueMicrotask(()=>{installNavigation();void enhanceOverview();}));
  document.addEventListener('DOMContentLoaded',()=>{const app=$('#adminApp');if(app)observer.observe(app,{childList:true,subtree:true});installNavigation();void enhanceOverview();});
})();
