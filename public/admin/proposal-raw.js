(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  let loading=false;

  async function api(path){const response=await fetch(path,{credentials:'same-origin'});const body=await response.json().catch(()=>null);if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);return body;}

  async function enhance(){
    const content=$('#adminContent');const page=$('#pageTitle');
    if(!content||page?.textContent.trim()!=='Заявки'||content.querySelector('[data-proposal-raw-panel]')||loading)return;
    loading=true;
    try{
      const data=await api('/api/admin/title-proposal-details');
      if(page.textContent.trim()!=='Заявки'||content.querySelector('[data-proposal-raw-panel]'))return;
      const proposals=data.proposals||[];
      const panel=document.createElement('section');panel.className='admin-panel proposal-raw-panel';panel.dataset.proposalRawPanel='1';
      panel.innerHTML=`<div class="admin-panel-head"><div><h2>Исходники новых тайтлов</h2><p>Оригинальные названия, RAW-ссылки и приватные файлы из R2.</p></div><span class="admin-badge">${proposals.length}</span></div><div class="proposal-raw-list">${proposals.length?proposals.map(row).join(''):'<div class="admin-empty">Новых заявок на тайтлы пока нет.</div>'}</div>`;
      content.append(panel);refreshIcons();
    }catch(error){if(page?.textContent.trim()==='Заявки'&&!content.querySelector('[data-proposal-raw-panel]')){const panel=document.createElement('section');panel.className='admin-panel proposal-raw-panel';panel.dataset.proposalRawPanel='1';panel.innerHTML=`<div class="notice error">Детали RAW не загружены: ${esc(error.message)}</div>`;content.append(panel);}}
    finally{loading=false;}
  }

  function row(item){
    const ready=item.raw_status==='ready';const rawFile=item.raw_upload_id&&ready?`<a class="mini-button" href="/api/admin/proposal-raw/${encodeURIComponent(item.raw_upload_id)}/download"><i data-lucide="download"></i> RAW · ${formatBytes(Number(item.raw_size||0))}</a>`:'';
    const rawUrl=item.source_url?`<a class="mini-button" href="${esc(item.source_url)}" target="_blank" rel="noreferrer"><i data-lucide="link-2"></i> RAW URL</a>`:'';
    const extra=item.extra_url?`<a class="mini-button" href="${esc(item.extra_url)}" target="_blank" rel="noreferrer"><i data-lucide="external-link"></i> Доп. ссылка</a>`:'';
    return `<div class="proposal-raw-row"><span class="proposal-raw-icon"><i data-lucide="file-text"></i></span><div class="proposal-raw-copy"><strong>${esc(item.title||'Без названия')}</strong><span>${item.original_title?`${esc(item.original_title)} · `:''}${esc(item.username?'@'+item.username:item.first_name||item.user_telegram_id||'Пользователь')}</span></div><span class="admin-badge ${esc(item.status||'pending')}">${esc(item.status||'pending')}</span><div class="proposal-raw-actions">${rawFile}${rawUrl}${extra}</div></div>`;
  }
  function formatBytes(bytes){if(bytes>=1024**3)return`${(bytes/1024**3).toFixed(2)} ГиБ`;if(bytes>=1024**2)return`${(bytes/1024**2).toFixed(1)} МиБ`;return`${Math.max(0,bytes/1024).toFixed(1)} КиБ`;}
  const observer=new MutationObserver(()=>queueMicrotask(enhance));
  document.addEventListener('DOMContentLoaded',()=>{const app=$('#adminApp');if(app)observer.observe(app,{childList:true,subtree:true});void enhance();});
})();
