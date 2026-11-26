import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {answerAiQuestion,getAiQuestionStatus,type AiQuestionRow,type AiQuestionStore} from './ai-question-service';

const localEnvFile=path.resolve('.env');
if(existsSync(localEnvFile))for(const line of readFileSync(localEnvFile,'utf8').split(/\r?\n/)){const match=line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);if(match&&process.env[match[1]]===undefined)process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2')}

const app=express();
const port=Number(process.env.PORT||3001);
const dataDir=path.resolve(process.env.DATA_DIR||'data');
mkdirSync(dataDir,{recursive:true});
const db=new Database(path.join(dataDir,'ooe-navi.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS sessions(session_id TEXT PRIMARY KEY,route_id TEXT,train_time TEXT,train_direction TEXT,started_at TEXT,status TEXT DEFAULT 'guiding',finished_at TEXT);
CREATE TABLE IF NOT EXISTS event_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,event_type TEXT,timestamp TEXT,spot_id TEXT,topic_id TEXT,emotion TEXT,utterance_id TEXT,candidate_emotions TEXT,selection_weights TEXT,notification_played INTEGER,arrival_method TEXT,payload TEXT);
CREATE INDEX IF NOT EXISTS idx_events_session ON event_logs(session_id);
CREATE TABLE IF NOT EXISTS daily_utterances(id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,weight REAL NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS ai_questions(question_id TEXT PRIMARY KEY,visitor_id TEXT NOT NULL,session_id TEXT NOT NULL,question_text TEXT NOT NULL,asked_at TEXT NOT NULL,answer_text TEXT,answered_at TEXT,model_name TEXT,input_tokens INTEGER,output_tokens INTEGER,response_status TEXT NOT NULL,response_time_ms INTEGER);
CREATE INDEX IF NOT EXISTS idx_ai_questions_session ON ai_questions(visitor_id,session_id,asked_at);
CREATE TABLE IF NOT EXISTS ai_question_rate_limits(scope_key TEXT NOT NULL,requested_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ai_question_rate_limits_scope_time ON ai_question_rate_limits(scope_key,requested_at);
`);
for(const [table,column,definition] of [['sessions','train_direction','TEXT'],['sessions','visitor_id','TEXT'],['event_logs','visitor_id','TEXT']] as const){
  try{db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)}catch{}
}
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_visitor ON sessions(visitor_id); CREATE INDEX IF NOT EXISTS idx_events_visitor_session ON event_logs(visitor_id,session_id);');
try{db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_event_unique_utterance ON event_logs(session_id,event_type,utterance_id) WHERE utterance_id IS NOT NULL AND event_type IN ('utterance_shown','daily_utterance_shown','spot_utterance_shown','sulky_shown')")}catch(error){console.warn('イベント重複防止インデックスを作成できません:',error)}
try{db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_event_unique_discovery ON event_logs(session_id,spot_id) WHERE event_type='spot_discovered' AND spot_id IS NOT NULL")}catch(error){console.warn('スポット発見の重複防止インデックスを作成できません:',error)}
try{db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_event_unique_session_finish ON event_logs(session_id) WHERE event_type='session_finished'")}catch(error){console.warn('セッション終了イベントの重複防止インデックスを作成できません:',error)}
try{db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_event_unique_return_guidance ON event_logs(session_id) WHERE event_type='return_guidance_started'")}catch(error){console.warn('帰着案内イベントの重複防止インデックスを作成できません:',error)}
try{
  const seeds=JSON.parse(readFileSync(path.resolve('src/daily-utterances.json'),'utf8')) as Array<{id:string;text:string;category:string;enabled:boolean;weight:number}>;
  const put=db.prepare('INSERT OR IGNORE INTO daily_utterances(id,text,category,enabled,weight) VALUES(?,?,?,?,?)');
  db.transaction((items:typeof seeds)=>{for(const item of items)put.run(item.id,item.text,item.category,Number(item.enabled),item.weight)})(seeds);
}catch(error){console.warn('日常ひとりごとマスタを読み込めません:',error)}

app.use(cors());
app.use(express.json({limit:'64kb'}));
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const japanDate=(date:Date)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
app.get('/api/daily-utterances',(_q,r)=>r.json(db.prepare('SELECT id,text,category,enabled,weight FROM daily_utterances WHERE enabled=1 ORDER BY id').all().map((x:any)=>({...x,enabled:Boolean(x.enabled)}))));
app.get('/api/health',(_q,r)=>{const now=new Date();r.json({ok:true,server_time:now.toISOString(),tour_date:japanDate(now)})});

const aiQuestionStore:AiQuestionStore={
  findQuestion:async(questionId)=>db.prepare('SELECT * FROM ai_questions WHERE question_id=?').get(questionId) as AiQuestionRow|undefined,
  insertQuestion:async(row)=>{db.prepare('INSERT INTO ai_questions(question_id,visitor_id,session_id,question_text,asked_at,answer_text,answered_at,model_name,input_tokens,output_tokens,response_status,response_time_ms) VALUES(@question_id,@visitor_id,@session_id,@question_text,@asked_at,@answer_text,@answered_at,@model_name,@input_tokens,@output_tokens,@response_status,@response_time_ms)').run(row)},
  updateQuestion:async(questionId,update)=>{const fields=Object.keys(update).filter(key=>key!=='question_id');if(!fields.length)return;const set=fields.map(field=>`${field}=@${field}`).join(',');db.prepare(`UPDATE ai_questions SET ${set} WHERE question_id=@question_id`).run({...update,question_id:questionId})},
  listQuestions:async()=>db.prepare('SELECT * FROM ai_questions ORDER BY asked_at,question_id').all() as AiQuestionRow[],
  checkRateLimit:async(scopeKey,now,windowMs,maxRequests)=>db.transaction(()=>{db.prepare('DELETE FROM ai_question_rate_limits WHERE requested_at<?').run(now-windowMs);const count=(db.prepare('SELECT COUNT(*) AS count FROM ai_question_rate_limits WHERE scope_key=? AND requested_at>=?').get(scopeKey,now-windowMs) as {count:number}).count;if(count>=maxRequests)return false;db.prepare('INSERT INTO ai_question_rate_limits(scope_key,requested_at) VALUES(?,?)').run(scopeKey,now);return true})()
};
app.post('/api/ai-question',async(q,r)=>{try{const result=await answerAiQuestion(q.body,aiQuestionStore,q.ip);r.status(result.status).json(result.body)}catch{r.status(503).json({error:'storage_unavailable',message:'ごめんね。今はちょっとお話しできないみたいなんだ。少し時間を置いて、また聞いてみてね'})}});
app.get('/api/ai-question',async(q,r)=>{try{const result=await getAiQuestionStatus(q.query,aiQuestionStore);r.status(result.status).json(result.body)}catch{r.status(503).json({error:'storage_unavailable'})}});

app.post('/api/sessions',(q,r)=>{
  const x=q.body;
  if(!uuidPattern.test(x?.session_id||'')||!uuidPattern.test(x?.visitor_id||'')||!x?.route_id)return r.status(400).json({error:'valid visitor_id, session_id, and route_id are required'});
  db.prepare('INSERT OR IGNORE INTO sessions(session_id,route_id,train_time,train_direction,started_at,status,visitor_id) VALUES(?,?,?,?,?,?,?)').run(x.session_id,x.route_id,x.train_time,x.train_direction,x.started_at,'active',x.visitor_id);
  const existing=db.prepare('SELECT visitor_id FROM sessions WHERE session_id=?').get(x.session_id) as {visitor_id:string|null}|undefined;
  if(existing?.visitor_id&&existing.visitor_id!==x.visitor_id)return r.status(409).json({error:'session belongs to a different visitor'});
  if(!existing?.visitor_id)db.prepare('UPDATE sessions SET visitor_id=? WHERE session_id=? AND visitor_id IS NULL').run(x.visitor_id,x.session_id);
  r.json({ok:true});
});

app.post('/api/events',(q,r)=>{
  const x=q.body;
  if(!uuidPattern.test(x?.session_id||'')||!uuidPattern.test(x?.visitor_id||'')||!x?.event_type)return r.status(400).json({error:'valid visitor_id, session_id, and event_type are required'});
  const known=['session_started','utterance_shown','daily_utterance_shown','daily_utterance_deferred','detail_opened','external_link_click','sulky_shown','sulky_check','manual_location_changed','return_guidance_started','return_warning_shown','train_changed','station_returned','session_finished','gps_fix','gps_error','shared_area_entered','shared_area_exited','shared_area_utterance_due','exploration_area_enter','exploration_area_exit','exploration_start','spot_discovered','spot_utterance_shown','debug_manual'];
  if(!known.includes(x.event_type))return r.status(400).json({error:'unsupported event_type'});
  const owner=db.prepare('SELECT visitor_id FROM sessions WHERE session_id=?').get(x.session_id) as {visitor_id:string|null}|undefined;
  if(owner?.visitor_id&&owner.visitor_id!==x.visitor_id)return r.status(403).json({error:'visitor does not own this session'});
  if(owner&&!owner.visitor_id)db.prepare('UPDATE sessions SET visitor_id=? WHERE session_id=? AND visitor_id IS NULL').run(x.visitor_id,x.session_id);
  db.prepare(`INSERT OR IGNORE INTO event_logs(visitor_id,session_id,event_type,timestamp,spot_id,topic_id,emotion,utterance_id,candidate_emotions,selection_weights,notification_played,arrival_method,payload) VALUES(@visitor_id,@session_id,@event_type,@timestamp,@spot_id,@topic_id,@emotion,@utterance_id,@candidate_emotions,@selection_weights,@notification_played,@arrival_method,@payload)`).run({
    visitor_id:x.visitor_id,session_id:x.session_id,event_type:x.event_type,timestamp:x.timestamp||x.clicked_at||new Date().toISOString(),spot_id:x.spot_id||null,topic_id:x.topic_id||null,emotion:x.emotion||null,utterance_id:x.utterance_id||x.daily_utterance_id||null,candidate_emotions:JSON.stringify(x.candidate_emotions||[]),selection_weights:JSON.stringify(x.selection_weights||{}),notification_played:x.notification_played==null?null:Number(Boolean(x.notification_played)),arrival_method:x.arrival_method||null,payload:JSON.stringify(x)
  });
  if(x.event_type==='train_changed')db.prepare('UPDATE sessions SET train_time=?,train_direction=? WHERE session_id=? AND visitor_id=?').run(x.new_train||null,x.train_direction||null,x.session_id,x.visitor_id);
  if(x.event_type==='session_finished')db.prepare('UPDATE sessions SET status="ended",finished_at=? WHERE session_id=? AND visitor_id=?').run(x.finished_at||x.timestamp||new Date().toISOString(),x.session_id,x.visitor_id);
  r.json({ok:true});
});

app.get('/api/admin/events.csv',(q,r)=>{
  const token=process.env.ADMIN_TOKEN;
  if(!token||q.query.token!==token)return r.status(404).send('Not found');
  const rows=db.prepare('SELECT * FROM event_logs ORDER BY id').all() as Record<string,unknown>[];
  const headers=rows.length?Object.keys(rows[0]):['id','visitor_id','session_id','event_type','timestamp'];
  const cell=(v:unknown)=>`"${String(v??'').replaceAll('"','""')}"`;
  r.setHeader('Content-Type','text/csv; charset=utf-8');
  r.setHeader('Content-Disposition','attachment; filename="ooe-events.csv"');
  r.write('\uFEFF'+headers.map(cell).join(',')+'\r\n');
  for(const row of rows)r.write(headers.map(h=>cell(row[h])).join(',')+'\r\n');
  r.end();
});

app.get('/api/admin/ai-questions.csv',(q,r)=>{
  const token=process.env.ADMIN_TOKEN;
  if(!token||q.get('authorization')!==`Bearer ${token}`)return r.status(404).send('Not found');
  const rows=db.prepare('SELECT visitor_id,session_id,question_id,question_text,asked_at,answer_text,answered_at,model_name,input_tokens,output_tokens,response_status,response_time_ms FROM ai_questions ORDER BY asked_at,question_id').all() as Record<string,unknown>[];
  const headers=['visitor_id','session_id','question_id','question_text','asked_at','answer_text','answered_at','model_name','input_tokens','output_tokens','response_status','response_time_ms'];
  const cell=(value:unknown)=>`"${String(value??'').replaceAll('"','""')}"`;
  r.setHeader('Content-Type','text/csv; charset=utf-8');r.setHeader('Content-Disposition','attachment; filename="ooe-ai-questions.csv"');
  r.write('\uFEFF'+headers.map(cell).join(',')+'\r\n');for(const row of rows)r.write(headers.map(header=>cell(row[header])).join(',')+'\r\n');r.end();
});

const dist=path.resolve('dist');
if(existsSync(dist)){app.use(express.static(dist));app.get('*',(q,r)=>r.sendFile(path.join(dist,'index.html')))}
app.listen(port,'0.0.0.0',()=>console.log(`大江案内鬼くろおにくん API: http://localhost:${port}`));
