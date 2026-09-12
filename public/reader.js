(() => {
  const $=(selector,root=document)=>root.querySelector(selector);
  const $$=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
  const refreshIcons=()=>window.DomNkrIcons?.refresh?.();
  const params=new URLSearchParams(location.search);
  const ref=params.get('ref')||'';
  const chapter=params.get('chapter')||'';
  const PREFS_KEY='domnkr:reader:prefs:v2';
  const LEGACY_PREFS_KEY='domnkr:reader:prefs:v1';
  const DEFAULT_PREFS={theme:'default',background:'#434751',text:'#dbdbdb',size:24,line:1.7,width:47,spacing:10,indent:true,align:'left',font:'default',hideImages:false,hideHeading:false};
  const prefs={...DEFAULT_PREFS,...loadPrefs()};
  let data=null;
  let titleData=null;
  let chapterSort='new';
  let commentSort='new';
  let commentSession=null;
  let comments=[];
  let replyTo=null;
  let commentLoginMounted=false;

  async function api(path,options={}){
    const init={credentials:'same-origin',...options};
    if(options.body&&!options.headers)init.headers={'content-type':'application/json'};
    const response=await fetch(path,init);
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);
    return body;
  }

  async function boot(){
    bind();applyPrefs();refreshIcons();
    try{
      data=await api(`/api/reader/chapter?ref=${encodeURIComponent(ref)}&chapter=${encodeURIComponent(chapter)}`);
      render();markRead();
      await Promise.allSettled([loadCommentSession(),loadComments()]);
    }catch(error){renderError(error.message);}
  }

  function bind(){
    $('#readerBack')?.addEventListener('click',()=>{location.href=titleUrl();});
    $('#contentsButton')?.addEventListener('click',openChapters);
    $('#readerContentsLabel')?.addEventListener('click',openChapters);
    $('#settingsButton')?.addEventListener('click',()=>openPopup('readerSettings'));
    $('#bookmarkButton')?.addEventListener('click',toggleBookmark);
    $$('[data-popup-close]').forEach((node)=>node.addEventListener('click',()=>closePopup(node.dataset.popupClose)));
    $('#chapterSortButton')?.addEventListener('click',()=>{chapterSort=chapterSort==='new'?'old':'new';renderChapterList();});
    $('#jumpToCurrent')?.addEventListener('click',()=>{$(`[data-chapter-id="${cssEsc(chapter)}"]`)?.scrollIntoView({block:'center',behavior:reducedMotion()?'auto':'smooth'});});
    $$('[data-theme]').forEach((button)=>button.addEventListener('click',()=>setTheme(button.dataset.theme)));
    $$('[data-indent]').forEach((button)=>button.addEventListener('click',()=>{prefs.indent=button.dataset.indent==='on';saveAndApply();}));
    $$('[data-align]').forEach((button)=>button.addEventListener('click',()=>{prefs.align=button.dataset.align==='justify'?'justify':'left';saveAndApply();}));
    $('#readerFont')?.addEventListener('change',(event)=>{prefs.font=event.currentTarget.value;saveAndApply();});
    $('#backgroundColor')?.addEventListener('input',(event)=>{prefs.theme='custom';prefs.background=event.currentTarget.value;saveAndApply();});
    $('#textColor')?.addEventListener('input',(event)=>{prefs.theme='custom';prefs.text=event.currentTarget.value;saveAndApply();});
    bindRange('#fontSize','size',Number);bindRange('#lineHeight','line',Number);bindRange('#paragraphSpacing','spacing',Number);bindRange('#containerWidth','width',Number);
    $('#hideImages')?.addEventListener('change',(event)=>{prefs.hideImages=event.currentTarget.checked;saveAndApply();});
    $('#hideHeading')?.addEventListener('change',(event)=>{prefs.hideHeading=event.currentTarget.checked;saveAndApply();});
    $('#resetReaderSettings')?.addEventListener('click',()=>{Object.assign(prefs,DEFAULT_PREFS);saveAndApply();});
    $('#readerCommentSort')?.addEventListener('click',()=>{commentSort=commentSort==='new'?'old':'new';renderComments();});
    $('#readerCommentForm')?.addEventListener('submit',submitComment);
    $('#readerCommentCancelReply')?.addEventListener('click',()=>cancelReply());
    $('#readerCommentText')?.addEventListener('input',syncCommentSubmit);
    $('#readerCommentsList')?.addEventListener('click',handleCommentAction);
    window.addEventListener('scroll',updateScrollProgress,{passive:true});
    window.addEventListener('keydown',(event)=>{if(event.key==='Escape'){closeAllPopups();cancelReply();}});
  }
  function bindRange(selector,key,parse){$(selector)?.addEventListener('input',(event)=>{prefs[key]=parse(event.currentTarget.value);saveAndApply();});}

  function render(){
    const title=data.title||{};const ch=data.chapter||{};
    document.title=`${title.title||'Тайтл'} · Глава ${ch.number||ch.chapter_id} · НекромантЛиб`;
    $('#readerBookLink').href=titleUrl();$('#readerBookTitle').textContent=title.title||'Тайтл';$('#readerBookOriginal').textContent=title.original_title||'';
    const short=chapterLabel(ch);$('#readerChapterShort').textContent=short;$('#readerChapterMobile').textContent=short;$('#readerChapterTitle').textContent=`${short}${ch.name?` - ${ch.name}`:''}`;
    renderContent(data.content);renderNav();renderBookmark();updateScrollProgress();refreshIcons();
  }

  function renderContent(blocks){
    const host=$('#readerContent');host.replaceChildren();
    if(!Array.isArray(blocks)||!blocks.length){const panel=document.createElement('div');panel.className='reader-unavailable';const strong=document.createElement('strong');strong.textContent='Текст этой главы ещё не импортирован';const span=document.createElement('span');span.textContent='Открыть текст можно у текущего источника перевода.';panel.append(strong,span);if(data?.title?.url){const a=document.createElement('a');a.href=data.title.url;a.target='_blank';a.rel='noreferrer';a.textContent='Открыть источник';panel.append(a);}host.append(panel);return;}
    for(const block of blocks){const node=renderBlock(block);if(node)host.append(node);}
  }
  function renderBlock(block){if(!block||typeof block!=='object')return null;const type=String(block.type||'paragraph');if(type==='paragraph'){const p=document.createElement('p');p.className='node-paragraph';p.textContent=String(block.text||'');return p;}if(type==='quote'){const q=document.createElement('blockquote');q.textContent=String(block.text||'');return q;}if(type==='divider'){const d=document.createElement('div');d.className='reader-scene-divider';d.textContent='* * *';return d;}if(type==='image'){const src=String(block.src||'');if(!/^https?:\/\//i.test(src))return null;const img=document.createElement('img');img.src=src;img.alt=String(block.alt||'Иллюстрация к главе');img.loading='lazy';return img;}return null;}

  function renderNav(){setNav($('#readerPrevious'),data.previous,'previous');setNav($('#readerNext'),data.next,'next');setTopNav($('#readerPreviousTop'),data.previous);setTopNav($('#readerNextTop'),data.next);}
  function setNav(link,item,direction){if(!link)return;if(!item){link.classList.add('is-disabled');link.removeAttribute('href');return;}link.classList.remove('is-disabled');link.href=readerUrl(item.chapter_id);const label=link.querySelector('span');if(label)label.textContent=direction==='previous'?'Предыдущая':'Следующая';}
  function setTopNav(link,item){if(!link)return;if(!item){link.classList.add('is-disabled');link.removeAttribute('href');return;}link.classList.remove('is-disabled');link.href=readerUrl(item.chapter_id);}

  async function openChapters(){openPopup('readerChapters');if(titleData){renderChapterList();return;}const host=$('#readerChapterList');if(host)host.innerHTML='<div class="reader-list-loading">Загрузка…</div>';try{titleData=await api(`/api/title?ref=${encodeURIComponent(ref)}`);renderChapterList();}catch(error){if(host)host.innerHTML=`<div class="reader-list-loading">${escapeHtml(error.message)}</div>`;}}
  function renderChapterList(){const host=$('#readerChapterList');if(!host||!titleData)return;let chapters=[...(titleData.chapters||[])];chapters.sort((a,b)=>Number(a.chapter_id)-Number(b.chapter_id));if(chapterSort==='new')chapters.reverse();const sortLabel=$('#chapterSortButton span');if(sortLabel)sortLabel.textContent=chapterSort==='new'?'Сначала новые':'Сначала старые';host.innerHTML=chapters.length?chapters.map((item)=>chapterListRow(item)).join(''):'<div class="reader-list-loading">Глав нет.</div>';refreshIcons();}
  function chapterListRow(item){const current=String(item.chapter_id)===String(chapter);const label=chapterLabel(item);const name=String(item.name||'').trim();const date=formatDate(item.first_seen_at);if(item.readerAvailable){return`<a class="reader-chapter-row${current?' is-active':''}" data-chapter-id="${escapeHtml(item.chapter_id)}" href="${readerUrl(item.chapter_id)}"><span><strong>${escapeHtml(label)}</strong>${name?`<small>${escapeHtml(name)}</small>`:''}</span><time>${escapeHtml(date)}</time></a>`;}return`<div class="reader-chapter-row is-unavailable${current?' is-active':''}" data-chapter-id="${escapeHtml(item.chapter_id)}"><span><strong>${escapeHtml(label)}</strong>${name?`<small>${escapeHtml(name)}</small>`:''}</span><time>${escapeHtml(date)}</time></div>`;}

  async function loadCommentSession(){
    try{commentSession=await api('/api/auth/session');}catch{commentSession={user:null,isAdmin:false,botUsername:null};}
    syncCommentComposer();
  }

  async function loadComments(){
    setCommentMessage('Загрузка комментариев…');
    try{
      const result=await api(`/api/reader/comments?ref=${encodeURIComponent(ref)}&chapter=${encodeURIComponent(chapter)}`);
      comments=Array.isArray(result.comments)?result.comments:[];
      renderComments();
    }catch(error){comments=[];setCommentMessage(error.message||'Не удалось загрузить комментарии.');}
  }

  function syncCommentComposer(){
    const textarea=$('#readerCommentText');
    const loggedIn=Boolean(commentSession?.user);
    if(textarea){textarea.disabled=!loggedIn;textarea.placeholder='Написать комментарий...';}
    if(loggedIn){$('#readerCommentLogin')?.classList.add('hidden');}
    else mountCommentLogin();
    syncCommentSubmit();
  }

  function syncCommentSubmit(){
    const button=$('#readerCommentSubmit');
    const textarea=$('#readerCommentText');
    if(button)button.disabled=!commentSession?.user||!String(textarea?.value||'').trim();
  }

  function mountCommentLogin(){
    const host=$('#readerCommentLogin');if(!host)return;
    host.classList.remove('hidden');
    if(commentLoginMounted)return;
    const bot=commentSession?.botUsername;
    if(!bot){host.innerHTML='<span>Войдите через Telegram на главной странице, чтобы комментировать.</span><a href="/">Войти</a>';return;}
    commentLoginMounted=true;
    try{localStorage.setItem('domnkr:return-after-login',`${location.pathname}${location.search}`);}catch{}
    host.innerHTML='<span>Войдите через Telegram, чтобы комментировать.</span>';
    const widget=document.createElement('span');widget.className='reader-comment-login-widget';host.append(widget);
    const script=document.createElement('script');script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';script.dataset.telegramLogin=bot;script.dataset.size='medium';script.dataset.userpic='false';script.dataset.authUrl=`${location.origin}/auth/telegram/callback`;script.dataset.requestAccess='write';widget.append(script);
  }

  function renderComments(){
    const host=$('#readerCommentsList');if(!host)return;
    const sortLabel=$('#readerCommentSort span');if(sortLabel)sortLabel.textContent=commentSort==='new'?'Новые':'Старые';
    if(!comments.length){host.innerHTML='';setCommentMessage('Здесь пока нет комментариев.');refreshIcons();return;}
    setCommentMessage('');
    const byId=new Map(comments.map((item)=>[String(item.id),item]));
    const children=new Map();const roots=[];
    for(const item of comments){const parent=String(item.parentCommentId||'');if(parent&&byId.has(parent)){if(!children.has(parent))children.set(parent,[]);children.get(parent).push(item);}else roots.push(item);}
    const newest=(a,b)=>dateValue(b.createdAt)-dateValue(a.createdAt)||String(b.id).localeCompare(String(a.id));
    const oldest=(a,b)=>dateValue(a.createdAt)-dateValue(b.createdAt)||String(a.id).localeCompare(String(b.id));
    roots.sort(commentSort==='new'?newest:oldest);
    for(const list of children.values())list.sort(oldest);
    host.innerHTML=roots.map((item)=>renderComment(item,children,0)).join('');
    refreshIcons();
  }

  function renderComment(item,children,depth){
    const id=escapeHtml(item.id||'');
    const author=commentAuthor(item);
    const initial=escapeHtml((author.replace(/^@/,'').trim()[0]||'Н').toLocaleUpperCase('ru-RU'));
    const time=escapeHtml(dateRelative(item.createdAt)||formatDate(item.createdAt));
    const body=item.deleted?'<em class="reader-comment-deleted">Комментарий удалён</em>':escapeHtml(item.body||'').replace(/\n/g,'<br>');
    const reply=!item.deleted?`<button class="reader-comment-control" type="button" data-comment-action="reply" data-comment-id="${id}">ответить</button>`:'';
    const remove=item.canDelete?`<button class="reader-comment-control" type="button" data-comment-action="delete" data-comment-id="${id}">удалить</button>`:'';
    const upActive=Number(item.myVote)===1?' is-active':'';const downActive=Number(item.myVote)===-1?' is-active':'';
    const votes=item.deleted?'':`<div class="reader-comment-vote"><button class="reader-comment-vote-button up${upActive}" type="button" data-comment-action="up" data-comment-id="${id}" aria-label="Плюс"><i data-lucide="arrow-up"></i></button><span>${Number(item.score)||0}</span><button class="reader-comment-vote-button down${downActive}" type="button" data-comment-action="down" data-comment-id="${id}" aria-label="Минус"><i data-lucide="arrow-down"></i></button></div>`;
    const childHtml=(children.get(String(item.id))||[]).map((child)=>renderComment(child,children,Math.min(depth+1,6))).join('');
    return `<article class="reader-comment${item.deleted?' is-deleted':''}" data-comment-id="${id}" style="--reader-comment-depth:${Math.min(depth,6)}"><div class="reader-comment-body"><div class="reader-comment-head"><span class="reader-comment-avatar" aria-hidden="true">${initial}</span><strong class="reader-comment-author">${escapeHtml(author)}</strong><time class="reader-comment-time">${time}</time></div><div class="reader-comment-content">${body}</div><div class="reader-comment-controls">${reply}<button class="reader-comment-control" type="button" disabled>жалоба</button>${remove}${votes}</div></div>${childHtml?`<div class="reader-comment-children">${childHtml}</div>`:''}</article>`;
  }

  function commentAuthor(item){const username=String(item?.author?.username||'').trim();if(username)return`@${username}`;return String(item?.author?.firstName||'Читатель').trim()||'Читатель';}

  async function submitComment(event){
    event.preventDefault();
    if(!commentSession?.user){mountCommentLogin();return;}
    const textarea=$('#readerCommentText');const text=String(textarea?.value||'').trim();if(!text)return;
    setCommentMessage('Отправляем комментарий…');
    try{
      const result=await api('/api/reader/comments',{method:'POST',body:JSON.stringify({bookRef:ref,chapterId:Number(chapter),body:text,parentCommentId:replyTo?.id||null})});
      comments=Array.isArray(result.comments)?result.comments:[];
      if(textarea)textarea.value='';cancelReply(false);renderComments();syncCommentSubmit();
    }catch(error){setCommentMessage(error.message||'Не удалось отправить комментарий.');}
  }

  function handleCommentAction(event){
    const button=event.target.closest?.('[data-comment-action]');if(!button)return;
    const id=button.dataset.commentId;const action=button.dataset.commentAction;if(!id||!action)return;
    if(action==='reply'){startReply(id);return;}
    if(action==='delete'){void deleteComment(id);return;}
    if(action==='up'||action==='down')void voteComment(id,action==='up'?1:-1);
  }

  function startReply(id){
    const item=comments.find((comment)=>String(comment.id)===String(id));if(!item)return;
    if(!commentSession?.user){mountCommentLogin();return;}
    replyTo={id:String(item.id),name:commentAuthor(item)};
    const target=$('#readerReplyTarget');if(target){target.classList.remove('hidden');const text=target.querySelector('span');if(text)text.textContent=`Ответ для ${replyTo.name}`;}
    $('#readerCommentText')?.focus();refreshIcons();
  }

  function cancelReply(focus=false){
    replyTo=null;const target=$('#readerReplyTarget');target?.classList.add('hidden');const text=target?.querySelector('span');if(text)text.textContent='';if(focus)$('#readerCommentText')?.focus();
  }

  async function deleteComment(id){
    if(!commentSession?.user){mountCommentLogin();return;}
    if(typeof confirm==='function'&&!confirm('Удалить комментарий?'))return;
    setCommentMessage('Удаляем комментарий…');
    try{const result=await api(`/api/reader/comments/${encodeURIComponent(id)}`,{method:'DELETE'});comments=Array.isArray(result.comments)?result.comments:[];renderComments();}catch(error){setCommentMessage(error.message||'Не удалось удалить комментарий.');}
  }

  async function voteComment(id,value){
    if(!commentSession?.user){mountCommentLogin();return;}
    const item=comments.find((comment)=>String(comment.id)===String(id));if(!item||item.deleted)return;
    const next=Number(item.myVote)===value?0:value;
    try{const result=await api(`/api/reader/comments/${encodeURIComponent(id)}/vote`,{method:'PUT',body:JSON.stringify({value:next})});comments=Array.isArray(result.comments)?result.comments:[];renderComments();}catch(error){setCommentMessage(error.message||'Не удалось поставить оценку.');}
  }

  function setCommentMessage(message){const node=$('#readerCommentsMessage');if(!node)return;node.textContent=String(message||'');node.classList.toggle('hidden',!message);}

  function openPopup(id){closeAllPopups();const root=id==='readerChapters'?$('#readerChaptersRoot'):$('#readerSettingsRoot');if(!root)return;root.classList.remove('hidden');root.setAttribute('aria-hidden','false');$('#readerApp')?.setAttribute('aria-hidden','true');document.body.classList.add('reader-popup-open');refreshIcons();}
  function closePopup(id){const root=id==='readerChapters'?$('#readerChaptersRoot'):$('#readerSettingsRoot');if(root){root.classList.add('hidden');root.setAttribute('aria-hidden','true');}if(!$('.reader-popup:not(.hidden)')){$('#readerApp')?.setAttribute('aria-hidden','false');document.body.classList.remove('reader-popup-open');}}
  function closeAllPopups(){$$('.reader-popup').forEach((root)=>{root.classList.add('hidden');root.setAttribute('aria-hidden','true');});$('#readerApp')?.setAttribute('aria-hidden','false');document.body.classList.remove('reader-popup-open');}

  function setTheme(theme){const themes={paper:['#f2f2f3','#212529'],mint:['#dce5e2','#27262b'],cream:['#f5f1e5','#28282a'],sand:['#e5cf9d','#262425'],default:['#434751','#dbdbdb'],black:['#141414','#dddddd']};const values=themes[theme]||themes.default;prefs.theme=theme;prefs.background=values[0];prefs.text=values[1];saveAndApply();}
  function saveAndApply(){savePrefs();applyPrefs();}
  function applyPrefs(){document.documentElement.style.setProperty('--reader-background',prefs.background);document.documentElement.style.setProperty('--reader-text',prefs.text);document.documentElement.style.setProperty('--reader-font-size',`${Number(prefs.size)||24}px`);document.documentElement.style.setProperty('--reader-line-height',String(Number(prefs.line)||1.7));document.documentElement.style.setProperty('--reader-max-width',`${Number(prefs.width)||47}%`);document.documentElement.style.setProperty('--reader-block-offset',`${Math.max(0,Number(prefs.spacing)||0)/2}px`);document.documentElement.style.setProperty('--reader-text-indent',prefs.indent?'.875em':'0');document.documentElement.style.setProperty('--reader-text-align',prefs.align==='justify'?'justify':'left');document.documentElement.style.setProperty('--reader-font-family',fontFamily(prefs.font));document.body.classList.toggle('reader-hide-images',Boolean(prefs.hideImages));document.body.classList.toggle('reader-hide-heading',Boolean(prefs.hideHeading));syncSettings();refreshIcons();}
  function syncSettings(){setValue('#backgroundColor',prefs.background);setOutput('#backgroundColorValue',prefs.background);setValue('#textColor',prefs.text);setOutput('#textColorValue',prefs.text);setValue('#fontSize',prefs.size);setOutput('#fontSizeValue',`${prefs.size}px`);setValue('#lineHeight',prefs.line);setOutput('#lineHeightValue',String(prefs.line));setValue('#paragraphSpacing',prefs.spacing);setOutput('#paragraphSpacingValue',`${prefs.spacing}px`);setValue('#containerWidth',prefs.width);setOutput('#containerWidthValue',`${prefs.width}%`);setValue('#readerFont',prefs.font);const hideImages=$('#hideImages');if(hideImages)hideImages.checked=Boolean(prefs.hideImages);const hideHeading=$('#hideHeading');if(hideHeading)hideHeading.checked=Boolean(prefs.hideHeading);$$('[data-theme]').forEach((button)=>button.classList.toggle('is-active',button.dataset.theme===prefs.theme));$$('[data-indent]').forEach((button)=>button.classList.toggle('is-active',(button.dataset.indent==='on')===Boolean(prefs.indent)));$$('[data-align]').forEach((button)=>button.classList.toggle('is-active',button.dataset.align===(prefs.align==='justify'?'justify':'left')));}

  function toggleBookmark(){try{const key=`domnkr:reader:${ref}:bookmark:${chapter}`;const next=localStorage.getItem(key)!=='1';if(next)localStorage.setItem(key,'1');else localStorage.removeItem(key);renderBookmark();}catch{}}
  function renderBookmark(){let active=false;try{active=localStorage.getItem(`domnkr:reader:${ref}:bookmark:${chapter}`)==='1';}catch{}$('#bookmarkButton')?.classList.toggle('is-active',active);}
  function markRead(){try{const key=`domnkr:reader:${ref}:read`;const set=new Set(JSON.parse(localStorage.getItem(key)||'[]').map(String));set.add(String(chapter));localStorage.setItem(key,JSON.stringify(Array.from(set)));localStorage.setItem(`domnkr:reader:${ref}:last`,String(chapter));}catch{}}
  function updateScrollProgress(){const root=document.documentElement;const max=Math.max(1,root.scrollHeight-innerHeight);const percent=Math.max(0,Math.min(100,scrollY/max*100));const bar=$('#readerProgress');if(bar)bar.style.width=`${percent}%`;}
  function renderError(message){const host=$('#readerContent');if(!host)return;host.innerHTML='';const panel=document.createElement('div');panel.className='reader-unavailable';const strong=document.createElement('strong');strong.textContent='Не удалось открыть главу';const span=document.createElement('span');span.textContent=message;const a=document.createElement('a');a.href=titleUrl();a.textContent='Вернуться к тайтлу';panel.append(strong,span,a);host.append(panel);}

  function chapterLabel(item){const volume=String(item?.volume||'').trim();const number=String(item?.number||item?.chapter_id||'').trim();return`${volume?`Том ${volume} `:''}Глава ${number}`;}
  function formatDate(value){if(!value)return'';const date=new Date(value);if(!Number.isFinite(date.getTime()))return'';return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}).format(date);}
  function dateValue(value){const time=new Date(value||0).getTime();return Number.isFinite(time)?time:0;}
  function dateRelative(value){if(!value)return'';const time=new Date(value).getTime();if(!Number.isFinite(time))return'';const seconds=Math.max(0,Math.floor((Date.now()-time)/1000));if(seconds<60)return'только что';const minutes=Math.floor(seconds/60);if(minutes<60)return`${minutes} мин. назад`;const hours=Math.floor(minutes/60);if(hours<24)return`${hours} ч. назад`;const days=Math.floor(hours/24);if(days<30)return`${days} дн. назад`;const months=Math.floor(days/30);if(months<12)return`${months} мес. назад`;return`${Math.floor(months/12)} г. назад`;}
  function fontFamily(value){if(!value||value==='default')return'Arial,Helvetica,sans-serif';return`"${String(value).replace(/["\\]/g,'')}",Arial,Helvetica,sans-serif`;}
  function setValue(selector,value){const node=$(selector);if(node)node.value=String(value);}function setOutput(selector,value){const node=$(selector);if(node)node.textContent=String(value);}
  function titleUrl(){return`/title/?ref=${encodeURIComponent(ref)}`;}function readerUrl(id){return`/reader/?ref=${encodeURIComponent(ref)}&chapter=${encodeURIComponent(id)}`;}
  function loadPrefs(){try{const saved=JSON.parse(localStorage.getItem(PREFS_KEY)||'null');if(saved&&typeof saved==='object')return saved;const legacy=JSON.parse(localStorage.getItem(LEGACY_PREFS_KEY)||'null');if(!legacy||typeof legacy!=='object')return{};return migrateLegacy(legacy);}catch{return{};}}
  function migrateLegacy(legacy){const migrated={};if(legacy.theme==='dark')Object.assign(migrated,{theme:'black',background:'#141414',text:'#dddddd'});else if(legacy.theme==='sepia')Object.assign(migrated,{theme:'sand',background:'#e5cf9d',text:'#262425'});else if(legacy.theme==='light')Object.assign(migrated,{theme:'paper',background:'#f2f2f3',text:'#212529'});if(Number(legacy.size))migrated.size=Math.round(24*Number(legacy.size)/100);if(legacy.width)migrated.width=({narrow:40,medium:47,wide:62})[legacy.width]||47;if(legacy.line)migrated.line=({compact:1.55,normal:1.7,loose:2.05})[legacy.line]||1.7;if(legacy.font==='serif')migrated.font='Georgia';return migrated;}
  function savePrefs(){try{localStorage.setItem(PREFS_KEY,JSON.stringify(prefs));}catch{}}
  function escapeHtml(value=''){return String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
  function cssEsc(value=''){return window.CSS?.escape?window.CSS.escape(String(value)):String(value).replace(/[^a-zA-Z0-9_-]/g,'\\$&');}
  function reducedMotion(){return typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;}
  document.addEventListener('DOMContentLoaded',boot);
})();
