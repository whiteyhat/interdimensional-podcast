// Real audio decoding and the real Player. The fixture has an audible tone throughout;
// only the verified first 0.2 seconds may reach the output, including after seeking.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Player } from '../../components/player';
const checks = [];
const check = (ok, message) => { checks.push({ message, pass: !!ok }); if (!ok) throw Error(message + ': ' + JSON.stringify({level: level(), videos:[...document.querySelectorAll('video')].map(v=>({time:v.currentTime,paused:v.paused,muted:v.muted,ready:v.readyState})), contexts:probes.map(p=>p.context.state)})); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (predicate) => {
  const deadline = performance.now() + 1500;
  while (!predicate()) { if (performance.now() > deadline) throw Error('Timed out waiting for audio state'); await wait(5); }
};
const nativeContext = window.AudioContext;
const probes = window.audioProbes = [];
window.AudioContext = class extends nativeContext {
  createGain() {
    const gain = super.createGain();
    const analyser = this.createAnalyser();
    analyser.fftSize = 256;
    gain.connect(analyser);
    probes.push(analyser);
    return gain;
  }
};
const level = () => Math.max(0, ...probes.map(probe => {
  const samples = new Float32Array(probe.fftSize);
  probe.getFloatTimeDomainData(samples);
  return Math.sqrt(samples.reduce((sum,v) => sum+v*v,0)/samples.length);
}));
const root = createRoot(document.getElementById('root'));
const bytes = await (await fetch('./tone.mp4')).blob();
const clip = id => ({id,speaker:id%2?'guest':'host',text:'Of course.',url:URL.createObjectURL(bytes),rawUrl:'',duration:.6,speechEnd:.2,renderMs:0});
const first=clip(0), second=clip(1);
let state={phase:'playing',current:first,previous:null,slots:[{...second,status:'ready',clip:second}]};
let shown=0;
const render=()=>flushSync(()=>root.render(<React.StrictMode><Player state={state} muted={false} onEnded={()=>{}} onShown={()=>shown++}/></React.StrictMode>));
const current=()=>[...document.querySelectorAll('video')].find(v=>v.src===state.current.url);
const ensureSound=async()=>{const button=document.querySelector('button');if(button)button.click();await wait(20);};
window.playerChecks=(async()=>{
 render();await wait(70);await ensureSound();
 // Explicit seek/play also makes this usable when the browser enforces autoplay.
 let video=current();
 await until(()=>video.readyState>=3&&probes.some(p=>p.context.state==='running'));
 video.pause();video.currentTime=0;await video.play();await until(()=>level()>.001);
 check(level()>.001,'The verified speech interval remains audible');
 await until(()=>video.currentTime>.32);
 await wait(20);
 check(level()<.00001,'Continuous source audio is silent after the verified word boundary');
 check(!video.paused,'The continuity picture keeps moving after speech is silenced');
 state={...state,phase:'paused'};render();await wait(30);
 check(video.paused&&level()<.00001,'Pause immediately silences and pauses the current clip');
 state={...state,phase:'playing'};render();await wait(50);
 check(level()<.00001,'Resuming in a silent tail never reopens its audio');
 video.currentTime=.02;await wait(80);
 check(level()>.001,'Seeking back into the verified line rearms its audio');
 video.playbackRate=2;await wait(140);
 check(level()<.00001,'A rate change still silences at the speech boundary');
 state={...state,current:second,previous:first,slots:[]};render();await wait(90);
 const old=video;video=current();
 check(old.muted&&old.paused,'The outgoing visible frame has no audio ownership');
 check(level()>.001,'The incoming clip gets its own audible speech interval');
 await old.play();await wait(30);
 check(old.paused&&old.muted,'A late play event cannot reactivate an outgoing voice');
 await wait(180);
 check(level()<.00001,'A completed handoff does not reopen either silent tail');
 check(shown>=2,'Audio gating preserves presentation of both clips');
 root.unmount();await wait(40);
 check(probes.every(p=>p.context.state==='closed'),'Unmount releases the audio context');
 for(const c of [first,second])URL.revokeObjectURL(c.url);
 return checks;
})().catch(error=>({error:error.message,checks}));
window.playerChecks.then(result=>document.getElementById('results').textContent=JSON.stringify(result,null,2));
