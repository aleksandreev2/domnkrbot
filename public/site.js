(() => {
  const state={bootstrap:null,ranobelib:null};
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  async function boot(){
    bind();refreshIcons();
    try{
      const [bootstrap,ranobelib]=await Promise.all([api('/api/bootstrap'),api('/api/ranobelib')]);
      state.bootstrap=bootstrap;state.ranobelib=ranobelib;
      renderSession();renderRanobelib();renderProposals(bootstrap.proposals||[]);
    }catch(error){
      $('#releaseList').innerHTML=emptyState('triangle-alert','Не удалось загрузить релизы',error.message);
      $('#proposalList').innerHTML=emptyState('triangle-alert','Не удалось загрузить заявки','Обновите страницу чуть позже.');
      refreshIcons();
    }
  }

  function bind(){
    $('#proposalForm')?.addEventListener('submit',submitProposal);
    $('#proposalType')?.addEventListener('change',()=>$('#chapterFields')?.classList.toggle('hidden',$('#proposalType').value!=='chapters'));
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
    $('#proposalOpen')?.addEventListener('click',openProposalDialog);
    $('#proposalOpenHero')?.addEventListener('click',openProposalDialog);
    $('#proposalClose')?.addEventListener('click',closeProposalDialog);
    $('#proposalDialog')?.addEventListener('click',(event)=>{if(event.target===event.currentTarget)closeProposalDialog();});
  }

  function openProposalDialog(){
    const dialog=$('#proposalDialog');
    if(!dialog)return;
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
    if(!state.bootstrap?.user)mountTelegramLogin();
    refreshIcons();
  }

  function closeProposalDialog(){
    const dialog=$('#proposalDialog');
    if(!dialog)return;
    if(typeof dialog.close==='function'&&dialog.open)dialog.close();else dialog.removeAttribute('open');
  }

  function renderSession(){
    const user=state.bootstrap?.user;
    $('#logoutButton')?.classList.toggle('hidden',!user);
    $('#proposalForm')?.classList.toggle('hidden',!user);
    $('#loginCard')?.classList.toggle('hidden',Boolean(user));
    const account=$('#accountName span');
    if(user){
      if(account)account.textContent=user.username?`@${user.username}`:user.firstName;
      refreshIcons();
      return;
    }
    if(account)account.textContent='Гость';
    refreshIcons();
  }

  function mountTelegramLogin(){
    const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;
    const bot=state.bootstrap?.botUsername;if(!bot){host.innerHTML='<span class="form-note">BOT_USERNAME не настроен.</span>';return;}
    host.dataset.ready='1';host.innerHTML='';
    const script=document.createElement('script');
    script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';
    script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';
    script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';
    host.append(script);
  }

  function renderRanobelib(){
    const data=state.ranobelib||{};const stats=data.stats||{};
    $('#statTitles').textContent=stats.activeTitles??0;
    $('#statSynced').textContent=stats.syncedTitles??0;
    $('#statReleases').textContent=stats.releases??0;
    const releases=(data.releases||[]).slice(0,8);
    $('#releaseList').innerHTML=releases.length
      ?releases.map((item)=>`<article class="release"><span class="release-icon"><i data-lucide="book-open-check" aria-hidden="true"></i></span><div class="release-copy"><strong>${esc(item.title||'Без названия')}</strong><span class="release-meta">${esc(item.summary||chapterLabel(item))}</span></div><span class="release-date">${dateLabel(item.created_at)||'сейчас'}</span></article>`).join('')
      :emptyState('book-dashed','Релизов пока нет','Как только синхронизация найдёт новую главу, она появится здесь.');
    refreshIcons();
  }

  function chapterLabel(item){
    if(Number(item.chapter_count)>1)return`${item.chapter_count} новых глав`;
    const volume=item.last_volume?`Том ${item.last_volume}`:'';const number=item.last_number?`глава ${item.last_number}`:'';
    return[volume,number].filter(Boolean).join(' · ')||'Новая глава';
  }

  function renderProposals(items){
    const host=$('#proposalList');if(!host)return;
    host.innerHTML=items.length
      ?items.slice(0,12).map((item)=>`<article class="proposal" data-id="${esc(item.id)}"><span class="proposal-icon"><i data-lucide="file-text" aria-hidden="true"></i></span><div class="proposal-copy"><strong>${esc(item.title)}</strong><p>${esc(item.comment||item.source_url||'Без комментария')}</p></div><span class="status ${esc(item.status)}">${statusLabel(item.status)}</span><div class="vote-row"><button class="vote ${item.viewer_voted?'active':''}" type="button" data-vote ${!state.bootstrap?.user||item.is_owner?'disabled':''}><i data-lucide="arrow-up" aria-hidden="true"></i><span>${Number(item.vote_count||0)+(item.is_owner?1:0)}</span></button>${item.is_owner?'<span class="form-note">ваша заявка</span>':''}</div></article>`).join('')
      :emptyState('inbox','Заявок пока нет','Можно стать первым и предложить следующий перевод.');
    host.querySelectorAll('[data-vote]').forEach((button)=>button.addEventListener('click',()=>void vote(button.closest('[data-id]')?.dataset.id,button)));
    refreshIcons();
  }

  async function vote(id,button){
    if(!id)return;button.disabled=true;
    try{const result=await api(`/api/proposals/${encodeURIComponent(id)}/vote`,{method:'POST'});button.classList.toggle('active',result.voted);button.querySelector('span').textContent=String(result.voteCount);}
    catch(error){setInlineNote(error.message);}finally{button.disabled=false;}
  }

  async function submitProposal(event){
    event.preventDefault();const note=$('#proposalNote');const button=$('#proposalSubmit');button.disabled=true;note.textContent='Отправляем…';
    const type=$('#proposalType').value;
    const payload={proposalType:type,title:$('#proposalTitle').value,sourceUrl:$('#proposalSource').value,comment:$('#proposalComment').value,chapterFrom:type==='chapters'?$('#chapterFrom').value:null,chapterTo:type==='chapters'?$('#chapterTo').value:null};
    try{
      await api('/api/proposals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      event.currentTarget.reset();$('#chapterFields').classList.add('hidden');note.textContent='Заявка отправлена.';
      state.bootstrap=await api('/api/bootstrap');renderProposals(state.bootstrap.proposals||[]);
      window.setTimeout(closeProposalDialog,500);
    }catch(error){note.textContent=error.message;}finally{button.disabled=false;}
  }

  function setInlineNote(message){const note=$('#proposalNote');if(note)note.textContent=message;}
  function emptyState(icon,title,text){return`<div class="empty-state"><span class="empty-icon"><i data-lucide="${icon}" aria-hidden="true"></i></span><div><strong>${esc(title)}</strong><span>${esc(text)}</span></div></div>`;}
  function statusLabel(status){return({pending:'Новая',approved:'Одобрено',planned:'В плане',in_progress:'В работе',done:'Готово',rejected:'Отклонено'})[status]||status;}
  function dateLabel(value){if(!value)return'';const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleDateString('ru-RU',{day:'2-digit',month:'short'});}
  document.addEventListener('DOMContentLoaded',boot);
})();
