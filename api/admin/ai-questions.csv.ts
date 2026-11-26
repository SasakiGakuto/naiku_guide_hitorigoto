import {timingSafeEqual} from 'node:crypto';
import {createTursoQuestionStore} from '../../server/turso-http';

const sameSecret=(provided:string,expected:string)=>{const a=Buffer.from(provided),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b)};
const csvCell=(value:unknown)=>{let text=String(value??'');if(/^[\s]*[=+\-@]/.test(text))text="'"+text;return`"${text.replaceAll('"','""')}"`};

export async function GET(request:Request):Promise<Response>{
  const token=process.env.ADMIN_TOKEN,provided=request.headers.get('authorization')?.replace(/^Bearer\s+/i,'');
  if(!token||!provided||!sameSecret(provided,token))return new Response('Not found',{status:404});
  try{
    const rows=await createTursoQuestionStore().listQuestions(),headers=['visitor_id','session_id','question_id','question_text','asked_at','answer_text','answered_at','model_name','input_tokens','output_tokens','response_status','response_time_ms'];
    const body='\uFEFF'+[headers,...rows.map(row=>headers.map(header=>row[header as keyof typeof row]))].map(values=>values.map(csvCell).join(',')).join('\r\n')+'\r\n';
    return new Response(body,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="ooe-ai-questions.csv"','cache-control':'no-store'}});
  }catch{return new Response('Database unavailable',{status:503})}
}
