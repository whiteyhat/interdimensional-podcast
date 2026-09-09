#!/usr/bin/env node
// Bounded provider trial: two ten-second native clips per host. Never starts a live stream.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fal as client } from '@fal-ai/client';
import { falKey,  fal, waitFor } from './fal.mjs';
import { build } from '../tests/build.mjs';
const execute=process.argv.includes('--run'),heldout=process.argv.includes('--heldout');
const dir='work/wearable-qualification';await mkdir(dir,{recursive:true});
await build(['show','gestures','video-frames']);
const {shotInput}=await import('../work/tests/show.js');
if(process.argv.includes('--retry-rejected')){
 if(!execute)throw Error('Add --run for one bounded replacement per rejected held-out clip.');
 const entries=JSON.parse(await readFile(`${dir}/renders-heldout.json`,'utf8'));const replacements=[];
 for(const entry of entries){
  const name=entry.speaker==='host'?'pepe':'gigachad';const report=JSON.parse(await readFile(`${dir}/${name}-2-text.json`,'utf8'));if(report.accepted)continue;
  const input={...entry.input,seed:entry.input.seed+1};const key=await falKey();const job=await fal('https://queue.fal.run/minimax/h3-max-turbo/image-to-video',key,input);
  await writeFile(`${dir}/${name}-3-job.json`,JSON.stringify(job));const result=await waitFor(job,key);if(!result.video?.url)throw Error('No replacement video returned');
  const response=await fetch(result.video.url);if(!response.ok)throw Error('Download failed');const path=`${dir}/${name}-3.mp4`;await writeFile(path,Buffer.from(await response.arrayBuffer()));replacements.push({...entry,input,take:3,replaces:2,path,url:result.video.url,requestId:job.request_id});console.log(`${name} replacement downloaded`);
 }
 await writeFile(`${dir}/renders-replacements.json`,JSON.stringify(replacements,null,2));process.exit(0);
}
const hosts=[['host','pepe'],['guest','gigachad']];
const entries=[];
if(execute)client.config({credentials:await falKey()});
for(const[speaker,name]of hosts){
 const path=`public/wearables/${name}-cap-v1.png`;
 const upload=execute?await client.storage.upload(new Blob([await readFile(path)],{type:'image/png'})):path;
 for(let take=heldout?2:0;take<(heldout?3:2);take++){
  const text=speaker==='host'?['I refreshed the chart six times and somehow the hat is still my best performing asset.','Ser, the cap has a sponsor. My financial decisions are still entirely my own fault.','This cap survived another chart refresh. Give the builders credit for shipping through the noise.'][take]:['A hat is a position for your head. Naturally, I intend to hold it with conviction.','Discipline means wearing the cap through every market condition. Especially the ones you personally caused.','A committed builder keeps showing up. The hat is optional, but the consistency is not.'][take];
  const input={...shotInput({id:take,speaker,text}),image_url:upload,end_image_url:upload};input.seed+=take;
  input.prompt+=' Preserve the charcoal baseball cap and its blank fabric front patch exactly. Restrained head movement only, within four degrees. Hands stay below the chest and never touch the cap, head, or headphones.';
  const record={speaker,take,input};
  if(execute){
   const key=await falKey();const job=await fal('https://queue.fal.run/minimax/h3-max-turbo/image-to-video',key,input);
   record.requestId=job.request_id;await writeFile(`${dir}/${name}-${take}-job.json`,JSON.stringify(job));
   const result=await waitFor(job,key);if(!result.video?.url)throw Error('No qualification video returned');
   record.url=result.video.url;const response=await fetch(record.url);if(!response.ok)throw Error('Download failed');
   record.path=`${dir}/${name}-${take}.mp4`;await writeFile(record.path,Buffer.from(await response.arrayBuffer()));
   console.log(`${name} take ${take} downloaded`);
  }
  entries.push(record);await writeFile(`${dir}/renders${heldout?'-heldout':''}.json`,JSON.stringify(entries,null,2));
 }
}
console.log(execute?`${heldout?'Two held-out':'Four bounded'} clips prepared for tracking qualification.`:'Dry run written. Use --run for the four-clip provider trial.');
