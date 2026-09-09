import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  captureTitleProposalSubmission,
  notifyAdminsForCreatedTitleProposal,
  notifyAdminsForProposalId,
} from '../dist-runtime/telegram-title-proposal-admin-alert.js';

class Statement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    if(this.query.includes('FROM chapter_proposals')&&this.query.includes('ORDER BY created_at DESC'))return this.db.latest;
    if(this.query.includes('FROM chapter_proposals p')&&this.query.includes('WHERE p.id=?'))return this.db.byId.get(String(this.values[0]))||null;
    return null;
  }
}
class DB{
  constructor(){
    this.latest={id:'old-id',title:'Старая заявка',source_url:'https://example.com/old',comment:'',source_kind:'external',ranobelib_book_ref:null,created_at:'2026-09-09 09:00:00'};
    this.byId=new Map();
  }
  prepare(query){return new Statement(this,query);}
}
function request(){return new Request('https://bot.example/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'secret'},body:JSON.stringify({callback_query:{id:'submit',from:{id:42,first_name:'Reader',username:'reader42'},data:'prop:submit',message:{message_id:9,chat:{id:42,type:'private'}}}})});}
async function collectTelegram(fn){
  const original=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options={})=>{const method=String(url).split('/').pop();calls.push({method,payload:JSON.parse(String(options.body||'{}'))});return Response.json({ok:true,result:true});};
  try{return await fn(calls);}finally{globalThis.fetch=original;}
}

test('new Telegram title proposal sends a best-effort alert to configured admins',async()=>{
  const db=new DB();
  const env={DB:db,TELEGRAM_BOT_TOKEN:'token',ADMIN_TELEGRAM_IDS:'777, 888'};
  const context=await captureTitleProposalSubmission(request(),env);
  assert.ok(context);assert.equal(context.previousProposalId,'old-id');
  db.latest={id:'new-id',title:'Новая новелла',source_url:'https://example.com/novel',comment:'Очень хочу перевод',source_kind:'external',ranobelib_book_ref:null,created_at:'2026-09-09 10:00:00'};
  await collectTelegram(async(calls)=>{
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
  });
});

test('duplicate/reused Telegram proposal does not alert admins',async()=>{
  const db=new DB();const env={DB:db,TELEGRAM_BOT_TOKEN:'token',ADMIN_TELEGRAM_IDS:'777'};
  const context=await captureTitleProposalSubmission(request(),env);assert.ok(context);
  await collectTelegram(async(calls)=>{assert.equal(await notifyAdminsForCreatedTitleProposal(env,context),false);assert.equal(calls.length,0);});
});

test('web-created proposal can notify admins by the exact created proposal id',async()=>{
  const db=new DB();
  db.byId.set('web-new-id',{id:'web-new-id',user_telegram_id:'55',title:'Новелла с сайта',source_url:'https://example.com/web',comment:'Возьмите на перевод',source_kind:'legacy',ranobelib_book_ref:null,created_at:'2026-09-09 10:10:00',username:'webreader',first_name:'Web',last_name:'Reader'});
  const env={DB:db,TELEGRAM_BOT_TOKEN:'token',ADMIN_TELEGRAM_IDS:'777'};
  await collectTelegram(async(calls)=>{
    assert.equal(await notifyAdminsForProposalId(env,'web-new-id'),true);
    const notice=calls.find((call)=>call.method==='sendMessage'&&call.payload.chat_id===777);
    assert.ok(notice);assert.match(notice.payload.text,/Новелла с сайта/);assert.match(notice.payload.text,/@webreader/);
    assert.ok(notice.payload.reply_markup?.inline_keyboard?.flat().some((button)=>button.callback_data==='prop:view:web-new-id'));
  });
});

test('entry captures Telegram proposal state before submit and defers the best-effort admin alert',()=>{
  const entry=fs.readFileSync(new URL('../src/entry.ts',import.meta.url),'utf8');
  const capture=entry.indexOf('const proposalAlertContext = await captureTitleProposalSubmission');
  const submit=entry.indexOf('const proposalResponse = await handleTelegramTitleProposalWebhookRequest');
  const notify=entry.indexOf('const alert = notifyAdminsForCreatedTitleProposal(env, proposalAlertContext)',submit);
  const defer=entry.indexOf('if (ctx) ctx.waitUntil(alert)',notify);
  const fallback=entry.indexOf('else await alert',defer);
  assert.ok(capture>=0&&submit>capture&&notify>submit&&defer>notify&&fallback>defer);
});

test('live entry alerts after a successful web proposal response',()=>{
  const entry=fs.readFileSync(new URL('../src/live-entry-v2.ts',import.meta.url),'utf8');
  assert.match(entry,/url\.pathname === '\/api\/proposals'/);
  assert.match(entry,/response\.status === 201/);
  assert.match(entry,/ctx\.waitUntil\(notifyAdminsForProposalId/);
});
