import test from 'node:test';
import assert from 'node:assert/strict';
import {answerAiQuestion,type AiQuestionRow,type AiQuestionStore} from '../server/ai-question-service';
import {GeminiRequestError,generateKurooniAnswer,type AiConversationTurn,type GeminiAnswer,kurooniSystemInstruction} from '../server/kurooni-character';

const visitorId='11111111-1111-4111-8111-111111111111',sessionId='22222222-2222-4222-8222-222222222222';
const input=(questionId:string,question='黒木の鳥居について教えて')=>({visitor_id:visitorId,session_id:sessionId,question_id:questionId,question_text:question,history:[{role:'user',text:'鬼って本当にいたの？'},{role:'model',text:'昔話ではいろんな鬼が伝えられているんだよ。'}]});
class MemoryStore implements AiQuestionStore{
  rows=new Map<string,AiQuestionRow>();
  limits=new Map<string,number[]>();
  async findQuestion(id:string){return this.rows.get(id)}
  async insertQuestion(row:AiQuestionRow){if(this.rows.has(row.question_id))throw new Error('duplicate');this.rows.set(row.question_id,{...row})}
  async updateQuestion(id:string,update:Partial<AiQuestionRow>){const row=this.rows.get(id);if(row)this.rows.set(id,{...row,...update})}
  async listQuestions(){return[...this.rows.values()]}
  async checkRateLimit(scopeKey:string,now:number,windowMs:number,maxRequests:number){const current=(this.limits.get(scopeKey)??[]).filter(at=>now-at<windowMs);if(current.length>=maxRequests){this.limits.set(scopeKey,current);return false}current.push(now);this.limits.set(scopeKey,current);return true}
}
const generated:GeminiAnswer={text:'黒木の鳥居は木の皮を残した形で、自然の姿を感じられるんだよ。',modelName:'gemini-test',inputTokens:22,outputTokens:18};

test('system instruction preserves Kurooni voice and factual care',()=>{
  assert.match(kurooniSystemInstruction,/一人称は「ぼく」/);
  assert.match(kurooniSystemInstruction,/事実と伝承を区別/);
  assert.match(kurooniSystemInstruction,/外部検索やGroundingを使わない/);
});

test('Gemini request keeps its key server-side and limits context to recent turns',async()=>{
  let requestUrl='',requestInit:RequestInit|undefined;
  const response=await generateKurooniAnswer('質問だよ',Array.from({length:10},(_,index)=>({role:index%2?'model':'user',text:`turn-${index}`} as AiConversationTurn)),{
    apiKey:'test-only-key',model:'gemini-test',fetcher:async(url,init)=>{requestUrl=String(url);requestInit=init;return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'回答だよ'}]}}],usageMetadata:{promptTokenCount:19,candidatesTokenCount:8}}),{status:200,headers:{'content-type':'application/json'}})}
  });
  assert.match(requestUrl,/models\/gemini-test:generateContent$/);
  assert.equal(new Headers(requestInit?.headers).get('x-goog-api-key'),'test-only-key');
  const payload=JSON.parse(String(requestInit?.body));assert.equal(payload.contents.length,9);assert.equal(payload.contents[0].parts[0].text,'turn-2');assert.equal(payload.contents.at(-1).parts[0].text,'質問だよ');
  assert.equal(payload.tools,undefined);assert.equal(response.text,'回答だよ');assert.equal(response.inputTokens,19);assert.equal(response.outputTokens,8);
});

test('rejects empty and overlong questions before logging',async()=>{
  const store=new MemoryStore();
  const empty=await answerAiQuestion(input('33333333-3333-4333-8333-333333333333','   '),store);
  const long=await answerAiQuestion(input('44444444-4444-4444-8444-444444444444','あ'.repeat(2001)),store);
  assert.equal(empty.status,400);assert.equal(long.status,400);assert.equal(store.rows.size,0);
});

test('logs the question and answer once and returns a duplicate safely',async()=>{
  const store=new MemoryStore();let calls=0,receivedHistory:AiConversationTurn[]=[];
  const generate=async(_question:string,history:AiConversationTurn[])=>{calls++;receivedHistory=history;return generated};
  const body=input('55555555-5555-4555-8555-555555555555');
  const first=await answerAiQuestion(body,store,'192.0.2.1',generate),again=await answerAiQuestion(body,store,'192.0.2.1',generate);
  const row=store.rows.get(body.question_id)!;
  assert.equal(first.status,200);assert.equal(again.status,200);assert.equal(calls,1);
  assert.equal(row.visitor_id,visitorId);assert.equal(row.session_id,sessionId);assert.equal(row.question_text,body.question_text);
  assert.equal(row.answer_text,generated.text);assert.equal(row.model_name,generated.modelName);assert.equal(row.input_tokens,22);assert.equal(row.output_tokens,18);assert.equal(row.response_status,'answered');
  assert.deepEqual(receivedHistory,[{role:'user',text:'鬼って本当にいたの？'},{role:'model',text:'昔話ではいろんな鬼が伝えられているんだよ。'}]);
});

test('records quota failures and applies short-window server limits',async()=>{
  const store=new MemoryStore(),quotaId='66666666-6666-4666-8666-666666666666';
  const quota=await answerAiQuestion(input(quotaId),store,'192.0.2.2',async()=>{throw new GeminiRequestError('quota_exceeded')});
  assert.equal(quota.status,429);assert.equal(store.rows.get(quotaId)?.response_status,'quota_exceeded');
  const limitedStore=new MemoryStore();limitedStore.checkRateLimit=async()=>false;
  const requestId='77777777-7777-4777-8777-777777777777',limited=await answerAiQuestion(input(requestId),limitedStore,'192.0.2.3',async()=>generated);
  assert.equal(limited.status,429);assert.equal(limitedStore.rows.get(requestId)?.response_status,'rate_limited');
});
