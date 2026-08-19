(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  let loading=false;

  async function api(path){
    const response=await fetch(path,{credentials:'same-origin'});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  async function enhance(){
    const content=$('#adminContent');const page=$('#pageTitle');
    if(!content||page?.textContent.trim()!=='Заявки'||content.querySelector('[data-proposal-raw-panel]')||loading)return;
    loading=true;
    try{
      const data=await api('/api/admin/proposal-raw');
      if(page.textContent.trim()!=='Заявки'||content.querySelector('[data-proposal-raw-panel]'))return;
      const uploads=data.uploads||[];
      const panel=document.createElement('section');panel.className='admin-panel proposal-raw-panel';panel.dataset.proposalRawPanel='1';
      panel.innerHTML=`<div class="admin-panel-head"><div><h2>RAW-файлы заявок</h2><p>Приватные исходники из R2. Скачать может только администратор.</p></div><span class="admin-badge">${uploads.length}</span></div><div class="proposal-raw-list">${uploads.length?uploads.map(row).join(''):'<div class="admin-empty">Загруженных RAW-файлов пока нет.</div>'}</div>`;
      content.append(panel);refreshIcons();
    }catch(error){
      if(page?.textContent.trim()==='Заявки'&&!content.querySelector('[data-proposal-raw-panel]')){
        const panel=document.createElement('section');panel.className='admin-panel proposal-raw-panel';panel.dataset.proposalRawPanel='1';panel.innerHTML=`<div class="notice error">RAW-файлы не загружены: ${esc(error.message)}</div>`;content.append(panel);
      }
    }finally{loading=false;}
  }

  function row(item){
    const ready=item.status==='ready';const attached=item.attached_proposal_id?`Заявка #${esc(String(item.attached_proposal_id).slice(0,8))}`:'Не прикреплён';
    return `<div class="proposal-raw-row"><span class="proposal-raw-icon"><i data-lucide="file-archive"></i></span><div class="proposal-raw-copy"><strong>${esc(item.original_name||'RAW')}</strong><span>${esc(item.title||item.original_title||attached)} · ${formatBytes(Number(item.expected_size||0))}</span></div><span class="admin-badge ${ready?'published':'pending'}">${ready?'Готов':'Загрузка'}</span>${ready?`<a class="mini-button" href="/api/admin/proposal-raw/${encodeURIComponent(item.id)}/download"><i data-lucide="download"></i> Скачать</a>`:''}</div>`;
  }
  function formatBytes(bytes){if(bytes>=1024**3)return`${(bytes/1024**3).toFixed(2)} ГиБ`;if(bytes>=1024**2)return`${(bytes/1024**2).toFixed(1)} МиБ`;return`${Math.max(0,bytes/1024).toFixed(1)} КиБ`;}
  const observer=new MutationObserver(()=>queueMicrotask(enhance));
  document.addEventListener('DOMContentLoaded',()=>{const app=$('#adminApp');if(app)observer.observe(app,{childList:true,subtree:true});void enhance();});
})();
