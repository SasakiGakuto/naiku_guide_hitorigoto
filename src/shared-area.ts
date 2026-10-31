import {config,sharedAreaSequence,spots} from './data';

export type SharedPoint={lat:number;lon:number};
export type SharedPresence={active:boolean;outsideCount:number;outsideSince?:number};
export type SharedPresenceUpdate=SharedPresence&{entered:boolean;exited:boolean};

export function distanceMeters(a:SharedPoint,b:SharedPoint){
 const R=6371000,p=Math.PI/180,x=(b.lat-a.lat)*p,y=(b.lon-a.lon)*p;
 return 2*R*Math.asin(Math.sqrt(Math.sin(x/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(y/2)**2));
}

export function isWithinSharedArea(point:SharedPoint,marginMeters=0){
 return sharedAreaSequence.some(step=>{
  const spot=spots.find(item=>item.id===step.spotId);
  if(!spot)return false;
  const radius=spot.id==='M01'?(config.individualRadii.M01??config.radiusMeters):config.sharedRadiusMeters;
  return distanceMeters(point,spot)<=radius+marginMeters;
 });
}

export function hasStableSharedEntry(samples:Array<SharedPoint&{at:number}>,required=config.gpsSamplesRequired,spanMs=5000){
 const hits=samples.filter(point=>isWithinSharedArea(point));
 return hits.length>=required&&hits[hits.length-1].at-hits[0].at>=spanMs;
}

export function updateSharedPresence(state:SharedPresence,point:SharedPoint,now:number,validFix:boolean,stableInside:boolean,required=config.gpsSamplesRequired,spanMs=5000):SharedPresenceUpdate{
 if(!state.active&&stableInside)return{active:true,outsideCount:0,outsideSince:undefined,entered:true,exited:false};
 if(!state.active||!validFix)return{...state,entered:false,exited:false};
 if(isWithinSharedArea(point,15))return{active:true,outsideCount:0,outsideSince:undefined,entered:false,exited:false};
 const expired=state.outsideSince!=null&&now-state.outsideSince>config.gpsMaxAgeMs;
 const outsideCount=expired?1:state.outsideCount+1,outsideSince=expired?now:state.outsideSince??now;
 if(outsideCount>=required&&now-outsideSince>=spanMs)return{active:false,outsideCount:0,outsideSince:undefined,entered:false,exited:true};
 return{active:true,outsideCount,outsideSince,entered:false,exited:false};
}

export function nextUnvisitedSharedSpot(afterIndex:number,visited:string[]){
 return sharedAreaSequence.slice(afterIndex+1).find(step=>!visited.includes(step.spotId))?.spotId;
}

export function isSharedSequencePending(started:boolean,nextSpotId:string|undefined){return started&&Boolean(nextSpotId)}

export function isSharedStepDue(active:boolean,status:string,detailOpen:boolean,spotId:string|undefined,lastShownAt:number|undefined,now:number){
 if(!active||status!=='guiding'||detailOpen||!spotId)return false;
 const step=sharedAreaSequence.find(item=>item.spotId===spotId);
 return Boolean(step&&(!lastShownAt||now-lastShownAt>=step.delayMs));
}
