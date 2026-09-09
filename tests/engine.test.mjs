import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from './build.mjs';
await build(['topics','gestures','video-frames','show','chat','requests','coin','hooks/use-poll','hooks/use-coin','engine','services']);
const {Podcast}=await import('../work/tests/engine.js');
const {GestureSchedule,gestureConfig,gestureNames}=await import('../work/tests/gestures.js');
const {parseLines,shotPrompt,shotDuration,isBeat,opening,runsOk,turnPlan,planPrompt,wordCount}=await import('../work/tests/show.js');
const tick=()=>new Promise(r=>setImmediate(r));
let seq=0;
const req=(text,over={})=>({id:`id-${++seq}`,reference:`ref-${seq}`,from:'deb',wallet:'wallet',text,amount:1,status:'queued',at:0,...over});
async function settle(h,until,rounds=24){for(let i=0;i<rounds&&!until();i++){for(const id of [...h.jobs.keys()]){if(h.engine.getSnapshot().slots.some(x=>x.id===id&&x.status==='rendering'))await h.finish(id);}const s=h.engine.getSnapshot();if(s.phase==='playing'&&s.current)h.engine.clipEnded(s.current.id);await tick();}}
function harness(extra={}){const jobs=new Map();const writes=[];const released=[];const engine=new Podcast({render:line=>new Promise((resolve,reject)=>jobs.set(line.id,{line,resolve,reject})),write:(recent,start,cue,topic,from)=>new Promise(resolve=>writes.push({recent,start,cue,topic,from,resolve})),release:url=>released.push(url),...extra});return {engine,jobs,writes,released,async finish(id){const j=jobs.get(id);j.resolve({...j.line,url:`blob:${id}`,rawUrl:`https://fal.media/${id}.mp4`,duration:8,renderMs:100});await tick();},reply(index,start){writes[index].resolve(Array.from({length:4},(_,i)=>({id:start+i,speaker:(start+i)%2===0?'host':'guest',text:'A perfectly ordinary spoken line for this shot.'})));return tick();}};}
test('startup waits for three ordered shots; renders at most two at once',async()=>{const h=harness();h.engine.start();h.engine.start();assert.equal(h.jobs.size,2);await h.finish(1);assert.equal(h.engine.getSnapshot().current,null);assert.equal(h.jobs.size,3);await h.finish(0);assert.equal(h.jobs.size,4);assert.equal(h.engine.getSnapshot().current,null);await h.finish(2);assert.equal(h.engine.getSnapshot().current.id,0);h.engine.clipEnded(0);assert.equal(h.engine.getSnapshot().current.id,1);h.engine.clipEnded(0);assert.equal(h.engine.getSnapshot().current.id,1);h.engine.dispose();});

void test('gestures recur on the playback timeline with a gap between performances', async () => {
 const h=harness({write:async(recent,start)=>Array.from({length:4},(_,i)=>({id:start+i,speaker:(start+i)%2===0?'host':'guest',text:'Of course.'}))});
 h.engine.start();
 let elapsed=0;
 const events=[];
 try {
  for(let i=0;i<90;i++) {
   for(const slot of h.engine.getSnapshot().slots) if(slot.status==='rendering') {
    const job=h.jobs.get(slot.id);
    job.resolve({...job.line,url:`blob:${slot.id}`,rawUrl:`https://fal.media/${slot.id}.mp4`,duration:shotDuration(job.line.text,job.line.gesture),renderMs:100});
   }
   await tick();
   const state=h.engine.getSnapshot();
   if(state.phase==='playing') {
    if(state.current.gesture) events.push({at:elapsed,...state.current});
    elapsed+=state.current.duration;
    h.engine.clipEnded(state.current.id);
   }
  }
  assert.ok(events.filter(e=>e.gesture==='tea').length>=3,'tea repeats during the show');
  assert.ok(events.filter(e=>e.gesture==='cigar').length>=3,'the cigar repeats during the show');
  const last=Object.fromEntries(gestureNames.map(name=>[name,0]));
  for(const [i,event] of events.entries()) {
   const interval=gestureConfig[event.gesture].interval;
   assert.ok(event.at-last[event.gesture]>=interval,`${event.gesture} must wait for its interval`);
   assert.equal(event.speaker,gestureConfig[event.gesture].speaker);
   if(i) assert.ok(event.at-events[i-1].at-events[i-1].duration>=12,'ordinary conversation separates gestures');
   last[event.gesture]=event.at;
  }
 } finally {h.engine.dispose();}
});

