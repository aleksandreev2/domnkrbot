(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const $$=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon=(name)=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const PERIODS=[[7,'7 дней'],[30,'30 дней'],[90,'90 дней'],[365,'Год'],[0,'Всё время']];
  let days=30;
  let active=false;
  let loading=false;

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  function installNavigation(){
    const app=$('#adminApp');if(!app)return;
    const side=$('.admin-side-nav');
    if(side&&!side.querySelector('[data-ops-route="statistics"]')){
      const button=document.createElement('button');button.type='button';button.dataset.opsRoute='statistics';button.innerHTML=`<span class="nav-icon">${icon('chart-no-axes-combined')}</span><span>Статистика</span>`;
      const publishing=side.querySelector('[data-route="publishing"]');if(publishing)publishing.after(button);else side.append(button);
      button.addEventListener('click',()=>void openStatistics());
    }
    const mobile=$('.admin-mobile-nav');
    if(mobile&&!mobile.querySelector('[data-ops-route="statistics"]')){
      const button=document.createElement('button');button.type='button';button.dataset.opsRoute='statistics';button.innerHTML=`<span class="nav-icon">${icon('chart-no-axes-combined')}</span><span>Статистика</span>`;button.addEventListener('click',()=>void openStatistics());
      const publishing=mobile.querySelector('[data-route="publishing"]');if(publishing)publishing.after(button);else mobile.append(button);
    }
    $$('[data-route]').forEach((button)=>{if(button.dataset.opsStatsBound)return;button.dataset.opsStatsBound='1';button.addEventListener('click',()=>{active=false;$$('[data-ops-route="statistics"]').forEach((node)=>node.classList.remove('active'));});});
    refreshIcons();
  }

  async function openStatistics(){
    if(loading)return;active=true;
    $$('[data-route],[data-ops-route="statistics"]').forEach((button)=>button.classList.toggle('active',button.dataset.opsRoute==='statistics'));
    $('#pageTitle').textContent='Статистика';$('#pageDescription').textContent='Публикации, скачивания, подписка на канал, «Спасибо» и поддержка.';
    $('#adminContent').innerHTML=`<div class="admin-loading">${icon('loader-circle')} Собираем статистику…</div>`;refreshIcons();
    loading=true;
    try{
      const [data,access]=await Promise.all([api(`/api/admin/publishing-analytics?days=${days}`),api('/api/admin/membership-access')]);
      if(active)paint(data,access);
    }catch(error){if(active)$('#adminContent').innerHTML=`<div class="notice error">${esc(error.message)}</div>`;}finally{loading=false;}
  }

  function paint(data,access){
    const s=data.summary||{};const a=access.summary||{};const period=days===0?'за всё время':`за ${days} дней`;
    $('#adminContent').innerHTML=`<section class="publishing-stats-page">
      <div class="publishing-stats-toolbar admin-panel"><div class="publishing-stat-periods">${PERIODS.map(([value,label])=>`<button type="button" data-stat-days="${value}" class="${days===value?'active':''}">${label}</button>`).join('')}</div><span>${icon('calendar-days')} ${period}</span></div>
      <div class="publishing-kpis">
        ${kpi('send','Опубликовано',s.published,'релизов')}
        ${kpi('users-round','Уникальные читатели',s.unique_readers,'открыли/получили релиз')}
        ${kpi('mouse-pointer-click','Открыли скачивание',s.download_opens,'deep-link в бота')}
        ${kpi('file-down','Выдано файлов',s.deliveries,'успешных Telegram delivery')}
        ${kpi('rotate-ccw','Повторные выдачи',s.repeat_deliveries,'повторное получение')}
        ${kpi('heart','Сказали «Спасибо»',s.thanks,'уникальных читателей')}
        ${kpi('heart-handshake','Поддержка',s.support_clicks,'переходов на Boosty')}
        ${kpi('triangle-alert','Ошибки выдачи',s.delivery_failures,'требуют внимания',Number(s.delivery_failures)>0?'danger':'')}
        ${kpi('shield-check','Под контролем 7 дней',a.monitored,'скачивали за последнюю неделю')}
        ${kpi('user-x','Чёрный список',a.blacklisted,'вышли из канала в течение 7 дней',Number(a.blacklisted)>0?'danger':'')}
      </div>
      <div class="publishing-stat-grid">
        <section class="admin-panel publishing-ranking"><div class="admin-panel-head"><div><h2>Самые читаемые релизы</h2><p>Рейтинг по уникальным читателям в выбранный период.</p></div></div>${releaseRows(data.top_releases||[])}</section>
        <section class="admin-panel publishing-attention"><div class="admin-panel-head"><div><h2>Требуют внимания</h2><p>Ошибки delivery или проблемы с discussion-thread.</p></div></div>${attentionRows(data.attention||[])}</section>
      </div>
      <section class="admin-panel publishing-access"><div class="admin-panel-head"><div><h2>Чёрный список скачиваний</h2><p>После успешной выдачи пользователь должен оставаться в канале 7 суток. Выход в любой момент этого окна — ЧС без автоматического снятия.</p></div></div>${accessRows(access.users||[])}</section>
      <section class="admin-panel publishing-events"><div class="admin-panel-head"><div><h2>Последние события</h2><p>Фактические события выдачи, а не вычисленные просмотры.</p></div></div>${eventRows(data.recent_events||[])}</section>
    </section>`;
    $$('[data-stat-days]').forEach((button)=>button.addEventListener('click',()=>{const next=Number(button.dataset.statDays);if(next===days)return;days=next;void openStatistics();}));
    $$('[data-access-unblock]').forEach((button)=>button.addEventListener('click',()=>void unblock(button.dataset.accessUnblock,button)));
    refreshIcons();
  }

  async function unblock(userId,button){
    if(!userId||button.disabled)return;
    button.disabled=true;button.textContent='Разблокируем…';
    try{await api(`/api/admin/membership-access/${encodeURIComponent(userId)}/unblock`,{method:'POST'});await openStatistics();}
    catch(error){button.disabled=false;button.textContent='Разблокировать';alert(error.message);}
  }

  function kpi(ic,label,value,sub,tone=''){return`<article class="publishing-kpi ${tone}"><span>${icon(ic)}</span><div><small>${esc(label)}</small><strong>${fmt(value)}</strong><p>${esc(sub)}</p></div></article>`;}
  function releaseRows(rows){
    if(!rows.length)return'<div class="admin-empty">Пока нет данных: статистика начнёт заполняться после новых выдач через бота.</div>';
    return`<div class="publishing-ranking-list">${rows.map((row,index)=>`<article><b class="rank">${index+1}</b><div class="release-copy"><strong>${esc(row.title)}</strong><span>${row.file_count} файл(ов) · ${dateTime(row.published_at)}</span></div><div class="release-metrics"><span>${icon('users-round')} ${fmt(row.readers)}</span><span>${icon('file-down')} ${fmt(row.deliveries)}</span><span>${icon('heart')} ${fmt(row.thanks)}</span><span>${icon('heart-handshake')} ${fmt(row.support_clicks)}</span>${Number(row.delivery_failures)>0?`<span class="bad">${icon('triangle-alert')} ${fmt(row.delivery_failures)}</span>`:''}</div></article>`).join('')}</div>`;
  }
  function attentionRows(rows){
    if(!rows.length)return'<div class="admin-empty good">Delivery выглядит чисто: ошибок и незакрытых publication-thread нет.</div>';
    return`<div class="publishing-attention-list">${rows.map((row)=>`<article><div><strong>${esc(row.title)}</strong><span>${Number(row.delivery_failures)>0?`${fmt(row.delivery_failures)} ошибок выдачи`:'Discussion thread не подтверждён'}</span></div><span class="admin-badge failed">Проверить</span></article>`).join('')}</div>`;
  }
  function accessRows(rows){
    if(!rows.length)return'<div class="admin-empty good">Чёрный список пуст.</div>';
    return`<div class="publishing-access-list">${rows.map((row)=>{const name=row.username?`@${row.username}`:(row.first_name||`user ${row.user_telegram_id}`);return`<article><span class="access-icon blocked">${icon('user-x')}</span><div class="access-copy"><strong>${esc(name)}</strong><span>ID ${esc(row.user_telegram_id)} · выдано ${fmt(row.delivered_assets)} файл(ов)</span><small>Последнее скачивание ${dateTime(row.last_download_at)} · ЧС с ${dateTime(row.blacklisted_at)}</small></div><span class="admin-badge failed">ЧС</span><button class="mini-button" type="button" data-access-unblock="${esc(row.user_telegram_id)}">Разблокировать</button></article>`;}).join('')}</div>`;
  }
  function eventRows(rows){
    if(!rows.length)return'<div class="admin-empty">Событий выдачи ещё нет.</div>';
    return`<div class="publishing-event-list">${rows.map((row)=>`<div><span class="event-icon">${icon(eventIcon(row.event_type))}</span><div><strong>${esc(eventLabel(row.event_type))}</strong><span>${esc(row.internal_title||`Публикация #${row.publication_id}`)}${row.user_telegram_id?` · user ${esc(row.user_telegram_id)}`:''}</span></div><time>${dateTime(row.created_at)}</time></div>`).join('')}</div>`;
  }
  function eventIcon(type){return({download_open:'mouse-pointer-click',delivery_success:'file-check-2',delivery_failed:'triangle-alert',thank_you_click:'heart',support_click:'heart-handshake'})[type]||'activity';}
  function eventLabel(type){return({download_open:'Открыто скачивание',delivery_success:'Файл выдан',delivery_failed:'Ошибка выдачи',thank_you_click:'Спасибо',support_click:'Переход на Boosty'})[type]||type;}
  function fmt(value){return new Intl.NumberFormat('ru-RU').format(Number(value||0));}
  function dateTime(value){if(!value)return'—';const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'}):String(value);}

  function installPublishingGuide(){
    const body=$('#publishingBody');if(!body||body.querySelector('[data-delivery-guide]'))return;
    const editor=body.querySelector('.publisher-editor');if(!editor)return;
    const guide=document.createElement('section');guide.className='delivery-auto-guide';guide.dataset.deliveryGuide='1';
    guide.innerHTML=`<div class="delivery-guide-head"><span>${icon('bot')}</span><div><strong>Автоматическая выдача релиза</strong><p>Служебный блок добавляется backend-ом при test/publish/edit и не зависит от текста редактора.</p></div></div><div class="delivery-message-preview"><p>📥 Скачать перевод можно через бота — кнопка под постом.</p><p>❤️ Поддержать переводчика — кнопка под постом.</p><div><span>${icon('download')} Скачать</span><span>${icon('heart-handshake')} Поддержать переводчика</span></div></div><ul><li>Выдача разрешена только текущим подписчикам канала «Дом Некроманта».</li><li>После успешной выдачи действует контрольное окно 7 суток. Выход через минуту, день или на шестой день приводит к ЧС.</li><li>Повторная подписка автоматически ЧС не снимает; разблокировка доступна здесь администратору.</li><li>Повторная выдача использует сохранённый Telegram <code>file_id</code>; R2 остаётся fallback.</li><li>Комментарии канала получают CTA, а не публичные документы — поэтому статистика скачиваний остаётся честной.</li><li>Поддержка ведёт на настроенный Boosty target.</li></ul>`;
    const preflight=editor.querySelector('.publishing-preflight');if(preflight)preflight.before(guide);else editor.append(guide);refreshIcons();
  }

  const observer=new MutationObserver(()=>queueMicrotask(()=>{installNavigation();installPublishingGuide();}));
  document.addEventListener('DOMContentLoaded',()=>{const app=$('#adminApp');if(app)observer.observe(app,{childList:true,subtree:true});installNavigation();installPublishingGuide();});
})();