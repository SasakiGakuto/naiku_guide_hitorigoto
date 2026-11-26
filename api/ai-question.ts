import {answerAiQuestion,getAiQuestionStatus} from '../server/ai-question-service';
import {createTursoQuestionStore} from '../server/turso-http';

export const config={maxDuration:60};

export async function GET(request:Request):Promise<Response>{
  const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
  try{
    const url=new URL(request.url),query={visitor_id:url.searchParams.get('visitor_id'),session_id:url.searchParams.get('session_id'),question_id:url.searchParams.get('question_id')},result=await getAiQuestionStatus(query,createTursoQuestionStore());
    return new Response(JSON.stringify(result.body),{status:result.status,headers});
  }catch{return new Response(JSON.stringify({error:'service_unavailable'}),{status:503,headers})}
}

export async function POST(request:Request):Promise<Response>{
  const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
  if(!request.headers.get('content-type')?.toLowerCase().includes('application/json'))return new Response(JSON.stringify({error:'invalid_content_type'}),{status:415,headers});
  try{
    const text=await request.text();if(text.length>64*1024)return new Response(JSON.stringify({error:'request_too_large'}),{status:413,headers});
    const body=JSON.parse(text) as unknown,store=createTursoQuestionStore(),address=request.headers.get('x-vercel-forwarded-for')??request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()??'unknown',result=await answerAiQuestion(body,store,address);
    return new Response(JSON.stringify(result.body),{status:result.status,headers});
  }catch{
    return new Response(JSON.stringify({error:'service_unavailable',message:'ごめんね。今はちょっとお話しできないみたいなんだ。少し時間を置いて、また聞いてみてね'}),{status:503,headers});
  }
}
