import {test} from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
await mkdir('work/tests',{recursive:true});
for(const name of ['show','engine','services']){const source=await readFile(`lib/${name}.ts`,'utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace("from './show'","from './show.js'");await writeFile(`work/tests/${name}.js`,js);}
const {Podcast}=await import('../work/tests/engine.js');
const {parseLines,shotPrompt,shotDuration}=await import('../work/tests/show.js');
const tick=()=>new Promise(r=>setImmediate(r));
function harness(){const jobs=new Map();const writes=[];const released=[];const engine=new Podcast({render:line=>new Promise((resolve,reject)=>jobs.set(line.id,{line,resolve,reject})),write:(recent,start,cue)=>new Promise(resolve=>writes.push({recent,start,cue,resolve})),release:url=>released.push(url)});return {engine,jobs,writes,released,async finish(id){const j=jobs.get(id);j.resolve({...j.line,url:`blob:${id}`,rawUrl:`https://fal.media/${id}.mp4`,duration:8,renderMs:100});await tick();}};}
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