void test('decoded durations preserve gesture intervals and the full conversation gap', async () => {
 const h=harness({write:async(recent,start)=>Array.from({length:4},(_,i)=>({id:start+i,speaker:(start+i)%2===0?'host':'guest',text:'Of course.'}))});
 h.engine.start();
 let elapsed=0;
 const events=[];
 try {
  for(let i=0;i<90;i++) {
   for(const slot of h.engine.getSnapshot().slots) if(slot.status==='rendering') {
    const job=h.jobs.get(slot.id);
    job.resolve({...job.line,url:`blob:${slot.id}`,rawUrl:`https://fal.media/${slot.id}.mp4`,duration:shotDuration(job.line.text,job.line.gesture)+(job.line.gesture?3:0),renderMs:100});
   }
   await tick();
   const state=h.engine.getSnapshot();
   if(state.phase==='playing') {
    if(state.current.gesture) events.push({at:elapsed,...state.current});
    elapsed+=state.current.duration;
    h.engine.clipEnded(state.current.id);
   }
  }
  assert.ok(events.filter(e=>e.gesture==='tea').length>=3,'tea repeats during the show');
  assert.ok(events.filter(e=>e.gesture==='cigar').length>=3,'the cigar repeats during the show');
  const last=Object.fromEntries(gestureNames.map(name=>[name,0]));
  for(const [i,event] of events.entries()) {
   const interval=gestureConfig[event.gesture].interval;
   assert.ok(event.at-last[event.gesture]>=interval,`${event.gesture} must wait for its interval`);
   assert.equal(event.speaker,gestureConfig[event.gesture].speaker);
   if(i) assert.ok(event.at-events[i-1].at-events[i-1].duration>=12,'ordinary conversation separates gestures');
   last[event.gesture]=event.at;
  }
 } finally {h.engine.dispose();}
});

void test('pauses and held end frames do not advance or double count the gesture clock', async (t) => {
 const reservations=[];
 const reserve=GestureSchedule.prototype.reserve;
 t.mock.method(GestureSchedule.prototype,'reserve',function(speaker,shortLine,at,id){
  reservations.push(at);
  return reserve.call(this,speaker,shortLine,at,id);
 });
 const h=harness();
 try {
  h.engine.start();
  await h.finish(0);await h.finish(1);await h.finish(2);
  h.engine.pause();
  const count=reservations.length;
  const later=Date.now()+3_600_000;
  t.mock.method(Date,'now',()=>later);
  h.engine.retry();
  assert.equal(reservations.length,count,'wall time and retries while paused submit no new footage');
  h.engine.pause();
  h.engine.clipEnded(0);h.engine.clipEnded(1);h.engine.clipEnded(2);
  assert.equal(h.engine.getSnapshot().phase,'waiting');
  h.engine.clipEnded(2);
  const write=h.writes.at(-1);
  await h.reply(h.writes.length-1,write.start);
  await h.finish(3);
  const slot4=h.engine.getSnapshot().slots.find(s=>s.id===4);
  assert.equal(reservations.at(-1),24+8+shotDuration(slot4.text),
   'only three ended clips, the new current clip, and the remaining slot precede the new shot');
 } finally {h.engine.dispose();}
});

