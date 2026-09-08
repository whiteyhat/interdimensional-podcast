import {test} from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
await mkdir('work/tests',{recursive:true});
for(const name of ['topics','show','chat','engine','services']){const source=await readFile(`lib/${name}.ts`,'utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace(/from '\.\/(\w+)'/g,"from './$1.js'");await writeFile(`work/tests/${name}.js`,js);}
const {Podcast}=await import('../work/tests/engine.js');
const {parseLines,shotPrompt,shotDuration}=await import('../work/tests/show.js');
const tick=()=>new Promise(r=>setImmediate(r));
function harness(extra={}){const jobs=new Map();const writes=[];const released=[];const engine=new Podcast({render:line=>new Promise((resolve,reject)=>jobs.set(line.id,{line,resolve,reject})),write:(recent,start,cue,topic)=>new Promise(resolve=>writes.push({recent,start,cue,topic,resolve})),release:url=>released.push(url),...extra});return {engine,jobs,writes,released,async finish(id){const j=jobs.get(id);j.resolve({...j.line,url:`blob:${id}`,rawUrl:`https://fal.media/${id}.mp4`,duration:8,renderMs:100});await tick();},reply(index,start){writes[index].resolve(Array.from({length:4},(_,i)=>({id:start+i,speaker:(start+i)%2===0?'host':'guest',text:'A perfectly ordinary spoken line for this shot.'})));return tick();}};}
test('startup waits for three ordered shots; renders at most two at once',async()=>{const h=harness();h.engine.start();h.engine.start();assert.equal(h.jobs.size,2);await h.finish(1);assert.equal(h.engine.getSnapshot().current,null);assert.equal(h.jobs.size,3);await h.finish(0);assert.equal(h.jobs.size,4);assert.equal(h.engine.getSnapshot().current,null);await h.finish(2);assert.equal(h.engine.getSnapshot().current.id,0);h.engine.clipEnded(0);assert.equal(h.engine.getSnapshot().current.id,1);h.engine.clipEnded(0);assert.equal(h.engine.getSnapshot().current.id,1);h.engine.dispose();});
test('stop rejects stale results and releases their downloaded media',async()=>{const h=harness();h.engine.start();h.engine.stop();await h.finish(0);assert.equal(h.engine.getSnapshot().phase,'stopped');assert.equal(h.engine.getSnapshot().current,null);assert.ok(h.released.includes('blob:0'));h.engine.dispose();});
test('audience changes preserve submitted turns and write a bridge from their last line',async()=>{const h=harness();h.engine.start();h.engine.cue('haunted air fryer');assert.equal(h.engine.getSnapshot().slots.length,2);assert.equal(h.writes[0].start,2);assert.equal(h.writes[0].cue,'haunted air fryer');assert.equal(h.writes[0].recent.at(-1).speaker,'guest');h.engine.cue('the moon charges rent');h.writes[0].resolve(Array.from({length:4},(_,i)=>({id:i+2,speaker:i%2===0?'host':'guest',text:'This stale draft should never become a shot.'})));await tick();assert.equal(h.engine.getSnapshot().slots.length,2);assert.equal(h.writes[1].cue,'the moon charges rent');h.engine.dispose();});
test('underruns hold the last frame without replaying dialogue',async()=>{const h=harness();h.engine.start();await h.finish(0);await h.finish(1);await h.finish(2);h.engine.clipEnded(0);h.engine.clipEnded(1);h.engine.clipEnded(2);assert.equal(h.engine.getSnapshot().phase,'waiting');assert.equal(h.engine.getSnapshot().current.id,2);assert.equal(h.engine.getSnapshot().stalls,1);await h.finish(3);assert.equal(h.engine.getSnapshot().current.id,3);assert.equal(h.engine.getSnapshot().phase,'playing');h.engine.dispose();});
test('parser enforces alternation, length and dialogue on every shot',()=>{const lines=parseLines(JSON.stringify({lines:['The moon is charging rent for my shadow.','Your shadow has been subletting your entire body.','So my landlord is technically just a silhouette?','Only until the sun files for an eviction.']}),5,'rent');assert.deepEqual(lines.map(l=>l.speaker),['guest','host','guest','host']);assert.equal(lines[0].cue,'rent');assert.throws(()=>parseLines('{"lines":[""]}',0));assert.throws(()=>shotPrompt('host','word '.repeat(21)));assert.match(shotPrompt('guest',lines[0].text),/says, "/);});

test("speech durations leave less unused tail",()=>{assert.equal(shotDuration("word ".repeat(13)),5);assert.equal(shotDuration("word ".repeat(15)),5);assert.equal(shotDuration("word ".repeat(18)),6);assert.equal(shotDuration("word ".repeat(20)),7);assert.match(shotPrompt("host","word ".repeat(15).trim()),/shot lasts 5 seconds/);});

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
 const h=harness();h.engine.start();await h.finish(0);await h.finish(1);await h.finish(2);await h.finish(3);
 const writes=h.writes.length;const slots=h.engine.getSnapshot().slots.length;
 h.engine.enqueueTopics([{title:'A mining pool got subpoenaed',brief:'Regulators sent a subpoena.',angle:'Play it straight.',source:'x',score:80}]);
 assert.equal(h.writes.length,writes,'queueing a topic does not start a second write');
 assert.equal(h.engine.getSnapshot().topics.length,1);
 await h.reply(writes-1,h.writes[writes-1].start);
 assert.ok(h.engine.getSnapshot().slots.length>=slots,'the in-flight batch still became shots');
 h.engine.dispose();
});

test('an audience prompt outranks the wire and returns the topic unused',async()=>{
 const h=harness();h.engine.start();
 h.engine.enqueueTopics([{title:'A mining pool got subpoenaed',brief:'Regulators sent a subpoena.',angle:'Play it straight.',source:'x',score:80}]);
 await h.finish(0);await h.finish(1);await h.finish(2);await h.finish(3);
 const first=h.writes.length-1;
 assert.equal(h.writes[first].topic.title,'A mining pool got subpoenaed','the wire fills an idle write');
 assert.equal(h.engine.getSnapshot().topics[0].status,'writing');
 h.engine.cue('what happened to the bridge');
 await h.reply(first,h.writes[first].start);
 assert.equal(h.engine.getSnapshot().topics[0].status,'queued','the cancelled topic goes back on the wire');
 const second=h.writes.length-1;
 assert.equal(h.writes[second].cue,'what happened to the bridge');
 assert.equal(h.writes[second].topic,undefined,'an audience prompt is never mixed with a live topic');
 h.engine.dispose();
});

test('a topic stops being pending once its shot airs',async()=>{
 const h=harness();h.engine.start();
 h.engine.enqueueTopics([{title:'A mining pool got subpoenaed',brief:'Regulators sent a subpoena.',angle:'Play it straight.',source:'x',score:80}]);
 await h.finish(0);await h.finish(1);await h.finish(2);await h.finish(3);
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

test('ranked chat comments arrive on the wire as topics',async()=>{
 let resolveRank;
 const h=harness({rank:()=>new Promise(resolve=>{resolveRank=resolve;})});
 h.engine.start();
 h.engine.ingestComments([{id:'1',author:'deb',text:'why is the timeline mad at the SEC today'},{id:'2',author:'bot',text:'BUY 0x1234567890abcdef1234567890abcdef12345678'}]);
 assert.equal(h.engine.getSnapshot().ranking,true);
 resolveRank({topics:[{title:'Why is everyone mad at the SEC',brief:'deb asks about the mood.',angle:'Ask Pepe.',source:'chat',score:70,handle:'deb'}]});
 await tick();
 assert.equal(h.engine.getSnapshot().ranking,false);
 assert.deepEqual(h.engine.getSnapshot().topics.map(t=>t.source),['chat']);
 h.engine.dispose();
});
