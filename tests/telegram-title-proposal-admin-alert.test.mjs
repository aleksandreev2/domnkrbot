import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTelegramTitleProposalWebhookRequest } from '../dist-runtime/telegram-title-proposals.js';

class Statement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    if(this.query.includes('FROM telegram_proposal_sessions'))return this.db.session;
    return null;
  }
  async all(){
    if(this.query.includes('FROM chapter_proposals')&&this.query.includes("status IN ('pending','approved','planned','in_progress')"))return{results:[]};
    return{results:[]};
  }
  async run(){this.db.runs.push({query:this.query,values:[...this.values]});return{meta:{changes:1}};}
}
class DB{
  constructor(){
    this.session={user_telegram_id:'42',chat_id:'42',step:'review',source_kind:'external',ranobelib_book_ref:null,title:'Новая новелла',original_title:'Original Novel',source_url:'https://example.com/novel',candidates_json:'[]',raw_file_id:null,raw_file_unique_id:null,raw_file_name:null,raw_file_size:null,raw_mime_type:null,comment:'Очень хочу перевод',updated_at:'2026-09-09 10:00:00'};
    this.runs=[];
  }
  prepare(query){return new Statement(this,query);}
}
function request(){return new Request('https://bot.example/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'secret'},body:JSON.stringify({callback_query:{id:'submit',from:{id:42,first_name:'Reader',username:'reader42'},data:'prop:submit',message:{message_id:9,chat:{id:42,type:'private'}}}})});}

test('new title proposal sends a best-effort Telegram alert to configured admins',async()=>{
  const env={DB:new DB(),TELEGRAM_BOT_TOKEN:'token',TELEGRAM_WEBHOOK_SECRET:'secret',ADMIN_TELEGRAM_IDS:'777, 888'};
  const original=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options={})=>{const method=String(url).split('/').pop();calls.push({method,payload:JSON.parse(String(options.body||'{}'))});return Response.json({ok:true,result:true});};
  try{
    const response=await handleTelegramTitleProposalWebhookRequest(request(),env);
    assert.equal(response?.status,200);
    const notices=calls.filter((call)=>call.method==='sendMessage'&&[777,888].includes(call.payload.chat_id));
    assert.equal(notices.length,2);
    for(const notice of notices){
      assert.match(notice.payload.text,/новая заявка/i);
      assert.match(notice.payload.text,/Новая новелла/);
      assert.match(notice.payload.text,/Очень хочу перевод/);
      assert.match(notice.payload.text,/@reader42/);
      assert.ok(notice.payload.reply_markup?.inline_keyboard?.flat().some((button)=>button.callback_data?.startsWith('prop:view:')));
    }
  }finally{globalThis.fetch=original;}
});
