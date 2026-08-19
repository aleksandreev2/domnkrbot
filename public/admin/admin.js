(() => {
  const state={session:null,route:'overview',publishingTab:'create',dashboard:null,publishing:null,center:null,files:null,saveTimer:0,preflightTimer:0};
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
    const draft=state.center?.draft||{};const storage=Boolean(state.center?.storageReady);const templates=[...builtins.map((item,index)=>({...item,key:`builtin:${index}`})),...(state.center?.templates||[]).map((item)=>({...item,key:`custom:${item.id}`}))];
    const host=$('#publishingBody');host.innerHTML=`
      ${storage?'':'<div class="notice">R2 binding <b>FILES</b> пока не подключён: текстовые черновики работают, загрузка картинок и файлов будет заблокирована backend-ом.</div>'}
      <div class="publisher-layout">
        <section class="admin-panel publisher-editor">
          <div class="admin-panel-head"><div><h2>Новая публикация</h2><p>Редактор, вложения и preflight как в Dollar TL.</p></div></div>
          <div class="template-row"><select id="pubTemplate"><option value="">Шаблон…</option>${templates.map((item)=>`<option value="${esc(item.key)}">${item.key.startsWith('builtin:')?'★':'✦'} ${esc(item.name)}</option>`).join('')}</select><button id="applyTemplate" class="mini-button" type="button">Применить</button><button id="saveTemplate" class="mini-button" type="button">Сохранить шаблон</button></div>
          <label class="admin-field"><span>Название для админки</span><input id="pubTitle" maxlength="180" value="${esc(draft.internal_title||'')}" placeholder="Релиз: название тайтла"></label>
          <label class="admin-field"><span>Текст публикации</span><textarea id="pubBody" rows="8" maxlength="900" placeholder="Основной текст поста">${esc(draft.body_html||'')}</textarea></label>
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

  async function renderRequests(){const data=await api('/api/admin/proposals');const items=data.proposals||[];$('#adminContent').innerHTML=`<section class="admin-panel"><div class="admin-panel-head"><div><h2>Все заявки</h2><p>${items.length} записей</p></div></div><div class="admin-request-grid">${items.length?items.map(requestCard).join(''):'<div class="admin-empty">Заявок нет.</div>'}</div></section>`;$$('[data-status]').forEach((button)=>button.addEventListener('click',()=>void changeStatus(button.dataset.id,button.dataset.status)));}
  function requestCard(item){return`<article class="admin-request-card"><div class="admin-request-top"><div><span class="admin-card-id">#${esc(item.id).slice(0,8)}</span><h3>${esc(item.title)}</h3></div><span class="admin-badge ${esc(item.status)}">${statusLabel(item.status)}</span></div><p>${esc(item.comment||'Без комментария')}</p><p style="margin-top:7px">${esc(item.username?'@'+item.username:item.first_name||'Пользователь')} · ${Number(item.vote_count||0)} голосов</p><div class="admin-card-actions"><button class="ok" data-status="in_progress" data-id="${esc(item.id)}">В работу</button><button data-status="planned" data-id="${esc(item.id)}">В план</button><button data-status="done" data-id="${esc(item.id)}">Готово</button><button class="bad" data-status="rejected" data-id="${esc(item.id)}">Отклонить</button></div></article>`;}
  async function changeStatus(id,status){try{await api(`/api/admin/proposals/${encodeURIComponent(id)}/status`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status,adminNote:''})});toast('Статус обновлён.');await renderRequests();}catch(error){toast(error.message,true);}}

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
