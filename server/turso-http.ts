import type {AiQuestionRow,AiQuestionStore} from './ai-question-service';

type LibsqlValue={type:'null'|'integer'|'float'|'text'|'blob';value?:string};
type LibsqlCell={type:string;value?:string};
type LibsqlStatementResult={rows?:LibsqlCell[][];affected_row_count?:number};

const encodeValue=(value:unknown):LibsqlValue=>{
  if(value==null)return{type:'null'};
  if(typeof value==='number')return Number.isInteger(value)?{type:'integer',value:String(value)}:{type:'float',value:String(value)};
  if(typeof value==='boolean')return{type:'integer',value:value?'1':'0'};
  return{type:'text',value:String(value)};
};
const decodeValue=(cell:LibsqlCell|undefined):unknown=>{
  if(!cell||cell.type==='null')return null;
  if(cell.type==='integer')return Number(cell.value);
  if(cell.type==='float')return Number(cell.value);
  return cell.value??'';
};

/** Minimal Hrana HTTP v2 client so Vercel Functions can use a persistent SQLite-compatible database. */
export class TursoHttpStore implements AiQuestionStore {
  private readonly endpoint:string;
  constructor(databaseUrl:string,private readonly authToken:string){
    this.endpoint=databaseUrl.trim().replace(/^libsql:/,'https:').replace(/\/$/,'')+'/v2/pipeline';
    if(!this.endpoint.startsWith('https://'))throw new Error('TURSO_DATABASE_URL must be HTTPS or libsql');
  }
  async execute(sql:string,args:unknown[]=[]):Promise<LibsqlStatementResult>{
    const response=await fetch(this.endpoint,{method:'POST',headers:{authorization:`Bearer ${this.authToken}`,'content-type':'application/json'},body:JSON.stringify({baton:null,requests:[{type:'execute',stmt:{sql,args:args.map(encodeValue),want_rows:true}}]})});
    if(!response.ok)throw new Error('Persistent database request failed');
    const payload=await response.json() as {results?:Array<{type:string;response?:{type:string;result?:LibsqlStatementResult};error?:{message?:string}}>};
    const result=payload.results?.[0];
    if(result?.type!=='ok'||!result.response?.result)throw new Error('Persistent database query failed');
    return result.response.result;
  }
  private async ensureTable(){
    await this.execute('CREATE TABLE IF NOT EXISTS ai_questions(question_id TEXT PRIMARY KEY,visitor_id TEXT NOT NULL,session_id TEXT NOT NULL,question_text TEXT NOT NULL,asked_at TEXT NOT NULL,answer_text TEXT,answered_at TEXT,model_name TEXT,input_tokens INTEGER,output_tokens INTEGER,response_status TEXT NOT NULL,response_time_ms INTEGER)');
    await this.execute('CREATE INDEX IF NOT EXISTS idx_ai_questions_session ON ai_questions(visitor_id,session_id,asked_at)');
    await this.execute('CREATE TABLE IF NOT EXISTS ai_question_rate_limits(scope_key TEXT NOT NULL,requested_at INTEGER NOT NULL)');
    await this.execute('CREATE INDEX IF NOT EXISTS idx_ai_question_rate_limits_scope_time ON ai_question_rate_limits(scope_key,requested_at)');
  }
  private ready?:Promise<void>;
  private async readyTable(){this.ready??=this.ensureTable();await this.ready}
  private row(result:LibsqlStatementResult):AiQuestionRow|undefined{
    const values=result.rows?.[0];if(!values)return;
    const keys: Array<keyof AiQuestionRow>=['question_id','visitor_id','session_id','question_text','asked_at','answer_text','answered_at','model_name','input_tokens','output_tokens','response_status','response_time_ms'];
    return Object.fromEntries(keys.map((key,index)=>[key,decodeValue(values[index])])) as AiQuestionRow;
  }
  async findQuestion(questionId:string){await this.readyTable();return this.row(await this.execute('SELECT question_id,visitor_id,session_id,question_text,asked_at,answer_text,answered_at,model_name,input_tokens,output_tokens,response_status,response_time_ms FROM ai_questions WHERE question_id=?',[questionId]))}
  async insertQuestion(row:AiQuestionRow){await this.readyTable();await this.execute('INSERT INTO ai_questions(question_id,visitor_id,session_id,question_text,asked_at,answer_text,answered_at,model_name,input_tokens,output_tokens,response_status,response_time_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[row.question_id,row.visitor_id,row.session_id,row.question_text,row.asked_at,row.answer_text,row.answered_at,row.model_name,row.input_tokens,row.output_tokens,row.response_status,row.response_time_ms])}
  async updateQuestion(questionId:string,update:Partial<AiQuestionRow>){await this.readyTable();const keys=Object.keys(update).filter(key=>key!=='question_id') as Array<keyof AiQuestionRow>;if(!keys.length)return;await this.execute(`UPDATE ai_questions SET ${keys.map(key=>`${key}=?`).join(',')} WHERE question_id=?`,[...keys.map(key=>update[key]),questionId])}
  async listQuestions(){await this.readyTable();const result=await this.execute('SELECT question_id,visitor_id,session_id,question_text,asked_at,answer_text,answered_at,model_name,input_tokens,output_tokens,response_status,response_time_ms FROM ai_questions ORDER BY asked_at,question_id');const keys:Array<keyof AiQuestionRow>=['question_id','visitor_id','session_id','question_text','asked_at','answer_text','answered_at','model_name','input_tokens','output_tokens','response_status','response_time_ms'];return(result.rows??[]).map(values=>Object.fromEntries(keys.map((key,index)=>[key,decodeValue(values[index])])) as AiQuestionRow)}
  async checkRateLimit(scopeKey:string,now:number,windowMs:number,maxRequests:number){
    await this.readyTable();const cutoff=now-windowMs;
    await this.execute('DELETE FROM ai_question_rate_limits WHERE requested_at<?',[cutoff]);
    const result=await this.execute('INSERT INTO ai_question_rate_limits(scope_key,requested_at) SELECT ?,? WHERE (SELECT COUNT(*) FROM ai_question_rate_limits WHERE scope_key=? AND requested_at>=?) < ?',[scopeKey,now,scopeKey,cutoff,maxRequests]);
    return(result.affected_row_count??0)>0;
  }
}

export const createTursoQuestionStore=()=>{
  const url=process.env.TURSO_DATABASE_URL,token=process.env.TURSO_AUTH_TOKEN;
  if(!url||!token)throw new Error('Persistent database configuration is missing');
  return new TursoHttpStore(url,token);
};
