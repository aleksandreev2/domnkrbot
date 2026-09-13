(() => {
  const SOCIAL_SECTION_TO_TAB={comments:'comments',discussions:'discussions',review:'reviews'};

  function tabFromLocation(){
    const section=new URLSearchParams(location.search).get('section')||'';
    return SOCIAL_SECTION_TO_TAB[section]||'';
  }

  function replayCurrentSocialTab(attempt=0){
    const tab=tabFromLocation();
    if(!tab)return;
    const app=document.querySelector('#titleApp');
    const button=document.querySelector(`[data-title-tab="${tab}"]`);
    if(app&&!app.classList.contains('hidden')&&button&&!button.disabled){
      button.click();
      return;
    }
    if(attempt<100)setTimeout(()=>replayCurrentSocialTab(attempt+1),50);
  }

  document.addEventListener('DOMContentLoaded',()=>replayCurrentSocialTab());
  window.addEventListener('popstate',()=>replayCurrentSocialTab());
})();