void test('retry keeps a reserved gesture and restart resets the performance schedule', async () => {
 const h=harness({write:async(recent,start)=>Array.from({length:4},(_,i)=>({id:start+i,speaker:(start+i)%2===0?'host':'guest',text:'Of course.'}))});
 try {
  h.engine.start();
  let action;
  for(let i=0;i<40&&!action;i++) {
   action=[...h.jobs.values()].find(j=>j.line.gesture);
   if(action) break;
   for(const slot of h.engine.getSnapshot().slots) if(slot.status==='rendering') {
    await h.finish(slot.id);
    action=[...h.jobs.values()].find(j=>j.line.gesture);
    if(action) break;
   }
   const current=h.engine.getSnapshot().current;
   if(current) h.engine.clipEnded(current.id);
   await tick();
  }
  assert.ok(action,'a gesture was scheduled');
  action.reject(Error('temporary render failure'));
  await tick();
  assert.equal(h.engine.getSnapshot().slots.find(s=>s.id===action.line.id).status,'failed');
  h.engine.retry();
  assert.equal(h.jobs.get(action.line.id).line.gesture,action.line.gesture);
  h.engine.stop();h.engine.start();
  assert.ok(h.engine.getSnapshot().slots.every(s=>s.gesture===undefined),'the opening has no overdue gestures');
 } finally {h.engine.dispose();}
});

