(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const $$=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon=(name)=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const ECHARTS_URL='https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js';
  const PERIODS=[[7,'7 дней'],[30,'30 дней'],[90,'90 дней'],[365,'Год'],[0,'Всё время']];
  const COMMENT_HELP_TEXT='Один download/support комментарий в discussion thread.';
  const INSTALL_SELECTOR='.publisher-editor,#publicationList,.publication-row,[data-route],.admin-side-nav,.admin-mobile-nav';
  let days=30;
  let active=false;
  let loading=false;
  let chartLoader=null;
  let charts=[];
  let chartObservers=[];

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  function toast(text,error=false){
    const node=$('#toast');if(!node)return alert(text);
    node.textContent=text;node.classList.toggle('error',error);node.classList.remove('hidden');
    clearTimeout(node.__publishingStatsTimer);node.__publishingStatsTimer=setTimeout(()=>node.classList.add('hidden'),3600);
  }

  function installNavigation(){
    const app=$('#adminApp');if(!app)return;
    let added=false;
    for(const nav of $$('.admin-side-nav,.admin-mobile-nav')){
      if(nav.querySelector('[data-ops-route="statistics"]'))continue;
      const button=document.createElement('button');button.type='button';button.dataset.opsRoute='statistics';button.innerHTML=`<span class="nav-icon">${icon('chart-no-axes-combined')}</span><span>Статистика</span>`;
      const publishing=nav.querySelector('[data-route="publishing"]');if(publishing)publishing.after(button);else nav.append(button);
      button.addEventListener('click',()=>void openStatistics());
      added=true;
    }
    $$('[data-route],[data-cockpit-route]').forEach((button)=>{
      if(button.dataset.opsStatsBound)return;button.dataset.opsStatsBound='1';
      button.addEventListener('click',deactivate);
    });
    if(added)refreshIcons();
  }

  function deactivate(){
    active=false;cleanupCharts();
    $$('[data-ops-route="statistics"]').forEach((node)=>node.classList.remove('active'));
  }

  async function openStatistics(){
    if(loading)return;
    active=true;
    $$('[data-route],[data-cockpit-route],[data-ops-route="statistics"]').forEach((button)=>button.classList.toggle('active',button.dataset.opsRoute==='statistics'));
    $('#pageTitle').textContent='Статистика';
    $('#pageDescription').textContent='Путь читателя от комментария до файла, качество выдачи и состояние релизов.';
    $('#adminContent').innerHTML=`<div class="admin-loading">${icon('loader-circle')} Собираем фактические события…</div>`;refreshIcons();
    loading=true;
    try{
      const [data,access]=await Promise.all([api(`/api/admin/publishing-analytics?days=${days}`),api('/api/admin/membership-access')]);
      if(!active)return;
      paint(data,access);
      void renderCharts(data);
    }catch(error){
      if(active)$('#adminContent').innerHTML=`<div class="notice error">${esc(error.message)}</div>`;
    }finally{loading=false;}
  }

  function paint(data,access){
    cleanupCharts();
    const s=data.summary||{},previous=data.previous||null,r=data.rates||{},health=data.gate_health||{},a=access.summary||{};
    const period=days===0?'за всё время':`за ${days} дней`;
    const comparison=days===0?'':' · сравнение с предыдущим периодом';
    $('#adminContent').innerHTML=`<section class="statistics-page">
      <div class="statistics-toolbar admin-panel">
        <div class="statistics-periods" role="group" aria-label="Период статистики">${PERIODS.map(([value,label])=>`<button type="button" data-stat-days="${value}" class="${days===value?'active':''}">${label}</button>`).join('')}</div>
        <div class="statistics-toolbar-side"><span>${icon('calendar-days')} ${period}${comparison}</span><button type="button" data-stat-refresh>${icon('refresh-cw')} Обновить</button></div>
      </div>

      <div class="statistics-kpis">
        ${kpi('users-round','Уникальные читатели',s.unique_readers,'получили хотя бы один файл',delta(s.unique_readers,previous?.unique_readers))}
        ${kpi('file-down','Выдано файлов',s.deliveries,`${fmt(s.repeat_deliveries)} повторных выдач`,delta(s.deliveries,previous?.deliveries))}
        ${kpi('message-circle-more','Нажали в комментарии',s.gate_clicks,'CTA «Скачать» под постом в discussion',delta(s.gate_clicks,previous?.gate_clicks))}
        ${kpi('bot','Открыли бота',s.download_opens,`${fmt(r.gate_to_open)}% после comment CTA`,delta(s.download_opens,previous?.download_opens))}
        ${kpi('heart','Сказали «Спасибо»',s.thanks,`${fmt(r.reader_to_thanks)}% от читателей`,delta(s.thanks,previous?.thanks))}
        ${kpi('heart-handshake','Поддержка',s.support_clicks,`${fmt(r.reader_to_support)}% от читателей`,delta(s.support_clicks,previous?.support_clicks))}
      </div>

      <div class="statistics-grid statistics-grid-main">
        ${panel('Динамика выдачи','Не просмотры Telegram, а события download-gate и фактические отправки файлов',`<div id="publishingMainChart" class="statistics-chart statistics-chart-large"></div><div id="publishingChartFallback" class="statistics-chart-fallback hidden">График недоступен, числовая статистика выше остаётся актуальной.</div>`,'chart-spline')}
        ${panel('Воронка релиза','Где читатели теряются между комментарием и получением файла',funnel(s,r),'route')}
      </div>

      <div class="statistics-grid statistics-grid-health">
        ${panel('Download gate','Служебный комментарий после automatic forward Telegram',gateHealth(health),'messages-square')}
        ${panel('Доступ к файлам','Подписка на канал и 7-дневный контроль после выдачи',accessHealth(a),'shield-check')}
        ${panel('Ошибки','То, что требует действий администратора',errorHealth(s,data.attention||[]),'triangle-alert')}
      </div>

      <section class="admin-panel statistics-panel statistics-release-panel">
        <div class="statistics-panel-head"><div><span class="statistics-panel-icon">${icon('trophy')}</span><div><h2>Релизы</h2><p>Читатели, конверсия, файлы и состояние comment-gate в одном месте.</p></div></div></div>
        ${releaseRows(data.top_releases||[])}
      </section>

      <div class="statistics-grid statistics-grid-detail">
        ${panel('Требуют внимания','Gate, discussion thread или выдача файлов работают нештатно',attentionRows(data.attention||[]),'siren')}
        ${panel('Последние события','Фактическая история действий читателей',eventRows(data.recent_events||[]),'activity')}
      </div>

      <section class="admin-panel statistics-panel statistics-access-panel">
        <div class="statistics-panel-head"><div><span class="statistics-panel-icon">${icon('shield-ban')}</span><div><h2>Чёрный список скачиваний</h2><p>Выход из канала в течение 7 суток после последней успешной выдачи.</p></div></div></div>
        ${accessRows(access.users||[])}
      </section>
    </section>`;

    $$('[data-stat-days]').forEach((button)=>button.addEventListener('click',()=>{const next=Number(button.dataset.statDays);if(next===days)return;days=next;void openStatistics();}));
    $('[data-stat-refresh]')?.addEventListener('click',()=>void openStatistics());
    $$('[data-access-unblock]').forEach((button)=>button.addEventListener('click',()=>void unblock(button.dataset.accessUnblock,button)));
    refreshIcons();
  }

  function panel(title,subtitle,body,ic){return`<section class="admin-panel statistics-panel"><div class="statistics-panel-head"><div><span class="statistics-panel-icon">${icon(ic)}</span><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div></div></div>${body}</section>`;}
  function kpi(ic,label,value,sub,change){return`<article class="statistics-kpi"><span class="statistics-kpi-icon">${icon(ic)}</span><div class="statistics-kpi-copy"><small>${esc(label)}</small><strong>${fmt(value)}</strong><p>${esc(sub)}</p></div>${change?`<span class="statistics-change ${change.direction}">${icon(change.direction==='up'?'trending-up':change.direction==='down'?'trending-down':'minus')} ${esc(change.text)}</span>`:''}</article>`;}
  function delta(current,previous){
    if(previous==null||days===0)return null;
    const now=Number(current||0),before=Number(previous||0);
    if(now===before)return{direction:'same',text:'без изменений'};
    if(before===0)return{direction:now>0?'up':'same',text:now>0?`+${fmt(now)}`:'без изменений'};
    const pct=Math.round(((now-before)/before)*1000)/10;
    return{direction:pct>0?'up':'down',text:`${pct>0?'+':''}${fmt(pct)}%`};
  }

  function funnel(s,r){
    const rows=[
      ['Нажали «Скачать» в комментарии',Number(s.gate_clicks||0),'message-circle-more'],
      ['Открыли выдачу в боте',Number(s.download_opens||0),'bot'],
      ['Получили хотя бы один файл',Number(s.unique_readers||0),'file-check-2'],
      ['Сказали «Спасибо»',Number(s.thanks||0),'heart'],
      ['Перешли поддержать',Number(s.support_clicks||0),'heart-handshake'],
    ];
    const max=Math.max(1,...rows.map((row)=>row[1]));
    return`<div class="statistics-funnel">${rows.map(([label,value,ic],index)=>{const previous=index?rows[index-1][1]:0;const conversion=previous?Math.min(100,Math.round(value/previous*1000)/10):100;return`<div class="statistics-funnel-row"><span class="statistics-funnel-icon">${icon(ic)}</span><div><div class="statistics-funnel-head"><span>${esc(label)}</span><strong>${fmt(value)}</strong></div><div class="statistics-funnel-track"><i style="width:${Math.max(value?5:0,value/max*100)}%"></i></div><small>${index===0?'Старт воронки':`${fmt(conversion)}% от предыдущего шага`}</small></div></div>`;}).join('')}</div><div class="statistics-inline-note">Comment → Bot: <b>${fmt(r.gate_to_open)}%</b> · Bot → Reader: <b>${fmt(r.open_to_reader)}%</b></div>`;
  }

  function gateHealth(h){
    const total=Number(h.total||0),sent=Number(h.sent||0),waiting=Number(h.waiting||0),failed=Number(h.failed||0),missing=Number(h.discussion_missing||0);
    const rate=total?Math.round(sent/total*1000)/10:100;
    return`<div class="statistics-health-hero ${failed||missing?'warning':'good'}"><span>${icon(failed||missing?'message-circle-warning':'message-circle-check')}</span><div><strong>${fmt(rate)}%</strong><small>релизов с готовым служебным комментарием</small></div></div><div class="statistics-health-grid"><div><span>Готово</span><strong>${fmt(sent)}</strong></div><div><span>Ожидает forward</span><strong>${fmt(waiting)}</strong></div><div class="${failed?'bad':''}"><span>Ошибка gate</span><strong>${fmt(failed)}</strong></div><div class="${missing?'bad':''}"><span>Нет discussion</span><strong>${fmt(missing)}</strong></div></div>`;
  }
  function accessHealth(a){
    return`<div class="statistics-health-hero ${Number(a.blacklisted)>0?'warning':'good'}"><span>${icon('shield-check')}</span><div><strong>${fmt(a.monitored)}</strong><small>сейчас под 7-дневным контролем</small></div></div><div class="statistics-health-grid two"><div><span>Чёрный список</span><strong>${fmt(a.blacklisted)}</strong></div><div><span>Контроль</span><strong>${fmt(a.enforcement_days||7)} дней</strong></div></div><p class="statistics-footnote">Повторная подписка не снимает ЧС автоматически; разблокировка остаётся ручной.</p>`;
  }
  function errorHealth(s,attention){
    const failures=Number(s.delivery_failures||0),count=attention.length;
    return`<div class="statistics-health-hero ${failures||count?'bad':'good'}"><span>${icon(failures||count?'triangle-alert':'badge-check')}</span><div><strong>${fmt(failures+count)}</strong><small>${failures||count?'сигналов для проверки':'критичных сигналов нет'}</small></div></div><div class="statistics-health-grid two"><div class="${failures?'bad':''}"><span>Ошибки выдачи</span><strong>${fmt(failures)}</strong></div><div class="${count?'bad':''}"><span>Проблемные релизы</span><strong>${fmt(count)}</strong></div></div>`;
  }

  function releaseRows(rows){
    if(!rows.length)return empty('Статистика заполнится после новых публикаций и выдач через бота.');
    return`<div class="statistics-release-table"><div class="statistics-release-head"><span>Релиз</span><span>Читатели</span><span>Открытия</span><span>Файлы</span><span>Спасибо</span><span>Поддержка</span><span>Gate</span></div>${rows.map((row,index)=>`<article class="statistics-release-row"><div class="statistics-release-title"><b>${index+1}</b><div><strong>${esc(row.title)}</strong><small>#${row.id} · ${fmt(row.file_count)} файл(ов) · ${dateTime(row.published_at)}</small></div></div><span><b>${fmt(row.readers)}</b><small>${fmt(row.open_to_reader_rate)}% от open</small></span><span><b>${fmt(row.download_opens)}</b><small>${fmt(row.gate_clicks)} CTA</small></span><span><b>${fmt(row.deliveries)}</b><small>${fmt(row.repeat_deliveries)} повторно</small></span><span><b>${fmt(row.thanks)}</b></span><span><b>${fmt(row.support_clicks)}</b></span><span>${gateBadge(row)}</span></article>`).join('')}</div>`;
  }
  function gateBadge(row){
    if(Number(row.file_count)>0&&!row.discussion_ready)return'<span class="statistics-status bad">Нет discussion</span>';
    const status=String(row.gate_status||'missing');
    if(status==='sent')return'<span class="statistics-status good">Готов</span>';
    if(status==='waiting_forward'||status==='pending')return'<span class="statistics-status wait">Ожидает</span>';
    if(status==='failed')return'<span class="statistics-status bad">Ошибка</span>';
    return'<span class="statistics-status neutral">Legacy</span>';
  }

  function attentionRows(rows){
    if(!rows.length)return emptyGood('Все опубликованные релизы выглядят штатно.');
    return`<div class="statistics-attention-list">${rows.map((row)=>{const problems=[];if(Number(row.delivery_failures)>0)problems.push(`${fmt(row.delivery_failures)} ошибок выдачи`);if(Number(row.file_count)>0&&!row.discussion_ready)problems.push('не найден discussion thread');if(row.gate_status==='failed')problems.push(`gate: ${row.gate_error||'ошибка Telegram'}`);if(row.gate_status==='missing')problems.push('нет состояния нового gate');return`<article><span class="statistics-attention-icon">${icon('triangle-alert')}</span><div><strong>${esc(row.title)}</strong><span>${esc(problems.join(' · ')||'Требуется проверка')}</span></div><button type="button" data-reconcile-inline="${row.id}">Очистить CTA в канале</button></article>`;}).join('')}</div>`;
  }

  function eventRows(rows){
    if(!rows.length)return empty('Событий за выбранный период нет.');
    return`<div class="statistics-event-list">${rows.slice(0,20).map((row)=>{const user=row.username?`@${row.username}`:row.first_name||row.user_telegram_id?`user ${row.user_telegram_id}`:'';return`<div><span class="statistics-event-icon">${icon(eventIcon(row.event_type))}</span><div><strong>${esc(eventLabel(row.event_type))}</strong><span>${esc(row.internal_title||`Публикация #${row.publication_id}`)}${user?` · ${esc(user)}`:''}</span></div><time>${dateTime(row.created_at)}</time></div>`;}).join('')}</div>`;
  }
  function eventIcon(type){return({download_gate_click:'message-circle-more',download_open:'bot',delivery_success:'file-check-2',delivery_failed:'triangle-alert',thank_you_click:'heart',support_click:'heart-handshake'})[type]||'activity';}
  function eventLabel(type){return({download_gate_click:'Нажали «Скачать» в комментарии',download_open:'Открыли выдачу в боте',delivery_success:'Файл выдан',delivery_failed:'Ошибка выдачи',thank_you_click:'Спасибо',support_click:'Переход на Boosty'})[type]||String(type||'Событие');}

  function accessRows(rows){
    if(!rows.length)return emptyGood('Чёрный список пуст.');
    return`<div class="statistics-access-list">${rows.map((row)=>{const name=row.username?`@${row.username}`:(row.first_name||`user ${row.user_telegram_id}`);return`<article><span class="statistics-access-icon">${icon('user-x')}</span><div><strong>${esc(name)}</strong><span>ID ${esc(row.user_telegram_id)} · выдано ${fmt(row.delivered_assets)} файл(ов)</span><small>Скачивал ${dateTime(row.last_download_at)} · ЧС с ${dateTime(row.blacklisted_at)}</small></div><span class="statistics-status bad">ЧС</span><button type="button" data-access-unblock="${esc(row.user_telegram_id)}">Разблокировать</button></article>`;}).join('')}</div>`;
  }

  async function unblock(userId,button){
    if(!userId||button.disabled)return;button.disabled=true;button.textContent='Разблокируем…';
    try{await api(`/api/admin/membership-access/${encodeURIComponent(userId)}/unblock`,{method:'POST'});toast('Пользователь разблокирован.');await openStatistics();}
    catch(error){button.disabled=false;button.textContent='Разблокировать';toast(error.message,true);}
  }

  async function reconcilePublication(id,button){
    if(!id||button?.disabled)return;
    if(!confirm(`Убрать служебный текст и inline-кнопки из канального поста #${id}? Существующий комментарий дублироваться не будет.`))return;
    if(button){button.disabled=true;button.textContent='Очищаем…';}
    try{
      const result=await api(`/api/admin/publications/${encodeURIComponent(id)}/reconcile-gate`,{method:'POST'});
      toast(result.note||`Пост #${id} очищен.`);
      if(active)await openStatistics();
    }catch(error){if(button){button.disabled=false;button.textContent='Очистить CTA в канале';}toast(error.message,true);}
  }

  function bindReconcileButtons(root=document){
    $$('[data-reconcile-inline]',root).forEach((button)=>{if(button.dataset.reconcileBound)return;button.dataset.reconcileBound='1';button.addEventListener('click',()=>void reconcilePublication(button.dataset.reconcileInline,button));});
  }

  function installPublicationReconcile(){
    const list=$('#publicationList');if(!list)return;
    let added=false;
    $$('.publication-row',list).forEach((row)=>{
      const badge=$('.admin-badge.published',row);if(!badge)return;
      const meta=$('.publication-copy span',row)?.textContent||'';const match=/#(\d+)/.exec(meta);if(!match)return;
      const id=match[1],actions=$('.publication-actions',row);if(!actions||actions.querySelector(`[data-reconcile-inline="${id}"]`))return;
      const button=document.createElement('button');button.type='button';button.className='comment-gate-reconcile';button.dataset.reconcileInline=id;button.innerHTML=`${icon('message-circle-reply')} Вынести CTA в комментарии`;
      actions.append(button);added=true;
    });
    bindReconcileButtons(list);if(added)refreshIcons();
  }

  function installPublishingGuide(){
    const body=$('#publishingBody');if(!body)return;
    const editor=body.querySelector('.publisher-editor');if(!editor)return;
    const commentHelp=$('#pubBotComment',editor)?.closest('label')?.querySelector('small');
    if(commentHelp&&commentHelp.textContent!==COMMENT_HELP_TEXT)commentHelp.textContent=COMMENT_HELP_TEXT;
    if(editor.querySelector('[data-delivery-guide]'))return;
    const guide=document.createElement('section');guide.className='delivery-auto-guide';guide.dataset.deliveryGuide='1';
    guide.innerHTML=`<div class="delivery-guide-head"><span>${icon('messages-square')}</span><div><strong>Выдача через комментарии</strong><p>Как в DollarTL: сам пост канала остаётся чистым, а служебный gate появляется ответом на automatic forward Telegram.</p></div></div><div class="delivery-flow-preview"><div class="delivery-flow-post"><small>ПОСТ В КАНАЛЕ</small><strong>Текст + изображение</strong><span>Без «Скачать», без Boosty-кнопок.</span></div><span class="delivery-flow-arrow">${icon('arrow-down')}</span><div class="delivery-flow-comment"><small>ОДИН КОММЕНТАРИЙ БОТА</small><p>📥 Файлы — через бота в личке.<br>❤️ Поддержать переводчика.</p><div><span>${icon('download')} Скачать</span><span>${icon('heart-handshake')} Поддержать</span></div></div></div><ul><li>Telegram создаёт automatic forward поста в связанную discussion group.</li><li>Бот отвечает на этот forward одним служебным комментарием.</li><li>Файлы в комментарии не публикуются: выдача идёт приватно через <code>/start dl_…</code>.</li><li>Перед выдачей проверяется подписка; после выдачи действует 7-дневный контроль.</li><li>Повторная выдача использует сохранённый Telegram <code>file_id</code>, R2 остаётся fallback.</li></ul>`;
    const preflight=editor.querySelector('.publishing-preflight');if(preflight)preflight.before(guide);else editor.append(guide);refreshIcons();
  }

  async function loadECharts(){
    if(window.echarts)return window.echarts;
    if(chartLoader)return chartLoader;
    chartLoader=new Promise((resolve,reject)=>{
      const existing=document.querySelector('script[data-domnkr-echarts]');
      if(existing){existing.addEventListener('load',()=>resolve(window.echarts),{once:true});existing.addEventListener('error',()=>reject(new Error('ECharts не загрузился.')),{once:true});return;}
      const script=document.createElement('script');script.src=ECHARTS_URL;script.async=true;script.dataset.domnkrEcharts='1';script.onload=()=>resolve(window.echarts);script.onerror=()=>reject(new Error('ECharts не загрузился.'));document.head.append(script);
    }).catch((error)=>{chartLoader=null;throw error;});
    return chartLoader;
  }

  async function renderCharts(data){
    const host=$('#publishingMainChart');if(!host||!active)return;
    try{
      const echarts=await loadECharts();if(!echarts||!active||!host.isConnected)return;
      const rows=data.daily||[];
      if(!rows.length){host.innerHTML='<div class="admin-empty">Недостаточно данных для графика.</div>';return;}
      const chart=echarts.init(host);charts.push(chart);
      chart.setOption({
        animationDuration:350,
        tooltip:{trigger:'axis'},
        legend:{top:0,left:0,itemWidth:10,itemHeight:6,textStyle:{fontSize:10}},
        grid:{left:42,right:18,top:42,bottom:32},
        xAxis:{type:'category',data:rows.map((row)=>shortDay(row.day)),boundaryGap:false,axisLabel:{fontSize:9,color:'#77756f'},axisLine:{lineStyle:{color:'#dedbd2'}},axisTick:{show:false}},
        yAxis:{type:'value',minInterval:1,axisLabel:{fontSize:9,color:'#77756f'},splitLine:{lineStyle:{color:'#eeece6'}}},
        series:[
          {name:'Читатели',type:'line',smooth:.32,symbol:'circle',symbolSize:5,data:rows.map((row)=>Number(row.readers||0)),lineStyle:{width:2.4},areaStyle:{opacity:.05}},
          {name:'Выдано файлов',type:'line',smooth:.32,symbol:'none',data:rows.map((row)=>Number(row.deliveries||0)),lineStyle:{width:2}},
          {name:'Открыли бота',type:'line',smooth:.32,symbol:'none',data:rows.map((row)=>Number(row.download_opens||0)),lineStyle:{width:1.6,type:'dashed'}},
          {name:'Поддержка',type:'bar',barMaxWidth:12,data:rows.map((row)=>Number(row.support_clicks||0)),itemStyle:{opacity:.68}},
        ],
      });
      if('ResizeObserver'in window){const observer=new ResizeObserver(()=>chart.resize());observer.observe(host);chartObservers.push(observer);}else window.addEventListener('resize',()=>chart.resize(),{passive:true});
    }catch(error){const fallback=$('#publishingChartFallback');if(fallback)fallback.classList.remove('hidden');host.classList.add('hidden');}
  }

  function cleanupCharts(){for(const observer of chartObservers){try{observer.disconnect();}catch{}}chartObservers=[];for(const chart of charts){try{chart.dispose();}catch{}}charts=[];}
  function empty(text){return`<div class="statistics-empty">${icon('inbox')}<span>${esc(text)}</span></div>`;}
  function emptyGood(text){return`<div class="statistics-empty good">${icon('circle-check-big')}<span>${esc(text)}</span></div>`;}
  function fmt(value){return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(Number(value||0));}
  function dateTime(value){if(!value)return'—';const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'}):String(value);}
  function shortDay(value){const date=new Date(`${value}T00:00:00Z`);return Number.isFinite(date.getTime())?date.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'}):String(value);}

  function mutationNeedsInstall(records){
    for(const record of records){
      for(const node of record.addedNodes){
        if(node.nodeType!==Node.ELEMENT_NODE)continue;
        const element=node;
        if(element.matches?.(INSTALL_SELECTOR)||element.querySelector?.(INSTALL_SELECTOR))return true;
      }
    }
    return false;
  }

  const observer=new MutationObserver((records)=>{
    if(!mutationNeedsInstall(records))return;
    queueMicrotask(()=>{installNavigation();installPublishingGuide();installPublicationReconcile();bindReconcileButtons();});
  });
  document.addEventListener('DOMContentLoaded',()=>{
    const app=$('#adminApp');if(app)observer.observe(app,{childList:true,subtree:true});
    installNavigation();installPublishingGuide();installPublicationReconcile();bindReconcileButtons();
  });
})();
