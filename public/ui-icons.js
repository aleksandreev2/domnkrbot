(() => {
  const routeIcons={overview:'layout-dashboard',publishing:'send',requests:'inbox',files:'paperclip',sync:'refresh-cw',settings:'settings'};
  const exactIcons={'⌂':'layout-dashboard','✎':'file-pen-line','☷':'inbox','▱':'paperclip','↻':'refresh-cw','⚙':'settings','✓':'circle-check','▤':'library-big','↗':'arrow-up-right','▣':'image','✦':'sparkles','⇧':'upload','!':'triangle-alert'};
  const leadingIcons={'✎':'file-pen-line','▱':'paperclip','☷':'inbox','↻':'refresh-cw','✓':'check','✦':'sparkles','⇧':'upload','↗':'arrow-up-right'};
  const labelIcons=new Map([
    ['Открыть Publishing','arrow-up-right'],['Все заявки','list-filter'],['Синхронизировать','refresh-cw'],['Сохранить настройки','save'],['Проверить','shield-check'],['Применить','wand-sparkles'],['Сохранить шаблон','save'],['Создать черновик публикации','file-plus-2'],['Очистить','eraser'],['Тестовая отправка','send'],['Опубликовать','send'],['Удалить','trash-2'],['Редактировать','pencil'],['Скачать','download'],['Выйти','log-out']
  ]);
  let queued=false;

  function placeholder(name,className=''){
    const icon=document.createElement('i');
    icon.setAttribute('data-lucide',name);icon.setAttribute('aria-hidden','true');
    if(className)icon.className=className;
    return icon;
  }

  function replaceExact(el,name){
    if(!el||el.querySelector('svg,[data-lucide]'))return false;
    el.textContent='';el.append(placeholder(name));return true;
  }

  function upgradeNavigation(){
    document.querySelectorAll('[data-route]').forEach((item)=>{
      const holder=item.querySelector('.nav-icon');
      const name=routeIcons[item.dataset.route];
      if(holder&&name)replaceExact(holder,name);
    });
  }

  function upgradeExactGlyphs(){
    document.querySelectorAll('.admin-stat-icon,.publication-thumb,.file-icon,.empty-icon,.round-icon').forEach((el)=>{
      const name=exactIcons[el.textContent.trim()];if(name)replaceExact(el,name);
    });
  }

  function replaceLeadingGlyph(el,glyph,name){
    if(!el||el.querySelector('svg,[data-lucide]'))return;
    for(const node of [...el.childNodes]){
      if(node.nodeType!==Node.TEXT_NODE)continue;
      const source=node.nodeValue||'';const trimmed=source.trimStart();
      if(!trimmed.startsWith(glyph))continue;
      node.nodeValue=trimmed.slice(glyph.length).replace(/^\s+/, '');
      el.prepend(placeholder(name,'inline-icon'));return;
    }
  }

  function upgradeLeadingGlyphs(){
    document.querySelectorAll('button,a,.preflight-check,.save-status').forEach((el)=>{
      for(const [glyph,name] of Object.entries(leadingIcons))replaceLeadingGlyph(el,glyph,name);
    });
  }

  function upgradeButtons(){
    document.querySelectorAll('button,a').forEach((el)=>{
      if(el.querySelector('svg,[data-lucide]'))return;
      const label=(el.textContent||'').trim().replace(/\s+/g,' ');
      const name=labelIcons.get(label);if(!name)return;
      el.prepend(placeholder(name,'inline-icon'));
    });
  }

  function refresh(){
    queued=false;
    if(!window.lucide?.createIcons)return;
    upgradeNavigation();upgradeExactGlyphs();upgradeLeadingGlyphs();upgradeButtons();
    if(document.querySelector('[data-lucide]'))window.lucide.createIcons({attrs:{'stroke-width':1.8,'aria-hidden':'true'}});
  }

  function schedule(){if(queued)return;queued=true;queueMicrotask(refresh);}
  window.DomNkrIcons={refresh:schedule};
  document.addEventListener('DOMContentLoaded',()=>{refresh();const root=document.body;if(root)new MutationObserver(schedule).observe(root,{childList:true,subtree:true});});
})();
