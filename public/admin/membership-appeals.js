(()=>{
  const state={appeals:[],filter:'pending'};
  const $=(selector,root=document)=>root.querySelector(selector);
  const $$=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const contentType=response.headers.get('content-type')||'';
    const body=contentType.includes('application/json')?await response.json().catch(()=>null):null;
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  function dateTime(value){
    if(!value)return'—';
    const date=new Date(value);
    return Number.isNaN(date.getTime())?'—':date.toLocaleString('ru-RU',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  }

  function userLabel(item){
    if(item.username)return`@${item.username}`;
    const name=[item.first_name,item.last_name].filter(Boolean).join(' ').trim();
    return name||`Telegram ID ${item.user_telegram_id}`;
  }

  function statusLabel(status){
    return({draft:'Черновик',pending:'На рассмотрении',approved:'Одобрено',rejected:'Отклонено',cancelled:'Отменено'})[status]||status;
  }

  function statusClass(status){return['pending','approved','rejected','draft','cancelled'].includes(status)?status:'draft';}

  function visibleAppeals(){
    if(state.filter==='all')return state.appeals;
    return state.appeals.filter((item)=>item.status===state.filter);
  }

  function render(){
    const host=$('#membershipAppealsList');
    const items=visibleAppeals();
    $('#appealPendingCount').textContent=String(state.appeals.filter((item)=>item.status==='pending').length);
    $$('[data-appeal-filter]').forEach((button)=>button.classList.toggle('active',button.dataset.appealFilter===state.filter));
    if(!items.length){host.innerHTML='<div class="appeals-empty">Здесь пока нет апелляций.</div>';return;}
    host.innerHTML=items.map((item)=>appealCard(item)).join('');
    $$('[data-appeal-resolve]',host).forEach((button)=>button.addEventListener('click',()=>void resolveAppeal(button.dataset.appealId,button.dataset.appealResolve)));
  }

  function appealCard(item){
    const pending=item.status==='pending';
    const adminComment=item.admin_comment?`<div class="appeal-copy-block"><span>Комментарий администратора</span><p>${esc(item.admin_comment)}</p></div>`:'';
    return`<article class="appeal-card" data-appeal-id="${esc(item.id)}">
      <div class="appeal-card-head">
        <div><strong>${esc(userLabel(item))}</strong><span>ID ${esc(item.user_telegram_id)} · ${dateTime(item.submitted_at||item.created_at)}</span></div>
        <span class="appeal-status ${statusClass(item.status)}">${esc(statusLabel(item.status))}</span>
      </div>
      <div class="appeal-meta-grid">
        <div><span>Причина блокировки</span><strong>${esc(item.blacklist_reason||'—')}</strong></div>
        <div><span>Заблокирован</span><strong>${dateTime(item.blacklisted_at)}</strong></div>
        <div><span>Апелляция</span><strong>${esc(item.id)}</strong></div>
      </div>
      <div class="appeal-copy-block"><span>Комментарий пользователя</span><p>${esc(item.user_comment||'Без комментария')}</p></div>
      ${adminComment}
      ${pending?`<label class="appeal-admin-comment"><span>Комментарий администратору / пользователю</span><textarea maxlength="1500" rows="3" placeholder="Необязательно. Причина решения будет отправлена пользователю."></textarea></label>
        <div class="appeal-actions">
          <button class="approve" type="button" data-appeal-resolve="approve" data-appeal-id="${esc(item.id)}">✅ Разблокировать</button>
          <button class="reject" type="button" data-appeal-resolve="reject" data-appeal-id="${esc(item.id)}">❌ Отклонить</button>
        </div>`:`<div class="appeal-resolved">Решение: ${esc(statusLabel(item.status))}${item.resolved_at?` · ${dateTime(item.resolved_at)}`:''}</div>`}
    </article>`;
  }

  async function load(){
    const host=$('#membershipAppealsList');
    host.innerHTML='<div class="appeals-loading">Загрузка апелляций…</div>';
    try{
      const session=await api('/api/auth/session');
      if(!session?.user||!session.isAdmin){location.href='/admin/';return;}
      const data=await api('/api/admin/membership-appeals');
      state.appeals=data.appeals||[];
      render();
    }catch(error){showNotice(error.message,true);host.innerHTML='<div class="appeals-empty">Не удалось загрузить апелляции.</div>';}
  }

  async function resolveAppeal(id,decision){
    const card=document.querySelector(`[data-appeal-id="${CSS.escape(id)}"]`);
    const adminComment=card?.querySelector('textarea')?.value.trim()||'';
    const buttons=card?$$('[data-appeal-resolve]',card):[];
    buttons.forEach((button)=>button.disabled=true);
    try{
      await api(`/api/admin/membership-appeals/${encodeURIComponent(id)}/resolve`,{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify(decision==='approve'?{decision:'approve',adminComment}:{decision:'reject',adminComment}),
      });
      showNotice(decision==='approve'?'Апелляция одобрена, блокировка снята.':'Апелляция отклонена.');
      await load();
    }catch(error){showNotice(error.message,true);buttons.forEach((button)=>button.disabled=false);}
  }

  function showNotice(message,error=false){
    const host=$('#membershipAppealsNotice');
    host.textContent=message;host.className=`appeals-notice${error?' error':''}`;
    clearTimeout(showNotice.timer);showNotice.timer=setTimeout(()=>host.classList.add('hidden'),4500);
  }

  function boot(){
    $$('[data-appeal-filter]').forEach((button)=>button.addEventListener('click',()=>{state.filter=button.dataset.appealFilter;render();}));
    $('#membershipAppealsRefresh')?.addEventListener('click',()=>void load());
    void load();
  }

  document.addEventListener('DOMContentLoaded',boot);
})();
