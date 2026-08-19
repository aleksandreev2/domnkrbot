import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeChannelPublication,
  handlePublicationCommentGateWebhook,
} from '../dist-runtime/publication-comment-gate.js';

const ORIGIN='https://domnkr.test';

class MockStatement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    if(this.query.includes('SELECT value FROM app_settings')){
      if(this.values[0]==='publish_channel_id')return{value:'@domnekromanta'};
      return null;
    }
    if(this.query.includes('FROM publications WHERE channel_message_id=?')){
      return Number(this.values[0])===this.db.publication.channel_message_id?{...this.db.publication}:null;
    }
    if(this.query.includes('FROM publications WHERE id=?')){
      return Number(this.values[0])===this.db.publication.id?{...this.db.publication}:null;
    }
    if(this.query.includes('FROM publication_comment_gates WHERE publication_id=?')){
      return this.db.gate?{...this.db.gate}:null;
    }
    return null;
  }
  async all(){
    if(this.query.includes('FROM publication_assets WHERE publication_id=?'))return{results:this.db.assets.map((row)=>({...row}))};
    return{results:[]};
  }
  async run(){
    this.db.operations.push({query:this.query,values:[...this.values]});
    if(this.query.startsWith('UPDATE publications SET discussion_message_id=')){
      this.db.publication.discussion_message_id=Number(this.values[0]);
    }
    if(this.query.startsWith('INSERT INTO publication_comment_gates')){
      this.db.gate={publication_id:Number(this.values[0]),discussion_message_id:Number(this.values[1]),gate_message_id:null,status:'pending',attempts:(this.db.gate?.attempts||0)+1,last_error:null};
    }
    if(this.query.startsWith('UPDATE publication_comment_gates SET gate_message_id=')){
      this.db.gate={...(this.db.gate||{}),publication_id:this.db.publication.id,gate_message_id:Number(this.values[0]),status:'sent',last_error:null};
    }
    return{};
  }
}
class MockDB{
  constructor(){
    this.publication={id:7,status:'published',internal_title:'Релиз · глава 10',body_html:'Новая глава готова.',add_footer:1,add_bot_comment:1,image_key:null,image_mime:null,image_name:null,channel_message_id:123,discussion_message_id:null};
    this.assets=[{id:11,file_name:'chapter.epub'}];
    this.gate=null;this.operations=[];
  }
  prepare(query){return new MockStatement(this,query);}
}
function env(db){return{DB:db,TELEGRAM_BOT_TOKEN:'123:test',BOT_USERNAME:'domnekromanta_bot',TELEGRAM_WEBHOOK_SECRET:'secret'};}
function ctx(){const promises=[];return{promises,waitUntil(promise){promises.push(promise);}};}

async function withTelegramMock(fn){
  const original=globalThis.fetch;const calls=[];let messageId=900;
  globalThis.fetch=async(url,options={})=>{
    const method=String(url).split('/').pop();
    let parsed=null;
    if(typeof options.body==='string'){try{parsed=JSON.parse(options.body);}catch{}}
    calls.push({url:String(url),method,options,body:parsed});
    if(method==='getChat')return new Response(JSON.stringify({ok:true,result:{id:-100,title:'Дом Некроманта',type:'channel',linked_chat_id:-200}}),{status:200,headers:{'content-type':'application/json'}});
    if(method==='sendMessage')return new Response(JSON.stringify({ok:true,result:{message_id:++messageId,chat:{id:parsed?.chat_id??-200,type:'supergroup'}}}),{status:200,headers:{'content-type':'application/json'}});
    if(method==='answerCallbackQuery')return new Response(JSON.stringify({ok:true,result:true}),{status:200,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify({ok:true,result:true}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{return await fn(calls);}finally{globalThis.fetch=original;}
}

function webhook(body,secret='secret'){
  return new Request(`${ORIGIN}/telegram/webhook`,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify(body)});
}

test('channel publication stays clean: no download/support CTA is embedded in post',()=>{
  const text=composeChannelPublication({body_html:'Новая глава готова.',add_footer:1},'domnekromanta_bot');
  assert.match(text,/Новая глава готова/);
  assert.match(text,/Дом Некроманта/);
  assert.doesNotMatch(text,/Скачать/);
  assert.doesNotMatch(text,/Поддержать переводчика/);
  assert.doesNotMatch(text,/Запустить/);
});

test('automatic channel forward creates exactly one reply gate and never publishes documents',async()=>{
  const db=new MockDB();
  await withTelegramMock(async(calls)=>{
    for(let attempt=0;attempt<2;attempt+=1){
      const execution=ctx();
      const response=await handlePublicationCommentGateWebhook(webhook({message:{message_id:55,chat:{id:-200,type:'supergroup'},is_automatic_forward:true,forward_origin:{type:'channel',message_id:123}}}),env(db),execution);
      assert.ok(response);assert.equal(response.status,200);
      await Promise.all(execution.promises);
    }
    const gateCalls=calls.filter((call)=>call.method==='sendMessage');
    assert.equal(gateCalls.length,1);
    assert.equal(calls.some((call)=>call.method==='sendDocument'),false);
    const payload=gateCalls[0].body;
    assert.equal(payload.reply_parameters.message_id,55);
    assert.match(payload.text,/Файлы релиза выдаёт @domnekromanta_bot/);
    assert.match(JSON.stringify(payload.reply_markup),/gate-download:7/);
    assert.match(JSON.stringify(payload.reply_markup),/Поддержать переводчика/);
  });
  assert.equal(db.gate?.status,'sent');
  assert.equal(db.gate?.discussion_message_id,55);
  assert.equal(db.publication.discussion_message_id,55);
});

test('download gate callback redirects into private bot deep-link and records click',async()=>{
  const db=new MockDB();db.gate={publication_id:7,discussion_message_id:55,gate_message_id:901,status:'sent',attempts:1,last_error:null};
  await withTelegramMock(async(calls)=>{
    const execution=ctx();
    const response=await handlePublicationCommentGateWebhook(webhook({callback_query:{id:'cb-7',from:{id:4242,first_name:'Reader'},data:'gate-download:7',message:{message_id:901,chat:{id:-200,type:'supergroup'}}}}),env(db),execution);
    assert.ok(response);assert.equal(response.status,200);
    await Promise.all(execution.promises);
    const callback=calls.find((call)=>call.method==='answerCallbackQuery'&&call.body?.url);
    assert.ok(callback);
    assert.equal(callback.body.url,'https://t.me/domnekromanta_bot?start=dl_7');
    assert.equal(calls.some((call)=>call.method==='sendDocument'),false);
  });
  assert.ok(db.operations.some((op)=>op.query.includes('publication_reader_events')&&op.values.includes('download_gate_click')));
});

test('comment gate webhook rejects an invalid Telegram secret before side effects',async()=>{
  const db=new MockDB();
  const execution=ctx();
  const response=await handlePublicationCommentGateWebhook(webhook({message:{message_id:55,chat:{id:-200,type:'supergroup'},is_automatic_forward:true,forward_origin:{type:'channel',message_id:123}}},'wrong'),env(db),execution);
  assert.ok(response);assert.equal(response.status,403);assert.equal(db.operations.length,0);assert.equal(execution.promises.length,0);
});
