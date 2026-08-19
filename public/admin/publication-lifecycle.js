(() => {
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let loading=false;
  let scheduled=0;

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  function statusLabel(status){
    if(status==='published')return'Опубликовано';
    if(status==='deleted')return'Удалено из Telegram';
    return status||'—';
  }

  function schedule(){
    clearTimeout(scheduled);
    scheduled=setTimeout(()=>void install(),60);
  }

  async function install(force=false){
    const host=document.getElementById('publishingBody');
    if(!host||loading)return;
    const existing=document.getElementById('publicationLifecyclePanel');
    if(existing&&!force)return;
    if(existing)existing.remove();
    loading=true;
    try{
      const data=await api('/api/admin/publishing');
      if(!document.getElementById('publishingBody'))return;
      const items=(data.publications||[]).filter((item)=>item.status==='published'||item.status==='deleted');
      const panel=document.createElement('section');
      panel.id='publicationLifecyclePanel';
      panel.className='admin-panel publication-lifecycle-panel';
      panel.innerHTML=`<div class="admin-panel-head"><div><h2>Управление опубликованными</h2><p>Редактирование Telegram-поста и удаление из канала без удаления записи и файлов.</p></div><button type="button" data-life-refresh>Обновить</button></div><div class="publication-lifecycle-list">${items.length?items.map(row).join(''):'<div class="admin-empty">Опубликованных постов пока нет.</div>'}</div>`;
      host.append(panel);
      panel.querySelector('[data-life-refresh]')?.addEventListener('click',()=>void install(true));
      panel.querySelectorAll('[data-life-edit]').forEach((button)=>button.addEventListener('click',()=>openEditor(Number(button.dataset.lifeEdit),items)));
      panel.querySelectorAll('[data-life-delete]').forEach((button)=>button.addEventListener('click',()=>void deleteFromTelegram(Number(button.dataset.lifeDelete))));
    }catch(error){
      const hostNow=document.getElementById('publishingBody');
      if(hostNow&&!document.getElementById('publicationLifecyclePanel')){
        const panel=document.createElement('section');panel.id='publicationLifecyclePanel';panel.className='admin-panel publication-lifecycle-panel';panel.innerHTML=`<div class="notice error">${esc(error.message)}</div>`;hostNow.append(panel);
      }
    }finally{loading=false;}
  }

  function row(item){
    const deleted=item.status==='deleted';
    return `<article class="publication-lifecycle-row"><div class="publication-lifecycle-copy"><strong>${esc(item.internal_title)}</strong><span>#${Number(item.id)} · ${Number(item.file_count||0)} файл(ов)</span><p>${esc(item.body_html||'')}</p></div><span class="admin-badge ${deleted?'rejected':'published'}">${statusLabel(item.status)}</span><div class="publication-lifecycle-actions"><button type="button" data-life-edit="${Number(item.id)}">Редактировать</button>${deleted?'':`<button class="danger" type="button" data-life-delete="${Number(item.id)}">Удалить из Telegram</button>`}</div></article>`;
  }

  function openEditor(id,items){
    const item=items.find((entry)=>Number(entry.id)===id);if(!item)return;
    let dialog=document.getElementById('publicationEditDialog');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='publicationEditDialog';dialog.className='publication-edit-dialog';document.body.append(dialog);}
    dialog.innerHTML=`<form method="dialog" class="publication-edit-card"><div class="publication-edit-head"><div><span>ПУБЛИКАЦИЯ #${id}</span><h2>Редактировать текст</h2></div><button value="cancel" aria-label="Закрыть">×</button></div><label><span>Основной текст <b id="publicationEditCounter">${String(item.body_html||'').length} / 700</b></span><textarea id="publicationEditBody" maxlength="700" rows="10">${esc(item.body_html||'')}</textarea></label><p>Служебные строки про файлы и команду добавляются автоматически. Для опубликованного поста сначала обновляется Telegram, и только после успеха — D1.</p><div class="publication-edit-actions"><button value="cancel">Отмена</button><button id="publicationEditSave" class="primary" value="save">Сохранить</button></div></form>`;
    const textarea=dialog.querySelector('#publicationEditBody');
    textarea?.addEventListener('input',()=>{const counter=dialog.querySelector('#publicationEditCounter');if(counter)counter.textContent=`${textarea.value.length} / 700`;});
    dialog.querySelector('#publicationEditSave')?.addEventListener('click',(event)=>{event.preventDefault();void saveEdit(id,textarea?.value||'',dialog);});
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  }

  async function saveEdit(id,body,dialog){
    const button=dialog.querySelector('#publicationEditSave');if(button)button.disabled=true;
    try{
      await api(`/api/admin/publications/${id}/edit`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body})});
      dialog.close?.();
      await install(true);
    }catch(error){
      alert(error.message);
      if(button)button.disabled=false;
    }
  }

  async function deleteFromTelegram(id){
    if(!confirm('Удалить этот пост из Telegram? Запись публикации и файлы останутся в админке.'))return;
    try{
      await api(`/api/admin/publications/${id}/delete-telegram`,{method:'POST'});
      await install(true);
    }catch(error){alert(error.message);}
  }

  const observer=new MutationObserver(schedule);
  document.addEventListener('DOMContentLoaded',()=>{observer.observe(document.body,{childList:true,subtree:true});schedule();});
})();
