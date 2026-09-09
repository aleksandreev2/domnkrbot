import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  captureTitleProposalSubmission,
  notifyAdminsForCreatedTitleProposal,
} from '../dist-runtime/telegram-title-proposal-admin-alert.js';

class Statement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    if(this.query.includes('FROM chapter_proposals')&&this.query.includes('ORDER BY created_at DESC LIMIT 1'))return this.db.latest;
    return null;
  }
}
class DB{
  constructor(){this.latest={id:'old-id',title:'Старая заявка',source_url:'https://example.com/old',comment:'',source_kind:'external',ranobelib_book_ref:null,created_at:'2026-09-09 09:00:00'};}
  prepare(query){return new Statement(this,query);}
}
function request(){return new Request('https://bot.example/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'secret'},body:JSON.stringify({callback_query:{id:'submit',from:{id:42,first_name:'Reader',username:'reader42'},data:'prop:submit',message:{message_id:9,chat:{id:42,type:'private'}}}})});}

test('new title proposal sends a best-effort Telegram alert to configured admins',async()=>{
  const db=new DB();
  const env={DB:db,TELEGRAM_BOT_TOKEN:'token',ADMIN_TELEGRAM_IDS:'777, 888'};
  const context=await captureTitleProposalSubmission(request(),env);
  assert.ok(context);assert.equal(context.previousProposalId,'old-id');
  db.latest={id:'new-id',title:'Новая новелла',source_url:'https://example.com/novel',comment:'Очень хочу перевод',source_kind:'external',ranobelib_book_ref:null,created_at:'2026-09-09 10:00:00'};
  const original=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options={})=>{const method=String(url).split('/').pop();calls.push({method,payload:JSON.parse(String(options.body||'{}'))});return Response.json({ok:true,result:true});};
  try{
    const sent=await notifyAdminsForCreatedTitleProposal(env,context);
    assert.equal(sent,true);
    const notices=calls.filter((call)=>call.method==='sendMessage'&&[777,888].includes(call.payload.chat_id));
    assert.equal(notices.length,2);
    for(const notice of notices){
      assert.match(notice.payload.text,/новая заявка/i);
      assert.match(notice.payload.text,/Новая новелла/);
      assert.match(notice.payload.text,/Очень хочу перевод/);
      assert.match(notice.payload.text,/@reader42/);
      assert.ok(notice.payload.reply_markup?.inline_keyboard?.flat().some((button)=>button.callback_data==='prop:view:new-id'));
    }
  }finally{globalThis.fetch=original;}
});

test('duplicate/reused proposal does not alert admins',async()=>{
  const db=new DB();const env={DB:db,TELEGRAM_BOT_TOKEN:'token',ADMIN_TELEGRAM_IDS:'777'};
  const context=await captureTitleProposalSubmission(request(),env);assert.ok(context);
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls+=1;return Response.json({ok:true,result:true});};
  try{assert.equal(await notifyAdminsForCreatedTitleProposal(env,context),false);assert.equal(calls,0);}finally{globalThis.fetch=original;}
});

test('entry captures proposal state before legacy submit and alerts only after it returns',()=>{
  const entry=fs.readFileSync(new URL('../src/entry.ts',import.meta.url),'utf8');
  const capture=entry.indexOf('const proposalAlertContext = await captureTitleProposalSubmission');
  const submit=entry.indexOf('const proposalResponse = await handleTelegramTitleProposalWebhookRequest');
  const notify=entry.indexOf('await notifyAdminsForCreatedTitleProposal(env, proposalAlertContext)');
  assert.ok(capture>=0&&submit>capture&&notify>submit);
});
