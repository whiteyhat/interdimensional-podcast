#!/usr/bin/env python3
"""Verify a bounded real-footage trial before publishing the exact qualified artifact set.

Run wearable-qualify.mjs, then render every take with text and graphic marks. --finalize
requires --visual-reviewed and only succeeds when all artifacts and negative tests pass.
No provider, payment, deployment or network requests are made by this audit.
"""
import argparse,json,subprocess,sys,datetime
from pathlib import Path
import importlib.util
spec=importlib.util.spec_from_file_location('wearable','scripts/wearable-render.py');w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
parser=argparse.ArgumentParser();parser.add_argument('--finalize',action='store_true');parser.add_argument('--visual-reviewed',action='store_true');args=parser.parse_args()
root=Path('work/wearable-qualification');trials=[]
for host,takes in [('pepe',[0,1,2]),('gigachad',[0,1,3])]:
 for take in takes:
  for mark in ['graphic','text']:
   report=json.loads((root/f'{host}-{take}-{mark}.json').read_text());source=root/f'{host}-{take}.mp4';output=root/f'{host}-{take}-{mark}.mp4'
   assert report.get('accepted') and report.get('audioVerified') and report.get('tracker')=='cloth-plane-v1',(host,take,mark,'quality failed')
   assert report['inputSha256']==w.sha(source) and report['outputSha256']==w.sha(output),'artifact changed'
   assert report['frames']==len(report['tracking']) and all(f['valid'] for f in report['tracking']),'unverified frame'
   assert w.audio_packets(source) and w.audio_packets(source)==w.audio_packets(output),'audio changed'
   info=w.media_info(output);video=next(s for s in info['streams'] if s['codec_type']=='video');assert int(video['nb_frames'])==report['frames']
   trials.append({'host':host,'take':take,'mark':mark,'frames':report['frames'],'audioVerified':True,'inputSha256':report['inputSha256'],'outputSha256':report['outputSha256'],'heldOut':take>=2,'minClothCoverage':report['minClothCoverage'],'maxForwardBackwardErrorPx':report['maxForwardBackwardErrorPx']})
# This real hand-to-cap take must remain rejected, with no composited video admitted.
for mark in ['graphic','text']:
 report=json.loads((root/f'gigachad-2-{mark}.json').read_text());assert report.get('accepted') is False and not (root/f'gigachad-2-{mark}.mp4').exists(),'rejected take admitted'
subprocess.run([sys.executable,'tests/wearable-render.test.py'],check=True)
code={p:w.sha(p) for p in ['scripts/wearable-render.py','scripts/wearable_panel.py']}
templates={}
for host in ['pepe','gigachad']:
 path=Path(f'public/wearables/{host}-cap-v1.json');m=json.loads(path.read_text());w.load_template(m)
 templates[m['id']]={'image':m['blankCapImage']['sha256'],'foregroundMask':w.sha(m['foregroundMask']),'logoMask':w.sha(m['logoMask'])}
result={'version':'caps-v1','accepted':True,'visualReviewed':args.visual_reviewed,'testedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tracker':'cloth-plane-v1','code':code,'templates':templates,'trials':trials,'negativeTestsPassed':True,'realOcclusionRejected':{'host':'gigachad','take':2,'reason':'hand touched cap; backward flow lost'},'scope':'One fixed cap style per host, original uploaded raster, 1344x768 or uniform upscale, runtime rejects every uncertain take. Staging and production availability remain separate gates.'}
(root/'qualification.json').write_text(json.dumps(result,indent=2)+'\n')
if args.finalize:
 assert args.visual_reviewed,'Inspect composited videos/contact sheets before finalizing.'
 for host in ['pepe','gigachad']:
  path=Path(f'public/wearables/{host}-cap-v1.json');m=json.loads(path.read_text());m['qualified']=True;m['qualificationVersion']='caps-v1';path.write_text(json.dumps(m,indent=2)+'\n')
  result['templates'][m['id']]['manifestSha256']=w.sha(path)
 Path('public/wearables/caps-v1-qualification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'accepted':True,'finalized':args.finalize,'compositedFrames':sum(t['frames'] for t in trials),'trials':len(trials)}))