void test('a due gesture keeps its short line when rendering falls behind playback', async () => {
 const h=harness({write:async(recent,start)=>Array.from({length:4},(_,i)=>({id:start+i,speaker:(start+i)%2===0?'host':'guest',text:'Of course.'}))});
 try {
  h.engine.start();
  for(let i=0;i<50&&!Array.from(h.jobs.values()).some(j=>j.line.gesture);i++) {
   const slot=h.engine.getSnapshot().slots.find(s=>s.status==='rendering');
   if(slot) await h.finish(slot.id);
   const current=h.engine.getSnapshot().current;
   if(current) h.engine.clipEnded(current.id);
   await tick();
  }
  assert.ok(Array.from(h.jobs.values()).some(j=>j.line.gesture),'a slow renderer cannot starve gestures');
 } finally {h.engine.dispose();}
});
test('stop rejects stale results and releases their downloaded media',async()=>{const h=harness();h.engine.start();h.engine.stop();await h.finish(0);assert.equal(h.engine.getSnapshot().phase,'stopped');assert.equal(h.engine.getSnapshot().current,null);assert.ok(h.released.includes('blob:0'));h.engine.dispose();});
test('a paid request preserves submitted turns and bridges from their last line',async()=>{const h=harness();h.engine.start();h.engine.request(req('haunted air fryer'));assert.equal(h.engine.getSnapshot().slots.length,2);assert.equal(h.writes[0].start,2);assert.equal(h.writes[0].cue,'haunted air fryer');assert.equal(h.writes[0].from,'deb');assert.equal(h.writes[0].recent.at(-1).speaker,'guest');h.engine.dispose();});
test('paid requests air in the order they were bought and never cancel each other',async()=>{const h=harness();h.engine.start();h.engine.request(req('haunted air fryer'));h.engine.request(req('the moon charges rent'));assert.equal(h.writes.length,1,'the second request waits for the first');await h.reply(0,2);const after=h.engine.getSnapshot().requests;assert.equal(after[0].status,'buffered');assert.equal(after[0].shot,2);assert.equal(after[1].status,'queued');await settle(h,()=>h.writes.length>=2);assert.equal(h.writes[1].cue,'the moon charges rent');assert.equal(h.writes[1].topic,undefined);h.engine.dispose();});
test('a paid request is never lost across a restart and pulls dedupe by reference',async()=>{let aired=[];const h=harness({requests:{pull:async()=>[req('from the site',{reference:'same'}),req('again',{reference:'same'})],aired:async(ref)=>{aired.push(ref);}}});h.engine.start();await tick();assert.equal(h.engine.getSnapshot().requests.length,1,'a pull never repeats a reference');h.engine.request(req('typed twice',{reference:'same'}));assert.equal(h.engine.getSnapshot().requests.length,1);h.engine.stop();h.engine.start();assert.equal(h.engine.getSnapshot().requests[0].status,'queued','an unaired purchase survives a restart');h.engine.dispose();});
test('underruns hold the last frame without replaying dialogue',async()=>{const h=harness();h.engine.start();await h.finish(0);await h.finish(1);await h.finish(2);h.engine.clipEnded(0);h.engine.clipEnded(1);h.engine.clipEnded(2);assert.equal(h.engine.getSnapshot().phase,'waiting');assert.equal(h.engine.getSnapshot().current.id,2);assert.equal(h.engine.getSnapshot().stalls,1);await h.finish(3);assert.equal(h.engine.getSnapshot().current.id,3);assert.equal(h.engine.getSnapshot().phase,'playing');h.engine.dispose();});
test('unlabelled turns still alternate, and length and dialogue are enforced on every shot',()=>{const lines=parseLines(JSON.stringify({lines:['The moon is charging rent for my shadow.','Your shadow has been subletting your entire body.','So my landlord is technically just a silhouette?','Only until the sun files for an eviction.']}),5,'rent');assert.deepEqual(lines.map(l=>l.speaker),['guest','host','guest','host']);assert.equal(lines[0].cue,'rent');assert.throws(()=>parseLines('{"lines":[""]}',0));assert.throws(()=>shotPrompt('host','word '.repeat(31)));assert.match(shotPrompt('guest',lines[0].text),/says, "/);});

test("shot length tracks the turn instead of landing on the same number every time",()=>{
 // The old writer wrote 12-18 words for every turn, so every shot came out five seconds.
 // Turn length now spans a beat to a run, and the duration has to follow it.
 const w=n=>"word ".repeat(n).trim();
 assert.equal(shotDuration(w(2)),5,'a beat cannot go under the model floor');
 assert.equal(shotDuration(w(7)),5);
 assert.equal(shotDuration(w(12)),5);
 assert.equal(shotDuration(w(15)),6);
 assert.equal(shotDuration(w(18)),7);
 assert.equal(shotDuration(w(21)),8);
 assert.equal(shotDuration(w(25)),10);
 const spread=new Set([2,7,12,15,18,21,25].map(n=>shotDuration(w(n))));
 assert.ok(spread.size>=4,'a batch of mixed turns must not render as one length');
 assert.match(shotPrompt("host",w(15)),/shot lasts 6 seconds/);
});

test("a short turn renders as a reaction shot, a long one as a speech",()=>{
 assert.ok(isBeat("Neither."));
 assert.ok(!isBeat("word ".repeat(12).trim()));
 const beat=shotPrompt("guest","Neither.");
 assert.match(beat,/short reaction beat, not a speech/);
 assert.match(beat,/keeps listening to his partner in silence/);
 assert.doesNotMatch(beat,/brisk natural podcast pace/);
 const speech=shotPrompt("guest","word ".repeat(16).trim());
 assert.match(speech,/brisk natural podcast pace/);
 assert.doesNotMatch(speech,/reaction beat/);
 // The silent tail is a performance in both, never a frozen frame.
 for (const prompt of [beat,speech]) assert.doesNotMatch(prompt,/stay completely SILENT/);
});

test("the writer picks who speaks, and nobody holds the floor for three shots",()=>{
 const labelled=parseLines([
  'Pepe: So the whole thing just went to zero while I was asleep?',
  'GigaChad: Yes.',
  'GigaChad: Sleep is where conviction goes to die. I have not slept properly since twenty nineteen.',
  'Pepe: That explains the emails.',
 ].join('\n'),0);
 assert.deepEqual(labelled.map(l=>l.speaker),['host','guest','guest','host']);
 assert.deepEqual(labelled.map(l=>l.text)[1],'Yes.','the label never reaches the microphone');
 // Three in a row reads as a monologue, so the show falls back to alternating rather than
 // throwing away an exchange that is otherwise fine.
 const hogging=parseLines([
  'GigaChad: One perfectly ordinary spoken line here.',
  'GigaChad: Two ordinary spoken lines here now.',
  'GigaChad: Three ordinary spoken lines here.',
  'Pepe: Four ordinary spoken lines here now.',
 ].join('\n'),0);
 assert.deepEqual(hogging.map(l=>l.speaker),['host','guest','host','guest']);
 // A run may not straddle two batches either.
 const straddle=parseLines([
  'Pepe: One perfectly ordinary spoken line here.',
  'Pepe: Two ordinary spoken lines here now.',
  'GigaChad: Three ordinary spoken lines here.',
  'GigaChad: Four ordinary spoken lines here now.',
 ].join('\n'),4,undefined,undefined,{speaker:'host',text:'Some earlier line that nobody repeats.'});
 assert.deepEqual(straddle.map(l=>l.speaker),['host','guest','host','guest']);
 assert.ok(runsOk(['host','host','guest']));
 assert.ok(!runsOk(['host','host','guest'],'host'));
});

test("the cold open already varies its rhythm instead of trading equal turns",()=>{
 const lengths=opening.map(l=>shotDuration(l.text));
 assert.ok(new Set(lengths).size>1,'the first thirty seconds must not be metronomic');
 assert.ok(opening.some(l=>isBeat(l.text)),'the cold open needs a reaction beat');
 assert.ok(opening.some((l,i)=>i>0&&l.speaker===opening[i-1].speaker),'and one character keeping the floor');
 assert.ok(runsOk(opening.map(l=>l.speaker)));
 assert.deepEqual(opening.map(l=>l.id),opening.map((_,i)=>i));
});

test("the show hands the writer a shape, and the shape keeps changing",()=>{
 // Asked politely, the writer returned four turns of the same size every time. It is given
 // an explicit plan instead, and the plans rotate so the rhythm never becomes its own pattern.
 const shapes=new Set();const sizes=new Set();
 let prev=opening.at(-1).speaker;
 for(let start=opening.length,b=0;b<40;b++,start+=4){
  const plan=turnPlan(start,prev);
  assert.equal(plan.length,4);
  assert.ok(runsOk(plan.map(t=>t.speaker),prev),'a plan never lets anyone hold the floor three times');
  assert.equal(plan[0].speaker,prev==='host'?'guest':'host','a batch always opens on an answer');
  plan.forEach(t=>sizes.add(t.size));
  shapes.add(plan.map(t=>t.speaker[0]+t.size).join());
  prev=plan.at(-1).speaker;
 }
 assert.ok(shapes.size>=30,`the shape has to keep moving, saw ${shapes.size} in 40 batches`);
 assert.deepEqual([...sizes].sort(),['beat','normal','run']);
 // Some batches run without a beat, so short reactions do not arrive on a metronome either.
 let withBeat=0,total=0;prev=opening.at(-1).speaker;
 for(let start=opening.length,b=0;b<40;b++,start+=4){const plan=turnPlan(start,prev);total++;if(plan.some(t=>t.size==='beat'))withBeat++;prev=plan.at(-1).speaker;}
 assert.ok(withBeat>total/2&&withBeat<total,`beats should be common but not constant, saw ${withBeat}/${total}`);
 // Same batch, same plan: the writer's cache key is the shot number.
 assert.deepEqual(turnPlan(9,'guest'),turnPlan(9,'guest'));
});

test("the plan reaches the writer as named turns with word counts",()=>{
 const plan=turnPlan(9,'guest');
 const text=planPrompt(plan);
 for(const turn of plan) assert.ok(text.includes(`${turn.speaker==='host'?'Pepe':'GigaChad'}, `));
 assert.match(text,/2 to 7 words/);
 assert.match(text,/This one is a BEAT/);
 assert.equal(text.split('\n').length,plan.length+2);
});

test('plain dialogue preserves quotes and rejects malformed or incomplete legacy JSON',()=>{
 const lines=['You said "empty" when we spoke. I wrote that word down in my notes.','I meant the upstairs part of the boat. There was nobody on the roof.','That is a fairly important distinction to make before we start taking questions.','I thought we had covered the roof already. What else would you like to know?'];
 assert.deepEqual(parseLines(lines.join('\n'),0).map(x=>x.text),lines);
 assert.throws(()=>parseLines('{"lines":["He said "empty".","two","three","four"]}',0),/malformed/);
 assert.throws(()=>parseLines(lines.slice(0,3).join('\n'),0),/four/);
});

test('malformed writer response gets one fresh job, while network retries retain tokens',async()=>{
 const {createServices}=await import('../work/tests/services.js');
 const original=globalThis.fetch;let submitted=0;let polled=0;
 globalThis.fetch=async(_url,options)=>{
   const body=JSON.parse(options.body);
   if(body.action==='write')return Response.json({token:'job-'+(++submitted)});
   polled++;
   if(body.token==='job-1')return Response.json({code:'INVALID_DIALOGUE',error:'Malformed dialogue'},{status:422});
   return Response.json({status:'COMPLETED',lines:[{id:0,speaker:'host',text:'Recovered dialogue'}]});
 };
 try{const result=await createServices().write([],0);assert.equal(result[0].text,'Recovered dialogue');assert.equal(submitted,2);assert.equal(polled,2);}finally{globalThis.fetch=original;}
});

test('feed topics queue up without disturbing dialogue already being written',async()=>{
 const h=harness();h.engine.start();await settle(h,()=>h.writes.length>0);
 const writes=h.writes.length;const slots=h.engine.getSnapshot().slots.length;
 h.engine.enqueueTopics([{title:'A mining pool got subpoenaed',brief:'Regulators sent a subpoena.',angle:'Play it straight.',source:'x',score:80}]);
 assert.equal(h.writes.length,writes,'queueing a topic does not start a second write');
 assert.equal(h.engine.getSnapshot().topics.length,1);
 await h.reply(writes-1,h.writes[writes-1].start);
 assert.ok(h.engine.getSnapshot().slots.length>=slots,'the in-flight batch still became shots');
 h.engine.dispose();
});

test('a paid request outranks the wire and returns the topic unused',async()=>{
 const h=harness();h.engine.start();
 h.engine.enqueueTopics([{title:'A mining pool got subpoenaed',brief:'Regulators sent a subpoena.',angle:'Play it straight.',source:'x',score:80}]);
 await settle(h,()=>h.writes.length>0);
 const first=h.writes.length-1;
 assert.equal(h.writes[first].topic.title,'A mining pool got subpoenaed','the wire fills an idle write');
 assert.equal(h.engine.getSnapshot().topics[0].status,'writing');
 h.engine.request(req('what happened to the bridge'));
 await h.reply(first,h.writes[first].start);
 assert.equal(h.engine.getSnapshot().topics[0].status,'queued','the cancelled topic goes back on the wire');
 const second=h.writes.length-1;
 assert.equal(h.writes[second].cue,'what happened to the bridge');
 assert.equal(h.writes[second].topic,undefined,'a paid request is never mixed with a live topic');
 h.engine.dispose();
});

test('a topic stops being pending once its shot airs',async()=>{
 const h=harness();h.engine.start();
 h.engine.enqueueTopics([{title:'A mining pool got subpoenaed',brief:'Regulators sent a subpoena.',angle:'Play it straight.',source:'x',score:80}]);
 await settle(h,()=>h.writes.length>0);
 const index=h.writes.length-1;const start=h.writes[index].start;
 await h.reply(index,start);
 assert.equal(h.engine.getSnapshot().topics[0].status,'buffered');
 assert.equal(h.engine.getSnapshot().topics[0].shot,start);
 for(let id=0;id<=start;id++){if(h.jobs.has(id))await h.finish(id);}
 while(h.engine.getSnapshot().current&&h.engine.getSnapshot().current.id<start){const id=h.engine.getSnapshot().current.id;h.engine.clipEnded(id);if(h.engine.getSnapshot().current.id===id)break;}
 assert.equal(h.engine.getSnapshot().topics[0].status,'on-air');
 h.engine.dispose();
});

test('research runs beside the show and a failure never stops it',async()=>{
 let calls=0;let fail;
 const h=harness({research:()=>{calls++;return new Promise((_,reject)=>{fail=reject;});}});
 h.engine.setFeed(true);
 h.engine.start();
 assert.equal(calls,1,'research starts with the run');
 h.engine.getSnapshot().slots.length;
 assert.equal(calls,1,'never two calls in flight');
 assert.equal(h.engine.getSnapshot().feed.status,'searching');
 fail(Error('x search is down'));
 await tick();
 assert.equal(h.engine.getSnapshot().feed.status,'error');
 assert.equal(h.engine.getSnapshot().error,'','a feed failure is not a show failure');
 assert.ok(h.jobs.size>0,'shots kept rendering');
 h.engine.dispose();
});

test('chat comments are ranked in process and land on the wire',async()=>{
 const h=harness();h.engine.start();
 h.engine.ingestComments([
  {id:'1',author:'deb',text:'why is the whole timeline mad at the SEC again today'},
  {id:'2',author:'bot',text:'buy $PUMP now, ape in before it sends'},
 ]);
 const topics=h.engine.getSnapshot().topics;
 assert.ok(topics.length>=1,'a real question becomes a topic with no network call');
 assert.ok(topics.every(t=>t.source==='chat'));
 assert.ok(!topics.some(t=>/\$PUMP/i.test(t.title)),'shilling never reaches the wire');
 h.engine.dispose();
});

test('a writer hiccup recovers on its own; a persistent one still surfaces',async()=>{
 const h=harness();h.engine.start();
 await settle(h,()=>h.writes.length>0);
 const first=h.writes.length-1;
 h.writes[first].resolve(Promise.reject(Error('Writer returned a missing or overlong spoken line')));
 await tick();await tick();
 assert.equal(h.engine.getSnapshot().error,'','one bad exchange does not stop the show');
 assert.equal(h.writes.length,first+2,'the engine asks for a new exchange by itself');
 const second=h.writes.length-1;
 await h.reply(second,h.writes[second].start);
 assert.ok(h.engine.getSnapshot().slots.length>0,'dialogue resumed');
 h.engine.dispose();
});

test('the show gives up and asks for help after repeated writer failures',async()=>{
 const h=harness();h.engine.start();
 await settle(h,()=>h.writes.length>0);
 for(let attempt=0;attempt<3;attempt++){
  const index=h.writes.length-1;
  h.writes[index].resolve(Promise.reject(Error('The writer failed.')));
  await tick();await tick();
 }
 assert.notEqual(h.engine.getSnapshot().error,'','a persistent failure is surfaced');
 const stalled=h.writes.length;
 await tick();
 assert.equal(h.writes.length,stalled,'and writing stops until retry');
 h.engine.retry();
 await tick();
 assert.equal(h.engine.getSnapshot().error,'');
 assert.ok(h.writes.length>stalled,'retry resumes writing');
 h.engine.dispose();
});

test('the site is told once, on the shot where a paid request reaches the air',async()=>{
 const aired=[];
 const h=harness({
  write:async(recent,start)=>Array.from({length:4},(_,i)=>({id:start+i,speaker:(start+i)%2===0?'host':'guest',text:'A perfectly ordinary spoken line for this shot.'})),
  requests:{pull:async()=>[],aired:async(reference)=>{aired.push(reference);}},
 });
 try{
  h.engine.start();
  h.engine.request(req('read this on air',{reference:'paid-once'}));
  await settle(h,()=>aired.length>0,60);
  assert.deepEqual(aired,['paid-once'],'the purchase is acknowledged as it airs');
  await settle(h,()=>false,20);
  assert.deepEqual(aired,['paid-once'],'and never acknowledged twice');
  assert.equal(h.engine.getSnapshot().requests.find(r=>r.reference==='paid-once').status,'aired');
 } finally {h.engine.dispose();}
});

test('the chart lane owns the coin snapshot, and a chart failure is only a note',async()=>{
 const chart={mint:'mint',name:'the coin',symbol:'FROGCLENCH',priceUsd:1e-6,mcapUsd:1000,mcapSol:10,athMcapUsd:1000,change5m:0,change1h:0,change24h:0,volume24h:0,progress:10,graduated:false,replies:0,live:false,createdAt:0,candles:[]};
 const ok=harness({coin:async()=>({launched:true,coin:chart})});
 try{
  ok.engine.start();
  await tick();
  const state=ok.engine.getSnapshot();
  assert.equal(state.coinLaunched,true);
  assert.equal(state.coin.symbol,'FROGCLENCH');
  assert.equal(state.coinError,'');
 } finally {ok.engine.dispose();}
 const empty=harness({coin:async()=>({launched:false,coin:null})});
 try{
  empty.engine.start();
  await tick();
  assert.equal(empty.engine.getSnapshot().coinLaunched,false,'the site says the coin has not launched');
  assert.equal(empty.engine.getSnapshot().coin,null);
 } finally {empty.engine.dispose();}
 const broken=harness({coin:async()=>{throw Error('Chart unavailable');}});
 try{
  broken.engine.start();
  await tick();
  assert.equal(broken.engine.getSnapshot().coinError,'Chart unavailable');
  assert.equal(broken.engine.getSnapshot().error,'','a chart failure is not a show failure');
 } finally {broken.engine.dispose();}
});
