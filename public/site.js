(() => {
  const state={bootstrap:null,ranobelib:null};
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  async function boot(){
    bind();
    try{
      const [bootstrap,ranobelib]=await Promise.all([api('/api/bootstrap'),api('/api/ranobelib')]);
      state.bootstrap=bootstrap;state.ranobelib=ranobelib;
      renderSession();renderRanobelib();renderProposals(bootstrap.proposals||[]);
    }catch(error){
      $('#releaseList').innerHTML=`<div class="empty">${esc(error.message)}</div>`;
      $('#proposalList').innerHTML=`<div class="empty">Не удалось загрузить заявки.</div>`;
    }
  }

  function bind(){
    $('#proposalForm')?.addEventListener('submit',submitProposal);
    $('#proposalType')?.addEventListener('change',()=>$('#chapterFields')?.classList.toggle('hidden',$('#proposalType').value!=='chapters'));
    $('#logoutButton')?.addEventListener('click',async()=>{await api('/auth/logout',{method:'POST'});location.reload();});
  }

  function renderSession(){
    const user=state.bootstrap?.user;
    $('#logoutButton')?.classList.toggle('hidden',!user);
    $('#proposalForm')?.classList.toggle('hidden',!user);
    $('#loginCard')?.classList.toggle('hidden',Boolean(user));
    if(user){
      $('#accountName').textContent=user.username?`@${user.username}`:user.firstName;
      return;
    }
    $('#accountName').textContent='Гость';
    mountTelegramLogin();
  }

  function mountTelegramLogin(){
    const host=$('#telegramLogin');if(!host||host.dataset.ready==='1')return;
    const bot=state.bootstrap?.botUsername;if(!bot){host.textContent='BOT_USERNAME не настроен.';return;}
    host.dataset.ready='1';host.innerHTML='';
    const script=document.createElement('script');
    script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';
    script.dataset.telegramLogin=bot;script.dataset.size='large';script.dataset.userpic='false';
    script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';
    host.append(script);
  }

  function renderRanobelib(){
    const data=state.ranobelib||{};const stats=data.stats||{};
    $('#statTitles').textContent=stats.activeTitles??0;$('#statSynced').textContent=stats.syncedTitles??0;$('#statReleases').textContent=stats.releases??0;
    const releases=(data.releases||[]).slice(0,8);
    $('#releaseList').innerHTML=releases.length?releases.map((item)=>`<article class="release"><strong>${esc(item.title||'Без названия')}</strong><span>${esc(item.summary||chapterLabel(item))} · ${dateLabel(item.created_at)}</span></article>`).join(''):'<div class="empty">Пока нет зафиксированных релизов.</div>';
  }

  function chapterLabel(item){
    if(Number(item.chapter_count)>1)return`${item.chapter_count} новых глав`;
    const volume=item.last_volume?`Том ${item.last_volume}`:'';const number=item.last_number?`глава ${item.last_number}`:'';
    return[volume,number].filter(Boolean).join(' · ')||'Новая глава';
  }

  function renderProposals(items){
    const host=$('#proposalList');if(!host)return;
    host.innerHTML=items.length?items.slice(0,12).map((item)=>`<article class="proposal" data-id="${esc(item.id)}"><div class="proposal-top"><div><strong>${esc(item.title)}</strong><p>${esc(item.comment||item.source_url||'Без комментария')}</p></div><span class="status ${esc(item.status)}">${statusLabel(item.status)}</span></div><div class="vote-row"><button class="vote ${item.viewer_voted?'active':''}" type="button" data-vote ${!state.bootstrap?.user||item.is_owner?'disabled':''}>▲ <span>${Number(item.vote_count||0)+(item.is_owner?1:0)}</span></button>${item.is_owner?'<span class="form-note">ваша заявка</span>':''}</div></article>`).join(''):'<div class="empty">Заявок пока нет.</div>';
    host.querySelectorAll('[data-vote]').forEach((button)=>button.addEventListener('click',()=>void vote(button.closest('[data-id]')?.dataset.id,button)));
  }

  async function vote(id,button){
    if(!id)return;button.disabled=true;
    try{const result=await api(`/api/proposals/${encodeURIComponent(id)}/vote`,{method:'POST'});button.classList.toggle('active',result.voted);button.querySelector('span').textContent=String(result.voteCount);}
    catch(error){alert(error.message);}finally{button.disabled=false;}
  }

  async function submitProposal(event){
    event.preventDefault();const note=$('#proposalNote');const button=$('#proposalSubmit');button.disabled=true;note.textContent='Отправляем…';
    const type=$('#proposalType').value;
    const payload={proposalType:type,title:$('#proposalTitle').value,sourceUrl:$('#proposalSource').value,comment:$('#proposalComment').value,chapterFrom:type==='chapters'?$('#chapterFrom').value:null,chapterTo:type==='chapters'?$('#chapterTo').value:null};
    try{await api('/api/proposals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});event.currentTarget.reset();$('#chapterFields').classList.add('hidden');note.textContent='Заявка отправлена.';state.bootstrap=await api('/api/bootstrap');renderProposals(state.bootstrap.proposals||[]);}
    catch(error){note.textContent=error.message;}finally{button.disabled=false;}
  }

  function statusLabel(status){return({pending:'Новая',approved:'Одобрено',planned:'В плане',in_progress:'В работе',done:'Готово',rejected:'Отклонено'})[status]||status;}
  function dateLabel(value){if(!value)return'';const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleDateString('ru-RU',{day:'2-digit',month:'short'});}
  document.addEventListener('DOMContentLoaded',boot);
})();
