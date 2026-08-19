import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOOSTY_SUPPORT_URL,
  composeManagedPublication,
  handlePublicationOpsWebhook,
} from '../dist-runtime/publication-ops.js';

const ORIGIN='https://domnkr.test';

class MockStatement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    if(this.query.includes('FROM publications WHERE id=?'))return this.db.publication&&Number(this.values[0])===this.db.publication.id?{...this.db.publication}:null;
    if(this.query.includes('FROM publications WHERE channel_message_id=?'))return this.db.publication&&Number(this.values[0])===this.db.publication.channel_message_id?{...this.db.publication}:null;
    if(this.query.includes('FROM publication_deliveries'))return this.db.delivery?{...this.db.delivery}:null;
    if(this.query.includes('SELECT value FROM app_settings')){
      if(this.values[0]==='discussion_chat_id')return{value:'-200'};
      return null;
    }
    return null;
  }
  async all(){
    if(this.query.includes('FROM publication_assets WHERE publication_id=?'))return{results:this.db.assets.map((row)=>({...row}))};
    return{results:[]};
  }
  async run(){
    this.db.operations.push({query:this.query,values:[...this.values]});
    if(this.query.startsWith('INSERT INTO publication_deliveries')){
      this.db.delivery={status:'sending',attempts:(this.db.delivery?.attempts||0)+1,first_delivered_at:this.db.delivery?.first_delivered_at||null,last_delivered_at:this.db.delivery?.last_delivered_at||null};
    }
    if(this.query.startsWith("UPDATE publication_deliveries SET status='delivered'")){
      this.db.delivery={status:'delivered',attempts:this.db.delivery?.attempts||1,first_delivered_at:String(this.values[0]),last_delivered_at:String(this.values[1])};
    }
    return{};
  }
}
class MockDB{
  constructor(){
    this.publication={id:7,status:'published',internal_title:'Глава 10',body_html:'Новая глава готова.',add_footer:1,add_bot_comment:1,image_key:null,image_mime:null,image_name:null,channel_message_id:123,discussion_message_id:null,error_text:null,created_by:'424242',created_at:'2026-08-19',updated_at:'2026-08-19',published_at:'2026-08-19'};
    this.assets=[{id:11,publication_id:7,file_name:'chapter.epub',mime_type:'application/epub+zip',r2_key:'publications/7/files/chapter.epub',size_bytes:1234,telegram_file_id:'telegram-cached-file',sort_order:0}];
    this.delivery=null;this.operations=[];
  }
  prepare(query){return new MockStatement(this,query);}
}

function env(db){return{DB:db,TELEGRAM_BOT_TOKEN:'123:test',BOT_USERNAME:'domnekromanta_bot'};}
function ctx(){const promises=[];return{promises,waitUntil(promise){promises.push(promise);}};}

async function withTelegramMock(fn){
  const original=globalThis.fetch;const calls=[];let messageId=100;
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),options});
    const method=String(url).split('/').pop();
    const payload=method==='sendDocument'?{message_id:++messageId,chat:{id:4242,type:'private'},document:{file_id:'telegram-cached-file'}}:{message_id:++messageId,chat:{id:4242,type:'private'}};
    return new Response(JSON.stringify({ok:true,result:payload}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{return await fn(calls);}finally{globalThis.fetch=original;}
}

test('managed publication automatically includes bot download and translator support copy',()=>{
  const text=composeManagedPublication({id:7,body_html:'Новая глава готова.',add_footer:1},1,'domnekromanta_bot');
  assert.match(text,/Скачать перевод можно через бота/);
  assert.match(text,/Поддержать переводчика/);
  assert.match(text,/Дом Некроманта/);
  assert.doesNotMatch(text,/Файлы находятся в комментариях/);
  assert.equal(BOOSTY_SUPPORT_URL,'https://boosty.to/domnekromanta/single-payment/donation/818248/target?share=target_link');
});

test('private /start download deep-link delivers cached Telegram file and records delivery',async()=>{
  const db=new MockDB();const execution=ctx();
  await withTelegramMock(async(calls)=>{
    const request=new Request(`${ORIGIN}/telegram/webhook`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:{message_id:1,chat:{id:4242,type:'private'},from:{id:4242,first_name:'Reader',username:'reader'},text:'/start dl_7'}})});
    const response=await handlePublicationOpsWebhook(request,env(db),execution);
    assert.ok(response);assert.equal(response.status,200);
    await Promise.all(execution.promises);
    const methods=calls.map((call)=>call.url.split('/').pop());
    assert.ok(methods.includes('sendDocument'));
    assert.ok(methods.includes('sendMessage'));
    const documentCall=calls.find((call)=>call.url.endsWith('/sendDocument'));
    assert.match(String(documentCall.options.body),/telegram-cached-file/);
  });
  assert.ok(db.operations.some((op)=>op.query.includes('publication_reader_events')&&op.values.includes('download_open')));
  assert.ok(db.operations.some((op)=>op.query.includes('publication_reader_events')&&op.values.includes('delivery_success')));
  assert.equal(db.delivery?.status,'delivered');
});

test('automatic discussion forward posts download gate and does not expose release file',async()=>{
  const db=new MockDB();const execution=ctx();
  await withTelegramMock(async(calls)=>{
    const request=new Request(`${ORIGIN}/telegram/webhook`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:{message_id:55,chat:{id:-200,type:'supergroup'},is_automatic_forward:true,forward_origin:{type:'channel',message_id:123}}})});
    const response=await handlePublicationOpsWebhook(request,env(db),execution);
    assert.ok(response);assert.equal(response.status,200);
    const methods=calls.map((call)=>call.url.split('/').pop());
    assert.ok(methods.includes('sendMessage'));
    assert.equal(methods.includes('sendDocument'),false);
    const gate=calls.find((call)=>call.url.endsWith('/sendMessage'));
    const body=JSON.parse(String(gate.options.body));
    assert.match(body.text,/Скачать файлы релиза можно через/);
    assert.match(JSON.stringify(body.reply_markup),/Скачать/);
  });
  assert.ok(db.operations.some((op)=>op.query.startsWith('UPDATE publications SET discussion_message_id=')));
});

test('thank-you callback is answered and stored uniquely',async()=>{
  const db=new MockDB();const execution=ctx();
  await withTelegramMock(async(calls)=>{
    const request=new Request(`${ORIGIN}/telegram/webhook`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({callback_query:{id:'cb-1',from:{id:4242,first_name:'Reader'},data:'thanks:7',message:{message_id:9,chat:{id:4242,type:'private'}}}})});
    const response=await handlePublicationOpsWebhook(request,env(db),execution);
    assert.ok(response);assert.equal(response.status,200);
    await Promise.all(execution.promises);
    assert.ok(calls.some((call)=>call.url.endsWith('/answerCallbackQuery')));
  });
  assert.ok(db.operations.some((op)=>op.query.startsWith('INSERT OR IGNORE INTO publication_thanks')));
  assert.ok(db.operations.some((op)=>op.query.includes('publication_reader_events')&&op.values.includes('thank_you_click')));
});
