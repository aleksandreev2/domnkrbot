(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const $$=(selector,root=document)=>Array.from(root.querySelectorAll(selector));

  function patchKpis(page){
    for(const card of $$('.statistics-kpi',page)){
      const label=$('.statistics-kpi-copy small',card);
      const sub=$('.statistics-kpi-copy p',card);
      if(!label)continue;
      if(label.textContent.trim()==='Нажали в комментарии'){
        label.textContent='Нажали «Спасибо»';
        if(sub)sub.textContent='thank-gate в discussion перед открытием бота';
      }else if(label.textContent.trim()==='Сказали «Спасибо»'){
        label.textContent='Уникальные «Спасибо»';
        if(sub)sub.textContent='уникальные reader grants для релизов';
      }
    }
  }

  function patchFunnel(page){
    const rows=$$('.statistics-funnel-row',page);
    if(rows.length<5)return;
    const firstLabel=$('.statistics-funnel-head span',rows[0]);
    const firstHint=$('small',rows[0]);
    if(firstLabel)firstLabel.textContent='Нажали «Спасибо» в комментарии';
    if(firstHint)firstHint.textContent='Старт выдачи';

    const duplicateThanks=rows[3];
    duplicateThanks.hidden=true;
    duplicateThanks.dataset.thankGateDuplicate='1';

    const supportHint=$('small',rows[4]);
    if(supportHint)supportHint.textContent='Поддержка после получения файлов';

    const note=$('.statistics-inline-note',page);
    if(note)note.innerHTML='Спасибо → Bot: <b>открытие бота</b> · Bot → Reader: <b>успешная выдача</b>';
  }

  function patch(root=document){
    const pages=[];
    if(root instanceof Element&&root.matches('.statistics-page'))pages.push(root);
    if(root.querySelectorAll)pages.push(...root.querySelectorAll('.statistics-page'));
    for(const page of pages){
      if(page.dataset.thankGateAnalytics==='1')continue;
      patchKpis(page);patchFunnel(page);page.dataset.thankGateAnalytics='1';
    }
  }

  const observer=new MutationObserver((records)=>{
    for(const record of records){
      for(const node of record.addedNodes){
        if(node.nodeType!==Node.ELEMENT_NODE)continue;
        const element=node;
        if(element.matches?.('.statistics-page')||element.querySelector?.('.statistics-page')){queueMicrotask(()=>patch(element));return;}
      }
    }
  });

  document.addEventListener('DOMContentLoaded',()=>{
    const root=$('#adminContent');
    if(root)observer.observe(root,{childList:true,subtree:true});
    patch();
  });
})();