(() => {
  const accountMenu=document.querySelector('.nl-account');
  const placeholder=document.querySelector('#telegramLogin');
  if(!accountMenu||!placeholder)return;

  placeholder.id='telegramLoginLazy';
  let loading=false;

  async function mountTelegramLogin(){
    if(loading||placeholder.dataset.ready==='1'||!placeholder.isConnected)return;
    loading=true;
    try{
      const response=await fetch('/api/bootstrap',{credentials:'same-origin'});
      const bootstrap=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(bootstrap?.error||`HTTP ${response.status}`);
      if(bootstrap?.user)return;
      const bot=bootstrap?.botUsername;
      if(!bot){placeholder.textContent='BOT_USERNAME не настроен.';return;}
      placeholder.dataset.ready='1';
      placeholder.innerHTML='';
      const script=document.createElement('script');
      script.async=true;
      script.src='https://telegram.org/js/telegram-widget.js?22';
      script.dataset.telegramLogin=bot;
      script.dataset.size='large';
      script.dataset.userpic='false';
      script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;
      script.dataset.requestAccess='write';
      placeholder.append(script);
    }catch{
      placeholder.textContent='Авторизация временно недоступна';
    }finally{
      loading=false;
    }
  }

  accountMenu.addEventListener('toggle',()=>{
    if(accountMenu.open)void mountTelegramLogin();
  });
})();
