(() => {
  const state={session:null,route:'overview',publishingTab:'create',dashboard:null,publishing:null,center:null,files:null,requests:null,saveTimer:0,preflightTimer:0};
  const $=(selector,root=document)=>root.querySelector(selector);
  const $$=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const builtins=[
    {name:'Релиз новых глав',internal_title:'',body_html:'Новые главы уже доступны.\n\nПриятного чтения!',add_footer:1,add_bot_comment:1},
    {name:'Новый тайтл',internal_title:'',body_html:'Новый перевод появился в «Доме Некроманта».\n\nПервые главы уже доступны.',add_footer:1,add_bot_comment:1},
    {name:'Перевод завершён',internal_title:'',body_html:'Перевод завершён.\n\nСпасибо, что читали вместе с нами.',add_footer:1,add_bot_comment:1},
    {name:'Объявление',internal_title:'',body_html:'',add_footer:1,add_bot_comment:0},
  ];
  const routeMeta={overview:['Обзор','Состояние переводов, публикаций и файлов.'],publishing:['Publishing','Создание, проверка и публикация релизов.'],requests:['Заявки','Модерация предложений сообщества.'],files:['Файлы','Все вложения публикаций в одном месте.'],sync:['RanobeLib','Состояние каталога и ручная синхронизация.'],settings:['Настройки','Telegram-канал, комментарии и файловое хранилище.']};
  const requestTabDefs=[
    {key:'pending',label:'Новые'},
    {key:'approved',label:'Одобрено'},
    {key:'planned',label:'В плане'},
    {key:'in_progress',label:'В работе'},
    {key:'closed',label:'Закрытые'},
  ];

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const contentType=response.headers.get('content-type')||'';
    const body=contentType.includes('application/json')?await response.json().catch(()=>null):null;
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  async function boot(){
    bindShell();
    try{state.session=await api('/api/auth/session');}catch(error){showAuth(error.message);return;}
    if(!state.session?.user){showAuth();return;}
    if(!state.session.isAdmin){showAuth('Этот Telegram-аккаунт не входит в ADMIN_TELEGRAM_IDS.');return;}
    $('#authGate').classList.add('hidden');$('#adminApp').classList.remove('hidden');
    $('#adminIdentity').textContent=state.session.user.username?`@${state.session.user.username}`:state.session.user.firstName;
    buildMobileNav();await navigate('overview');
  }

  function bindShell(){
    $$('.admin-side-nav [data-route]').forEach((button)=>button.addEventListener('click',()=>void navigate(button.dataset.route)));
    $('#adminLogout')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
  }

  function buildMobileNav(){
    const host=$('.admin-mobile-nav');host.innerHTML='';
    $$('.admin-side-nav [data-route]').forEach((button)=>{const clone=button.cloneNode(true);clone.addEventListener('click',()=>void navigate(clone.dataset.route));host.append(clone);});
  }

  function showAuth(message=''){
    $('#authGate').classList.remove('hidden');$('#adminApp').classList.add('hidden');
    const panel=$('.auth-panel');
    if(message){const p=panel.querySelector('p');p.textContent=message;}
    const host=$('#adminTelegramLogin');
    const bot=state.session?.botUsername;
    if(!bot){host.textContent=message||'Загрузка авторизации…';if(!state.session)setTimeout(()=>location.reload(),1200);return;}
    host.innerHTML='';const script=document.createElement('script');script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';host.append(script);
  }

  async function navigate(route){
    if(!routeMeta[route])return;state.route=route;
    $$('[data-route]').forEach((button)=>button.classList.toggle('active',button.dataset.route===route));
    $('#pageTitle').textContent=routeMeta[route][0];$('#pageDescription').textContent=routeMeta[route][1];
    $('#adminContent').innerHTML='<div class="admin-loading">Загрузка…</div>';
    try{
      if(route==='overview')await renderOverview();
      if(route==='publishing')await renderPublishing();
      if(route==='requests')await renderRequests();
      if(route==='files')await renderFiles(false);
      if(route==='sync')await renderSync();
      if(route==='settings')await renderSettings();
    }catch(error){$('#adminContent').innerHTML=`<div class="notice error">${esc(error.message)}</div>`;}
  }

  async function renderOverview(){
    const [dashboard,publishing]=await Promise.all([api('/api/admin/dashboard'),api('/api/admin/publishing')]);state.dashboard=dashboard;state.publishing=publishing;
    const s=dashboard.summary||{};const recent=(publishing.publications||[]).slice(0,6);const proposals=(dashboard.proposals||[]).slice(0,5);
    $('#adminContent').innerHTML=`
      <div class="admin-stat-grid">
        ${stat('☷',s.proposals?.pending||0,'новых заявок','orange')}${stat('✎',s.publications||0,'публикаций','blue')}${stat('▱',s.files||0,'файлов','green')}${stat('✓',s.published||0,'опубликовано','gold')}
      </div>
      <div class="admin-dashboard-grid">
        <section class="admin-panel"><div class="admin-panel-head"><div><h2>Последние публикации</h2><p>Черновики и отправленные посты</p></div><button data-jump="publishing">Открыть Publishing</button></div><div>${recent.length?recent.map(publicationRow).join(''):'<div class="admin-empty">Публикаций пока нет.</div>'}</div></section>
        <section class="admin-panel"><div class="admin-panel-head"><div><h2>Очередь заявок</h2><p>Последние запросы сообщества</p></div><button data-jump="requests">Все заявки</button></div><div>${proposals.length?proposals.map((item)=>compactProposal(item)).join(''):'<div class="admin-empty">Заявок нет.</div>'}</div></section>
      </div>`;
    $$('[data-jump]').forEach((button)=>button.addEventListener('click',()=>void navigate(button.dataset.jump)));
  }

  function stat(icon,value,label,tone){return`<div class="admin-stat ${tone}"><div class="admin-stat-icon">${icon}</div><div><strong>${Number(value||0)}</strong><span>${esc(label)}</span></div></div>`;}
  function compactProposal(item){return`<div class="admin-compact-row"><div class="admin-compact-icon">${esc((item.title||'?').slice(0,1).toUpperCase())}</div><div class="admin-compact-copy"><strong>${esc(item.title)}</strong><span>${esc(item.username?'@'+item.username:item.first_name||'Пользователь')} · ${Number(item.vote_count||0)} голосов</span></div><span class="admin-badge ${esc(item.status)}">${statusLabel(item.status)}</span></div>`;}
  function publicationRow(item){return`<div class="publication-row"><div class="publication-thumb">${item.image_key?'▣':'✎'}</div><div class="publication-copy"><strong>${esc(item.internal_title)}</strong><span>${Number(item.file_count||0)} файл(ов) · ${dateTime(item.updated_at)}</span>${item.error_text?`<small>${esc(item.error_text)}</small>`:''}</div><span class="admin-badge ${esc(item.status)}">${publicationStatus(item.status)}</span></div>`;}

  async function renderPublishing(){
    if(!state.center||!state.publishing){const [center,publishing]=await Promise.all([api('/api/admin/publishing-center'),api('/api/admin/publishing')]);state.center=center;state.publishing=publishing;}
    $('#adminContent').innerHTML=`<div class="publishing-center-shell"><div class="publishing-center-tabs"><button data-pubtab="create">✎ Создать</button><button data-pubtab="publications">▱ Публикации</button><button data-pubtab="files">☷ Файлы</button></div><span class="publishing-center-context">Publishing Center · один рабочий поток</span></div><div id="publishingBody"></div>`;
    $$('[data-pubtab]').forEach((button)=>button.addEventListener('click',()=>void setPublishingTab(button.dataset.pubtab)));
    await setPublishingTab(state.publishingTab);
  }

  async function setPublishingTab(tab){
    state.publishingTab=tab;$$('[data-pubtab]').forEach((button)=>button.classList.toggle('active',button.dataset.pubtab===tab));
    if(tab==='create')renderCreateEditor();
    if(tab==='publications')await renderPublicationList();
    if(tab==='files')await renderFiles(true);
  }

  function renderCreateEditor(){
    const draft=state.center?.draft||{};const storage=Boolean(state.center?.storageReady);const bodyLimit=Number(state.center?.limits?.body||700);const templates=[...builtins.map((item,index)=>({...item,key:`builtin:${index}`})),...(state.center?.templates||[]).map((item)=>({...item,key:`custom:${item.id}`}))];
    const host=$('#publishingBody');host.innerHTML=`
      ${storage?'':'<div class="notice">R2 binding <b>FILES</b> пока не подключён: текстовые черновики работают, загрузка картинок и файлов будет заблокирована backend-ом.</div>'}
      <div class="publisher-layout">
        <section class="admin-panel publisher-editor">
          <div class="admin-panel-head"><div><h2>Новая публикация</h2><p>Редактор, вложения и preflight как в Dollar TL.</p></div></div>
          <div class="template-row"><select id="pubTemplate"><option value="">Шаблон…</option>${templates.map((item)=>`<option value="${esc(item.key)}">${item.key.startsWith('builtin:')?'★':'✦'} ${esc(item.name)}</option>`).join('')}</select><button id="applyTemplate" class="mini-button" type="button">Применить</button><button id="saveTemplate" class="mini-button" type="button">Сохранить шаблон</button></div>
          <label class="admin-field"><span>Название для админки</span><input id="pubTitle" maxlength="180" value="${esc(draft.internal_title||'')}" placeholder="Релиз: название тайтла"></label>
          <label class="admin-field"><span>Текст публикации</span><textarea id="pubBody" rows="8" maxlength="${bodyLimit}" placeholder="Основной текст поста">${esc(draft.body_html||'')}</textarea></label>
          <div class="publisher-upload-grid">
            <label class="publisher-drop"><strong>Изображение</strong><span>JPEG / PNG / WebP / AVIF · до 8 МБ</span><input id="pubImage" type="file" accept="image/jpeg,image/png,image/webp,image/avif" ${storage?'':'disabled'}></label>
            <label class="publisher-drop"><strong>Файлы</strong><span>до 8 файлов · до 45 МБ каждый</span><input id="pubFiles" type="file" multiple ${storage?'':'disabled'}></label>
          </div><div id="assetList" class="publisher-assets"></div>
          <div class="publisher-options"><label><input id="pubFooter" type="checkbox" ${Number(draft.add_footer??1)!==0?'checked':''}><span><b>Футер команды</b><small>Добавить ссылку на бота.</small></span></label><label><input id="pubBotComment" type="checkbox" ${Number(draft.add_bot_comment??1)!==0?'checked':''}><span><b>Комментарий бота</b><small>CTA после файлов в discussion group.</small></span></label></div>
          <div id="saveStatus" class="save-status saved">Автосохранение включено</div>
          <section class="publishing-preflight"><div class="preflight-head"><strong>Проверка перед публикацией</strong><button id="runPreflight" class="mini-button" type="button">Проверить</button></div><div id="preflightList" class="preflight-list"><span class="preflight-check">Есть непроверенные изменения</span></div></section>
          <div class="publisher-actions"><button id="createPublication" class="primary" type="button">Создать черновик публикации</button><button id="clearDraft" type="button">Очистить</button></div>
        </section>
        <aside class="admin-panel publisher-preview"><div class="admin-panel-head"><div><h2>Предпросмотр</h2><p>Приближённо к Telegram-посту</p></div></div><div class="tg-preview"><div id="previewImage" class="tg-preview-image empty">Изображение</div><div id="previewBody" class="tg-preview-body">Текст публикации</div><div id="previewFooter" class="tg-preview-footer">Дом Некроманта · переводы сообщества</div></div></aside>
      </div>`;
    const templateMap=new Map(templates.map((item)=>[item.key,item]));
    for(const id of ['pubTitle','pubBody'])$('#'+id).addEventListener('input',()=>{updatePreview();scheduleSave();schedulePreflight();});
    for(const id of ['pubFooter','pubBotComment'])$('#'+id).addEventListener('change',()=>{updatePreview();scheduleSave();schedulePreflight();});
    for(const id of ['pubImage','pubFiles'])$('#'+id)?.addEventListener('change',()=>{updateAssets();updatePreview();schedulePreflight(80);});
    $('#applyTemplate').addEventListener('click',()=>{const item=templateMap.get($('#pubTemplate').value);if(!item)return;$('#pubTitle').value=item.internal_title||$('#pubTitle').value;$('#pubBody').value=item.body_html||'';$('#pubFooter').checked=Number(item.add_footer)!==0;$('#pubBotComment').checked=Number(item.add_bot_comment)!==0;updatePreview();scheduleSave(0);schedulePreflight(0);});
    $('#saveTemplate').addEventListener('click',()=>void saveCurrentTemplate());$('#runPreflight').addEventListener('click',()=>void runPreflight());$('#createPublication').addEventListener('click',()=>void createPublication());$('#clearDraft').addEventListener('click',()=>void clearDraft());
    updateAssets();updatePreview();void runPreflight();
  }

  function editorSnapshot(){return{internal_title:$('#pubTitle')?.value||'',body_html:$('#pubBody')?.value||'',add_footer:Boolean($('#pubFooter')?.checked),add_bot_comment:Boolean($('#pubBotComment')?.checked)};}
  function scheduleSave(delay=650){clearTimeout(state.saveTimer);$('#saveStatus').className='save-status';$('#saveStatus').textContent='Сохраняем…';state.saveTimer=setTimeout(()=>void saveDraft(),delay);}
  async function saveDraft(){clearTimeout(state.saveTimer);try{const result=await api('/api/admin/publishing-center/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(editorSnapshot())});$('#saveStatus').className='save-status saved';$('#saveStatus').textContent=`Автосохранено · ${dateTime(result.draft?.updated_at)}`;}catch(error){$('#saveStatus').className='save-status error';$('#saveStatus').textContent=`Не сохранено: ${error.message}`;}}
  function schedulePreflight(delay=350){clearTimeout(state.preflightTimer);$('#preflightList').innerHTML='<span class="preflight-check">Есть непроверенные изменения</span>';state.preflightTimer=setTimeout(()=>void runPreflight(),delay);}
  async function runPreflight(){if(!$('#pubTitle'))return;const files=Array.from($('#pubFiles')?.files||[]),image=$('#pubImage')?.files?.[0];try{const result=await api('/api/admin/publishing-center/preflight',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...editorSnapshot(),file_sizes:files.map((file)=>file.size),image_size:image?.size||0})});$('#preflightList').innerHTML=(result.checks||[]).map((check)=>`<span class="preflight-check ${esc(check.status)}"><b>${esc(check.label)}</b> · ${esc(check.message)}</span>`).join('');$('#createPublication').disabled=!result.ready;}catch(error){$('#preflightList').innerHTML=`<span class="preflight-check error">${esc(error.message)}</span>`;$('#createPublication').disabled=true;}}
  function updateAssets(){const files=Array.from($('#pubFiles')?.files||[]),image=$('#pubImage')?.files?.[0];const list=[];if(image)list.push(`🖼 ${image.name} · ${formatBytes(image.size)}`);for(const file of files)list.push(`▱ ${file.name} · ${formatBytes(file.size)}`);$('#assetList').innerHTML=list.map((item)=>`<span>${esc(item)}</span>`).join('');}
  function updatePreview(){const body=$('#pubBody')?.value.trim()||'Текст публикации';$('#previewBody').textContent=body;$('#previewFooter').classList.toggle('hidden',!$('#pubFooter')?.checked);const image=$('#pubImage')?.files?.[0],host=$('#previewImage');if(host.dataset.url)URL.revokeObjectURL(host.dataset.url);if(image){const url=URL.createObjectURL(image);host.dataset.url=url;host.classList.remove('empty');host.innerHTML=`<img src="${url}" alt="">`;}else{delete host.dataset.url;host.classList.add('empty');host.textContent='Изображение';}}
  async function saveCurrentTemplate(){const name=prompt('Название шаблона');if(!name)return;try{await api('/api/admin/publishing-center/templates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...editorSnapshot(),name})});state.center=await api('/api/admin/publishing-center');toast('Шаблон сохранён.');renderCreateEditor();}catch(error){toast(error.message,true);}}
  async function clearDraft(){if(!confirm('Очистить рабочий черновик?'))return;await api('/api/admin/publishing-center/draft',{method:'DELETE'});state.center=await api('/api/admin/publishing-center');renderCreateEditor();}
  async function createPublication(){const button=$('#createPublication');button.disabled=true;const data=new FormData();const snap=editorSnapshot();data.set('internal_title',snap.internal_title);data.set('body',snap.body_html);data.set('add_footer',snap.add_footer?'1':'0');data.set('add_bot_comment',snap.add_bot_comment?'1':'0');const image=$('#pubImage')?.files?.[0];if(image)data.set('image',image);for(const file of Array.from($('#pubFiles')?.files||[]))data.append('files',file);try{await api('/api/admin/publications',{method:'POST',body:data});toast('Черновик публикации создан.');state.publishing=await api('/api/admin/publishing');state.publishingTab='publications';await setPublishingTab('publications');}catch(error){toast(error.message,true);button.disabled=false;}}

  async function renderPublicationList(){state.publishing=await api('/api/admin/publishing');const items=state.publishing.publications||[];$('#publishingBody').innerHTML=`<section class="admin-panel"><div class="admin-panel-head"><div><h2>Публикации</h2><p>Черновики, тесты и отправленные посты.</p></div><button id="refreshPublications">Обновить</button></div><div id="publicationList">${items.length?items.map(publicationManageRow).join(''):'<div class="admin-empty">Публикаций пока нет.</div>'}</div></section>`;$('#refreshPublications').addEventListener('click',()=>void renderPublicationList());$$('[data-pub-action]').forEach((button)=>button.addEventListener('click',()=>void publicationAction(button.dataset.id,button.dataset.pubAction)));}
  function publicationManageRow(item){return`<div class="publication-row"><div class="publication-thumb">${item.image_key?'▣':'✎'}</div><div class="publication-copy"><strong>${esc(item.internal_title)}</strong><span>#${item.id} · ${Number(item.file_count||0)} файл(ов) · ${dateTime(item.updated_at)}</span>${item.error_text?`<small>${esc(item.error_text)}</small>`:''}</div><div><span class="admin-badge ${esc(item.status)}">${publicationStatus(item.status)}</span><div class="publication-actions"><button data-pub-action="test" data-id="${item.id}">Тест</button>${item.status!=='published'?`<button class="ok" data-pub-action="publish" data-id="${item.id}">Опубликовать</button><button class="bad" data-pub-action="delete" data-id="${item.id}">Удалить</button>`:''}</div></div></div>`;}
  async function publicationAction(id,action){if(action==='delete'&&!confirm('Удалить этот черновик и его файлы?'))return;try{if(action==='delete')await api(`/api/admin/publications/${id}`,{method:'DELETE'});else await api(`/api/admin/publications/${id}/${action}`,{method:'POST'});toast(action==='test'?'Тест отправлен администратору.':action==='publish'?'Публикация отправлена.':'Черновик удалён.');await renderPublicationList();}catch(error){toast(error.message,true);}}

  function requestsState(){
    if(!state.requests)state.requests={items:[],tab:'pending',source:'all',query:'',selectedId:null,candidates:[],candidateProposalId:null,searchDone:false};
    return state.requests;
  }
  function requestBucket(item){return item.status==='done'||item.status==='rejected'?'closed':item.status;}
  function requestBucketForStatus(status){return status==='done'||status==='rejected'?'closed':status;}
  function requestUser(item){return item.username?`@${item.username}`:[item.first_name,item.last_name].filter(Boolean).join(' ')||`Telegram ${item.user_telegram_id||'—'}`;}
  function requestSourceLabel(item){return item.ranobelib_book_ref?'RanobeLib':'Внешний источник';}
  function requestHttpLink(value,label){const url=String(value||'').trim();return /^https?:\/\//i.test(url)?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label||url)}</a>`:'—';}
  function requestMatches(item,r){
    if(requestBucket(item)!==r.tab)return false;
    if(r.source==='with'&&!item.ranobelib_book_ref)return false;
    if(r.source==='without'&&item.ranobelib_book_ref)return false;
    const q=r.query.trim().toLocaleLowerCase('ru-RU');
    if(!q)return true;
    return [item.title,item.original_title,item.ranobelib_title,item.source_url].some((value)=>String(value||'').toLocaleLowerCase('ru-RU').includes(q));
  }
  function requestTabCount(key){return requestsState().items.filter((item)=>requestBucket(item)===key).length;}
  function visibleRequests(){const r=requestsState();return r.items.filter((item)=>requestMatches(item,r));}

  async function loadRequestItems(){
    const data=await api('/api/admin/title-proposal-details');
    const r=requestsState();r.items=data.proposals||[];
    return r.items;
  }

  async function renderRequests(){
    await loadRequestItems();
    const r=requestsState();
    $('#adminContent').innerHTML=`
      <div class="request-moderation-layout" data-proposal-raw-panel="1">
        <section class="admin-panel request-queue-panel">
          <div class="admin-panel-head"><div><h2>Очередь заявок</h2><p>${r.items.length} заявок на перевод</p></div></div>
          <div id="requestTabs" class="request-queue-tabs"></div>
          <div class="request-filters">
            <select id="requestSourceFilter" aria-label="Фильтр источника">
              <option value="all">Все</option><option value="with">Есть RanobeLib</option><option value="without">Нет RanobeLib</option>
            </select>
            <input id="requestSearch" type="search" maxlength="180" placeholder="Поиск по названию" aria-label="Поиск заявок">
          </div>
          <div id="requestList" class="request-list"></div>
        </section>
        <aside id="requestDetail" class="admin-panel request-detail-panel" data-request-detail></aside>
      </div>`;
    $('#requestSourceFilter').value=r.source;$('#requestSearch').value=r.query;
    $('#requestSourceFilter').addEventListener('change',(event)=>{r.source=event.currentTarget.value;r.selectedId=null;renderRequestList();renderRequestDetail();});
    $('#requestSearch').addEventListener('input',(event)=>{r.query=event.currentTarget.value;r.selectedId=null;renderRequestList();renderRequestDetail();});
    renderRequestTabs();renderRequestList();renderRequestDetail();
  }

  function renderRequestTabs(){
    const r=requestsState(),host=$('#requestTabs');if(!host)return;
    host.innerHTML=requestTabDefs.map((tab)=>`<button type="button" class="${r.tab===tab.key?'active':''}" data-request-tab="${tab.key}"><span>${tab.label}</span><b>${requestTabCount(tab.key)}</b></button>`).join('');
    $$('[data-request-tab]',host).forEach((button)=>button.addEventListener('click',()=>{r.tab=button.dataset.requestTab;r.selectedId=null;r.candidates=[];r.candidateProposalId=null;r.searchDone=false;renderRequestTabs();renderRequestList();renderRequestDetail();}));
  }

  function renderRequestList(){
    const r=requestsState(),host=$('#requestList');if(!host)return;
    const items=visibleRequests();
    if(!items.some((item)=>item.id===r.selectedId))r.selectedId=items[0]?.id||null;
    host.innerHTML=items.length?items.map((item)=>requestCard(item,item.id===r.selectedId)).join(''):'<div class="admin-empty">В этом разделе заявок нет.</div>';
    $$('[data-request-card]',host).forEach((card)=>card.addEventListener('click',()=>{
      r.selectedId=card.dataset.id;r.candidates=[];r.candidateProposalId=null;r.searchDone=false;renderRequestList();renderRequestDetail();
    }));
  }

  function requestCard(item,active){
    return`<button type="button" class="request-list-card ${active?'active':''}" data-request-card data-id="${esc(item.id)}">
      <span class="request-list-card-head"><strong>${esc(item.title||'Без названия')}</strong><span class="admin-badge ${esc(item.status)}">${statusLabel(item.status)}</span></span>
      <span class="request-list-card-meta"><span>${esc(requestUser(item))}</span><span>▲ ${Number(item.vote_count||0)}</span><span class="request-source-pill ${item.ranobelib_book_ref?'linked':'external'}">${esc(requestSourceLabel(item))}</span></span>
    </button>`;
  }

  function renderRequestDetail(){
    const r=requestsState(),host=$('#requestDetail');if(!host)return;
    const item=r.items.find((entry)=>entry.id===r.selectedId);
    if(!item){host.innerHTML='<div class="request-detail-empty"><strong>Выберите заявку</strong><span>Карточка откроется здесь.</span></div>';return;}
    const linked=Boolean(item.ranobelib_book_ref);
    const rawReady=Boolean(item.raw_upload_id&&item.raw_status==='ready');
    const rawBlock=item.raw_upload_id?`<div class="request-raw-card"><div><strong>${esc(item.raw_original_name||'RAW-файл')}</strong><span>${esc(item.raw_status||'—')} · ${item.raw_size==null?'размер неизвестен':formatBytes(item.raw_size)}</span></div>${rawReady?`<a href="/api/admin/proposal-raw/${encodeURIComponent(item.raw_upload_id)}/download">Скачать RAW</a>`:'<span class="request-muted">Файл ещё не готов</span>'}</div>`:'<div class="request-muted">RAW не приложен.</div>';
    const sourceBlock=linked?`
      <div class="request-source-card linked">
        <div class="request-source-cover">${item.ranobelib_cover_url?`<img src="${esc(item.ranobelib_cover_url)}" alt="">`:'RL'}</div>
        <div><strong>${esc(item.ranobelib_title||item.title)}</strong><span>${esc(item.ranobelib_book_ref)}${item.ranobelib_id?` · ID ${Number(item.ranobelib_id)}`:''}</span><span>${item.ranobelib_chapter_count==null?'Главы: —':`Глав: ${Number(item.ranobelib_chapter_count)}`}${item.ranobelib_latest_number?` · последняя ${esc(item.ranobelib_latest_number)}`:''}</span>${item.ranobelib_latest_name?`<span>${esc(item.ranobelib_latest_name)}</span>`:''}<div class="request-detail-links">${requestHttpLink(item.ranobelib_url,'Открыть на RanobeLib')}</div></div>
      </div>`:`
      <div class="request-source-card external"><div><strong>${esc(item.original_title||item.title)}</strong><span>Внешний источник</span><div class="request-detail-links">${requestHttpLink(item.source_url,'Открыть оригинал')}${item.extra_url?requestHttpLink(item.extra_url,'Дополнительная ссылка'):''}</div></div></div>`;
    const ranobelibTools=linked?'':requestRanobeLibTools(item);
    host.innerHTML=`
      <div class="request-detail-head"><div><span class="admin-card-id">#${esc(item.id)}</span><h2>${esc(item.title||'Без названия')}</h2></div><span class="admin-badge ${esc(item.status)}">${statusLabel(item.status)}</span></div>
      <div class="request-detail-meta"><div><span>Пользователь</span><strong>${esc(requestUser(item))}</strong></div><div><span>Создано</span><strong>${dateTime(item.created_at)}</strong></div><div><span>Голоса</span><strong>${Number(item.vote_count||0)}</strong></div><div><span>Источник</span><strong>${esc(requestSourceLabel(item))}</strong></div></div>
      <section class="request-detail-section"><h3>Источник</h3>${sourceBlock}</section>
      ${ranobelibTools}
      <section class="request-detail-section"><h3>Комментарий пользователя</h3><p class="request-comment">${esc(item.comment||'Без комментария')}</p></section>
      <section class="request-detail-section"><h3>RAW</h3>${rawBlock}</section>
      <section class="request-detail-section"><h3>Модерация</h3><label class="admin-field request-note"><span>Комментарий администратора</span><textarea id="requestAdminNote" rows="3" maxlength="1500" placeholder="Причина, уточнение или заметка для пользователя">${esc(item.admin_note||'')}</textarea></label><div class="request-status-actions">
        <button type="button" data-detail-status="approved" ${item.status==='approved'?'disabled':''}>Одобрить</button>
        <button type="button" data-detail-status="planned" ${item.status==='planned'?'disabled':''}>В план</button>
        <button type="button" class="ok" data-detail-status="in_progress" ${item.status==='in_progress'?'disabled':''}>В работу</button>
        <button type="button" data-detail-status="done" ${item.status==='done'?'disabled':''}>Готово</button>
        <button type="button" class="bad" data-detail-status="rejected" ${item.status==='rejected'?'disabled':''}>Отклонить</button>
        <button type="button" class="note" data-save-note>Сохранить заметку</button>
      </div></section>`;
    $$('[data-detail-status]',host).forEach((button)=>button.addEventListener('click',()=>void changeStatus(item.id,button.dataset.detailStatus,$('#requestAdminNote')?.value||'')));
    $('[data-save-note]',host)?.addEventListener('click',()=>void changeStatus(item.id,item.status,$('#requestAdminNote')?.value||'',true));
    $('#requestRanobeSearch',host)?.addEventListener('click',()=>void searchRequestRanobeLib(item));
    $$('[data-link-ref]',host).forEach((button)=>button.addEventListener('click',()=>void linkRequestRanobeLib(item.id,button.dataset.linkRef)));
  }

  function requestRanobeLibTools(item){
    const r=requestsState();
    const candidates=r.candidateProposalId===item.id?r.candidates:[];
    const resultHtml=candidates.length?candidates.map((candidate)=>`<div class="request-ranobelib-candidate"><div><strong>${esc(candidate.title)}</strong><span>${esc(candidate.bookRef)} · ${Number(candidate.chapterCount||0)} глав</span><div class="request-detail-links">${requestHttpLink(candidate.url,'Открыть карточку')}</div></div><button type="button" data-link-ref="${esc(candidate.bookRef)}">🔗 Связать</button></div>`).join(''):(r.searchDone&&r.candidateProposalId===item.id?'<div class="request-muted">Совпадений не найдено.</div>':'');
    return`<section class="request-detail-section request-ranobelib-box"><h3>Проверка RanobeLib</h3><p>Для внешней заявки можно найти уже существующую карточку и связать её без создания второй заявки.</p><div class="request-ranobelib-search"><input id="requestRanobeQuery" maxlength="180" value="${esc(item.original_title||item.title||'')}" placeholder="Название на RanobeLib"><button id="requestRanobeSearch" type="button">🔎 Проверить RanobeLib</button></div><div class="request-ranobelib-results">${resultHtml}</div></section>`;
  }

  async function searchRequestRanobeLib(item){
    const r=requestsState(),input=$('#requestRanobeQuery');const query=input?.value.trim()||'';
    if(query.length<2){toast('Введите хотя бы 2 символа для поиска.',true);return;}
    const button=$('#requestRanobeSearch');if(button){button.disabled=true;button.textContent='Проверяем…';}
    try{
      const data=await api('/api/admin/title-proposals/ranobelib-search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});
      r.candidates=data.candidates||[];r.candidateProposalId=item.id;r.searchDone=true;renderRequestDetail();
    }catch(error){toast(error.message,true);if(button){button.disabled=false;button.textContent='🔎 Проверить RanobeLib';}}
  }

  async function linkRequestRanobeLib(id,bookRef){
    if(!bookRef)return;
    try{
      await api(`/api/admin/title-proposals/${encodeURIComponent(id)}/link-ranobelib`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bookRef})});
      const r=requestsState();await loadRequestItems();r.selectedId=id;r.candidates=[];r.candidateProposalId=null;r.searchDone=false;toast('Заявка связана с RanobeLib.');renderRequestTabs();renderRequestList();renderRequestDetail();
    }catch(error){toast(error.message,true);}
  }

  async function changeStatus(id,status,adminNote='',noteOnly=false){
    try{
      await api(`/api/admin/proposals/${encodeURIComponent(id)}/status`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status,adminNote})});
      const r=requestsState();await loadRequestItems();r.tab=requestBucketForStatus(status);r.selectedId=id;r.candidates=[];r.candidateProposalId=null;r.searchDone=false;toast(noteOnly?'Заметка сохранена.':'Статус обновлён.');renderRequestTabs();renderRequestList();renderRequestDetail();
    }catch(error){toast(error.message,true);}
  }

  async function renderFiles(insidePublishing){state.files=await api('/api/admin/files');const files=state.files.files||[];const html=`${state.files.storageReady?'':'<div class="notice">R2 FILES binding не подключён. Метаданные видны, новые загрузки отключены.</div>'}<section class="admin-panel"><div class="admin-panel-head"><div><h2>Файлы публикаций</h2><p>${files.length} последних вложений</p></div></div><div>${files.length?files.map(fileRow).join(''):'<div class="admin-empty">Файлов пока нет.</div>'}</div></section>`;const host=insidePublishing?$('#publishingBody'):$('#adminContent');host.innerHTML=html;}
  function fileRow(item){return`<div class="file-row"><div class="file-icon">▱</div><div class="file-copy"><strong>${esc(item.file_name)}</strong><span>${esc(item.internal_title)} · ${formatBytes(Number(item.size_bytes||0))} · ${dateTime(item.created_at)}</span></div><a href="/api/admin/files/${item.id}/download">Скачать</a></div>`;}

  async function renderSync(){const data=await api('/api/ranobelib');$('#adminContent').innerHTML=`<div class="admin-stat-grid">${stat('▤',data.stats?.activeTitles||0,'активных тайтлов','orange')}${stat('✓',data.stats?.syncedTitles||0,'синхронизировано','green')}${stat('↗',data.stats?.releases||0,'релизов','gold')}${stat('↻',data.sync?.syncing?'…':'OK','состояние','blue')}</div><section class="admin-panel"><div class="admin-panel-head"><div><h2>RanobeLib sync</h2><p>Последний запуск: ${dateTime(data.sync?.lastSyncAt)}</p></div><button id="runSync">Синхронизировать</button></div>${data.sync?.lastError?`<div class="notice error">${esc(data.sync.lastError)}</div>`:'<div class="notice">Ошибок последней синхронизации нет.</div>'}</section>`;$('#runSync').addEventListener('click',async()=>{const button=$('#runSync');button.disabled=true;button.textContent='Синхронизация…';try{await api('/api/admin/ranobelib/sync',{method:'POST'});toast('Синхронизация завершена.');await renderSync();}catch(error){toast(error.message,true);button.disabled=false;}});}

  async function renderSettings(){const data=await api('/api/admin/publishing');state.publishing=data;const settings=data.settings||{};$('#adminContent').innerHTML=`<div class="settings-admin-grid"><section class="admin-panel"><div class="admin-panel-head"><div><h2>Telegram Publishing</h2><p>Канал и linked discussion group.</p></div></div><div class="settings-grid"><label class="admin-field"><span>Канал публикации</span><input id="settingChannel" value="${esc(settings.publishChannelId||'')}" placeholder="@channel или -100..."></label><label class="admin-field"><span>Discussion group</span><input id="settingDiscussion" value="${esc(settings.discussionChatId||'')}" placeholder="-100..."></label></div><button id="saveSettings" class="admin-save-settings" type="button">Сохранить настройки</button></section><section class="admin-panel"><div class="admin-panel-head"><div><h2>Файловое хранилище</h2><p>R2 binding FILES</p></div></div><div class="notice ${settings.storageReady?'':'error'}">${settings.storageReady?'FILES подключён — загрузки доступны.':'FILES не подключён. Добавьте существующий/новый R2 bucket в Wrangler как binding FILES перед production.'}</div></section></div>`;$('#saveSettings').addEventListener('click',async()=>{try{await api('/api/admin/publishing/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publishChannelId:$('#settingChannel').value,discussionChatId:$('#settingDiscussion').value})});toast('Настройки сохранены.');}catch(error){toast(error.message,true);}});}

  function publicationStatus(status){return({draft:'Черновик',publishing:'Отправка',published:'Опубликовано',failed:'Ошибка'})[status]||status;}
  function statusLabel(status){return({pending:'Новая',approved:'Одобрено',planned:'В плане',in_progress:'В работе',done:'Готово',rejected:'Отклонено'})[status]||status;}
  function formatBytes(value){const n=Number(value||0);if(n<1024*1024)return`${Math.max(0,n/1024).toFixed(1)} КБ`;return`${(n/1024/1024).toFixed(1)} МБ`;}
  function dateTime(value){if(!value)return'—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':date.toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});}
  function toast(message,error=false){const host=$('#toast');host.textContent=message;host.className=`toast${error?' error':''}`;clearTimeout(toast.timer);toast.timer=setTimeout(()=>host.classList.add('hidden'),3200);}
  document.addEventListener('DOMContentLoaded',boot);
})();
