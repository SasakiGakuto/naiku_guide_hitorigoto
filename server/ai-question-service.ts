import {createHash} from 'node:crypto';
import {GeminiRequestError,generateKurooniAnswer,type AiConversationTurn} from './kurooni-character';

export type AiQuestionRow={
  question_id:string;visitor_id:string;session_id:string;question_text:string;asked_at:string;
  answer_text:string|null;answered_at:string|null;model_name:string|null;input_tokens:number|null;output_tokens:number|null;
  response_status:string;response_time_ms:number|null;
};
export interface AiQuestionStore {
  findQuestion(questionId:string):Promise<AiQuestionRow|undefined>;
  insertQuestion(row:AiQuestionRow):Promise<void>;
  updateQuestion(questionId:string,update:Partial<AiQuestionRow>):Promise<void>;
  listQuestions():Promise<AiQuestionRow[]>;
  checkRateLimit(scopeKey:string,now:number,windowMs:number,maxRequests:number):Promise<boolean>;
}
export type AiQuestionResponse={status:number;body:Record<string,unknown>};

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const messageForStatus=(status:string)=>status==='quota_exceeded'||status==='rate_limited'
  ?'ごめんね。今はちょっとお話しできないみたいなんだ。少し時間を置いて、また聞いてみてね'
  :'ごめんね。今はうまく答えられないみたいなんだ。少し時間を置いて、もう一度聞いてみてね';

export async function answerAiQuestion(body:unknown,store:AiQuestionStore,clientAddress='unknown',generate=generateKurooniAnswer):Promise<AiQuestionResponse>{
  if(!body||typeof body!=='object')return{status:400,body:{error:'invalid_request'}};
  const input=body as Record<string,unknown>,visitorId=input.visitor_id,sessionId=input.session_id,questionId=input.question_id,question=typeof input.question_text==='string'?input.question_text.trim():'';
  if(typeof visitorId!=='string'||!uuidPattern.test(visitorId)||typeof sessionId!=='string'||!uuidPattern.test(sessionId)||typeof questionId!=='string'||!uuidPattern.test(questionId))return{status:400,body:{error:'invalid_request'}};
  if(!question||question.length>2000)return{status:400,body:{error:'invalid_question',message:question?'質問は2,000文字以内で入力してね。':'質問を入力してね。'}};
  const rawHistory=Array.isArray(input.history)?input.history:[];
  const history:AiConversationTurn[]=rawHistory.slice(-20).flatMap((turn):AiConversationTurn[]=>{
    if(!turn||typeof turn!=='object')return[];
    const item=turn as Record<string,unknown>;
    if((item.role!=='user'&&item.role!=='model')||typeof item.text!=='string')return[];
    const text=item.text.trim().slice(0,2000);return text?[{role:item.role,text}]:[];
  });
  const existing=await store.findQuestion(questionId);
  if(existing){
    if(existing.visitor_id!==visitorId||existing.session_id!==sessionId||existing.question_text!==question)return{status:409,body:{error:'question_id_conflict'}};
    if(existing.answer_text&&existing.response_status==='answered')return{status:200,body:{question_id:questionId,answer:existing.answer_text,model:existing.model_name,input_tokens:existing.input_tokens,output_tokens:existing.output_tokens}};
    return{status:409,body:{error:'question_already_received',message:messageForStatus(existing.response_status)}};
  }

  const now=new Date().toISOString(),modelName=(process.env.GEMINI_MODEL||'gemini-3.5-flash-lite').trim(),row:AiQuestionRow={question_id:questionId,visitor_id:visitorId,session_id:sessionId,question_text:question,asked_at:now,answer_text:null,answered_at:null,model_name:modelName,input_tokens:null,output_tokens:null,response_status:'pending',response_time_ms:null};
  await store.insertQuestion(row);
  const limitAt=Date.now(),visitorScope='visitor:'+createHash('sha256').update(visitorId).digest('hex'),addressScope='address:'+createHash('sha256').update(clientAddress||'unknown').digest('hex');
  const withinVisitorLimit=await store.checkRateLimit(visitorScope,limitAt,60_000,8),withinAddressLimit=withinVisitorLimit&&await store.checkRateLimit(addressScope,limitAt,60_000,30);
  if(!withinAddressLimit){
    await store.updateQuestion(questionId,{response_status:'rate_limited',response_time_ms:0});
    return{status:429,body:{error:'rate_limited',message:messageForStatus('rate_limited')}};
  }
  const started=Date.now();
  try{
    const answer=await generate(question,history);
    const answeredAt=new Date().toISOString();
    await store.updateQuestion(questionId,{answer_text:answer.text,answered_at:answeredAt,model_name:answer.modelName,input_tokens:answer.inputTokens,output_tokens:answer.outputTokens,response_status:'answered',response_time_ms:Date.now()-started});
    return{status:200,body:{question_id:questionId,answer:answer.text,model:answer.modelName,input_tokens:answer.inputTokens,output_tokens:answer.outputTokens}};
  }catch(error){
    const status=error instanceof GeminiRequestError?error.responseStatus:'api_error';
    await store.updateQuestion(questionId,{response_status:status,response_time_ms:Date.now()-started});
    const httpStatus=status==='quota_exceeded'?429:status==='missing_api_key'?503:status==='invalid_api_key'?502:status==='timeout'?504:502;
    return{status:httpStatus,body:{error:status,message:messageForStatus(status)}};
  }
}

export async function getAiQuestionStatus(query:Record<string,unknown>,store:AiQuestionStore):Promise<AiQuestionResponse>{
  const {visitor_id:visitorId,session_id:sessionId,question_id:questionId}=query;
  if(typeof visitorId!=='string'||!uuidPattern.test(visitorId)||typeof sessionId!=='string'||!uuidPattern.test(sessionId)||typeof questionId!=='string'||!uuidPattern.test(questionId))return{status:400,body:{error:'invalid_request'}};
  const row=await store.findQuestion(questionId);
  if(!row||row.visitor_id!==visitorId||row.session_id!==sessionId)return{status:404,body:{error:'not_found'}};
  if(row.response_status==='pending')return{status:202,body:{status:'pending'}};
  if(row.response_status==='answered'&&row.answer_text)return{status:200,body:{status:'answered',answer:row.answer_text}};
  return{status:200,body:{status:'failed',error:row.response_status,message:messageForStatus(row.response_status)}};
}
