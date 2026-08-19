(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=(value='')=>String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();

  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options});
    const contentType=response.headers.get('content-type')||'';
    const body=contentType.includes('application/json')?await response.json().catch(()=>null):null;
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  function toast(text,error=false){
    const node=$('#toast');
    if(!node)return;
    node.textContent=text;
    node.classList.toggle('error',error);
    node.classList.remove('hidden');
    clearTimeout(node.__publishEditorTimer);
    node.__publishEditorTimer=setTimeout(()=>node.classList.add('hidden'),4200);
  }

  function editorSnapshot(){
    return {
      internal_title:$('#pubTitle')?.value||'',
      body_html:$('#pubBody')?.value||'',
      add_footer:Boolean($('#pubFooter')?.checked),
      add_bot_comment:Boolean($('#pubBotComment')?.checked),
    };
  }

  function editorFiles(){
    return {
      image:$('#pubImage')?.files?.[0]||null,
      files:Array.from($('#pubFiles')?.files||[]),
    };
  }

  function publicationFormData(){
    const snapshot=editorSnapshot();
    const selected=editorFiles();
    const data=new FormData();
    data.set('internal_title',snapshot.internal_title);
    data.set('body',snapshot.body_html);
    data.set('add_footer',snapshot.add_footer?'1':'0');
    data.set('add_bot_comment',snapshot.add_bot_comment?'1':'0');
    if(selected.image)data.set('image',selected.image);
    for(const file of selected.files)data.append('files',file);
    return data;
  }

  async function freshPreflight(updateDraftButton=true){
    const selected=editorFiles();
    const result=await api('/api/admin/publishing-center/preflight',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        ...editorSnapshot(),
        file_sizes:selected.files.map((file)=>file.size),
        image_size:selected.image?.size||0,
      }),
    });
    const list=$('#preflightList');
    if(list){
      list.innerHTML=(result.checks||[]).map((check)=>`<span class="preflight-check ${esc(check.status)}"><b>${esc(check.label)}</b> · ${esc(check.message)}</span>`).join('');
    }
    const draftButton=$('#createPublication');
    if(updateDraftButton&&draftButton)draftButton.disabled=!result.ready;
    return result;
  }

  function preflightError(result){
    const failed=(result?.checks||[]).find((check)=>check.status==='error');
    return failed?`${failed.label}: ${failed.message}`:'Проверка перед публикацией не пройдена.';
  }

  async function publishFromEditor(){
    const button=$('#publishNow');
    const draftButton=$('#createPublication');
    if(!button||button.disabled)return;
    const original=button.innerHTML;
    button.disabled=true;
    if(draftButton)draftButton.disabled=true;
    button.innerHTML='<i data-lucide="loader-circle" aria-hidden="true"></i> Проверяем…';
    refreshIcons();
    let publicationId=0;
    try{
      const preflight=await freshPreflight(false);
      if(!preflight.ready)throw new Error(preflightError(preflight));
      if(!confirm('Опубликовать сейчас в настроенный Telegram-канал?'))return;

      button.innerHTML='<i data-lucide="arrow-up" aria-hidden="true"></i> Загружаем…';
      refreshIcons();
      const created=await api('/api/admin/publications',{method:'POST',headers:{},body:publicationFormData()});
      publicationId=Number(created?.publication?.id||0);
      if(!publicationId)throw new Error('Backend создал публикацию без ID. Отправка остановлена.');

      button.innerHTML='<i data-lucide="send" aria-hidden="true"></i> Публикуем…';
      refreshIcons();
      await api(`/api/admin/publications/${publicationId}/publish`,{method:'POST'});
      toast(`Публикация #${publicationId} отправлена в Telegram-канал.`);
      $('[data-pubtab="publications"]')?.click();
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      if(publicationId){
        toast(`Запись #${publicationId} сохранена, но публикация не отправлена: ${message}`,true);
        $('[data-pubtab="publications"]')?.click();
      }else{
        toast(message,true);
      }
    }finally{
      if(button.isConnected){button.innerHTML=original;button.disabled=false;}
      if(draftButton?.isConnected)void freshPreflight().catch(()=>{draftButton.disabled=true;});
      refreshIcons();
    }
  }

  function enhanceEditor(){
    const draftButton=$('#createPublication');
    const actions=draftButton?.closest('.publisher-actions');
    if(!draftButton||!actions)return;

    if(draftButton.dataset.publishEditorEnhanced!=='1'){
      draftButton.dataset.publishEditorEnhanced='1';
      draftButton.classList.remove('primary');
      draftButton.innerHTML='<i data-lucide="save" aria-hidden="true"></i> Сохранить как черновик';
    }
    if($('#publishNow',actions))return;

    const publish=document.createElement('button');
    publish.id='publishNow';
    publish.type='button';
    publish.className='primary';
    publish.innerHTML='<i data-lucide="send" aria-hidden="true"></i> Опубликовать в канал';
    publish.addEventListener('click',()=>void publishFromEditor());
    actions.insertBefore(publish,draftButton);
    refreshIcons();
  }

  const observer=new MutationObserver(()=>queueMicrotask(enhanceEditor));
  document.addEventListener('DOMContentLoaded',()=>{
    const app=$('#adminApp');
    if(app)observer.observe(app,{childList:true,subtree:true});
    enhanceEditor();
  });
})();
