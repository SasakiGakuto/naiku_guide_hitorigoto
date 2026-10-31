import assert from 'node:assert/strict';
import test from 'node:test';
import {sharedAreaSequence,spots} from './data';
import {hasStableSharedEntry,isSharedSequencePending,isSharedStepDue,isWithinSharedArea,nextUnvisitedSharedSpot,updateSharedPresence,type SharedPresence} from './shared-area';

const point=(spotId:string)=>{const spot=spots.find(item=>item.id===spotId)!;return{lat:spot.lat,lon:spot.lon}};

test('the union accepts every naiku circle without bridging the gap with one large radius',()=>{
 for(const id of ['M01','M02','M03','M04'])assert.equal(isWithinSharedArea(point(id)),true,id+' should be inside');
 const a=point('M01'),b=point('M02');
 assert.equal(isWithinSharedArea({lat:(a.lat+b.lat)/2,lon:(a.lon+b.lon)/2}),false,'the space between distant circles is outside');
});

test('stable entry can begin from either the M01 or M02 circle',()=>{
 for(const id of ['M01','M02']){
  const p=point(id),samples=[{...p,at:1000},{...p,at:3500},{...p,at:6000}];
  assert.equal(hasStableSharedEntry(samples),true);
  const presence=updateSharedPresence({active:false,outsideCount:0},p,6000,true,true);
  assert.equal(presence.entered,true);
  assert.equal(nextUnvisitedSharedSpot(-1,[]),'M01','all GPS entry points start with M01');
 }
 assert.equal(hasStableSharedEntry([{...point('M01'),at:1000},{...point('M01'),at:3500}]),false,'two measurements are insufficient');
 assert.equal(hasStableSharedEntry([{...point('M01'),at:1000},{...point('M01'),at:3000},{...point('M01'),at:5500}]),false,'less than five seconds is insufficient');
});

test('exit requires stable outside measurements and hysteresis cancels GPS jitter',()=>{
 let state:SharedPresence={active:true,outsideCount:0};
 const far={lat:35.44,lon:135.17};
 state=updateSharedPresence(state,far,1000,true,false);
 assert.equal(state.active,true);
 state=updateSharedPresence(state,far,3500,true,false);
 assert.equal(state.active,true);
 state=updateSharedPresence(state,point('M02'),4500,true,false);
 assert.equal(state.active,true);
 assert.equal(state.outsideCount,0,'a fix within the exit margin resets the outside count');
 state=updateSharedPresence(state,far,5000,true,false);
 state=updateSharedPresence(state,far,7500,true,false);
 assert.equal(state.active,true,'exit requires three fixes spanning five seconds');
 const exit=updateSharedPresence(state,far,10000,true,false);
 assert.equal(exit.exited,true);
 assert.equal(exit.active,false);
});

test('outside fixes separated by a long GPS gap do not count as one stable exit streak',()=>{
 let state:SharedPresence={active:true,outsideCount:0};
 const far={lat:35.44,lon:135.17};
 state=updateSharedPresence(state,far,1000,true,false);
 state=updateSharedPresence(state,far,30000,true,false);
 assert.equal(state.outsideCount,1);
 assert.equal(state.outsideSince,30000);
 assert.equal(state.active,true);
});

test('the one-session sequence uses configured 5, 3 and 2 minute delays in order',()=>{
 assert.deepEqual(sharedAreaSequence.map(item=>item.spotId),['M01','M02','M03','M04']);
 assert.deepEqual(sharedAreaSequence.map(item=>item.delayMs),[0,300000,180000,120000]);
 const visited:string[]=[];
 let next=nextUnvisitedSharedSpot(-1,visited);assert.equal(next,'M01');visited.push(next!);
 let shownAt=10_000;next=nextUnvisitedSharedSpot(0,visited);assert.equal(next,'M02');
 assert.equal(isSharedStepDue(true,'guiding',false,next,shownAt,shownAt+299999),false);
 assert.equal(isSharedStepDue(true,'guiding',false,next,shownAt,shownAt+300000),true);
 visited.push(next!);shownAt+=300000;next=nextUnvisitedSharedSpot(1,visited);assert.equal(next,'M03');
 assert.equal(isSharedStepDue(true,'guiding',false,next,shownAt,shownAt+180000),true);
 visited.push(next!);shownAt+=180000;next=nextUnvisitedSharedSpot(2,visited);assert.equal(next,'M04');
 assert.equal(isSharedStepDue(true,'guiding',false,next,shownAt,shownAt+120000),true);
 visited.push(next!);assert.equal(nextUnvisitedSharedSpot(3,visited),undefined,'completed topics are never repeated');
});

test('paused, detail and return states hold one pending item until re-entry',()=>{
 const pending='M02',last=50_000,due=last+300_000;
 assert.equal(isSharedSequencePending(true,pending),true);
 assert.equal(isSharedStepDue(false,'guiding',false,pending,last,due),false,'outside the region, the step is paused');
 assert.equal(isSharedStepDue(true,'return_guidance',false,pending,last,due),false,'return guidance takes priority');
 assert.equal(isSharedStepDue(true,'guiding',true,pending,last,due),false,'detail view temporarily holds the step');
 assert.equal(isSharedStepDue(true,'guiding',false,pending,last,due),true,'on re-entry a due step resumes once');
 assert.equal(nextUnvisitedSharedSpot(0,['M01']),'M02','resume keeps the next unshown topic');
 assert.equal(isSharedSequencePending(true,undefined),false,'the sequence ends after M04');
});

test('manual selection skips already shown topics and continues after the selected spot',()=>{
 assert.equal(nextUnvisitedSharedSpot(1,['M01','M02']),'M03');
 assert.equal(nextUnvisitedSharedSpot(2,['M01','M02','M03']),'M04');
 assert.equal(nextUnvisitedSharedSpot(0,['M01','M02','M03']),'M04');
});
