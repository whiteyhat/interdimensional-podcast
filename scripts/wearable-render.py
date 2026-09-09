#!/usr/bin/env python3
"""Deterministic cap-print compositor. A rejected frame never becomes broadcast footage."""
import argparse, hashlib, json, math, os, subprocess, sys, tempfile
from pathlib import Path
import cv2
from wearable_panel import Tracker as ClothTracker, detect as detect_cloth
import numpy as np

class QualityError(Exception):
 def __init__(self,code,message=''):
  self.code=code;super().__init__(message or code)
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def load_template(manifest):
 path=manifest['blankCapImage']['path']
 if sha(path)!=manifest['blankCapImage']['sha256']:raise QualityError('TEMPLATE_CHANGED')
 for key,digest in manifest.get('maskHashes',{}).items():
  if sha(manifest[key])!=digest:raise QualityError('TEMPLATE_CHANGED')
 image=cv2.imread(path,cv2.IMREAD_COLOR)
 if image is None or image.shape[:2]!=(768,1344):raise QualityError('GEOMETRY_CHANGED')
 return image
def normalize_logo(path):
 image=cv2.imread(str(path),cv2.IMREAD_UNCHANGED)
 if image is not None and len(image.shape)==2:image=cv2.cvtColor(image,cv2.COLOR_GRAY2BGRA)
 if image is None or len(image.shape)!=3 or image.shape[2] not in (3,4):raise QualityError('INVALID_IMAGE','Use a color PNG, JPG, or WebP image.')
 h,w=image.shape[:2]
 if h<8 or w<8 or h*w>16777216 or max(h,w)>4096:raise QualityError('INVALID_IMAGE','Use artwork between 8 and 4096 pixels per side.')
 if image.shape[2]==3:image=cv2.cvtColor(image,cv2.COLOR_BGR2BGRA)
 if np.count_nonzero(image[:,:,3])<64:raise QualityError('EMPTY_IMAGE','The image is transparent. Add a visible logo.')
 ratio=min(1,1024/max(w,h))
 if ratio<1:image=cv2.resize(image,(round(w*ratio),round(h*ratio)),interpolation=cv2.INTER_AREA)
 return image
def placement_matrix(logo,manifest,placement=None):
 p=placement or {};scale=float(p.get('scale',.86));offset=p.get('offset',{});x=float(offset.get('x',0));y=float(offset.get('y',0))
 if not all(math.isfinite(v) for v in [scale,x,y]) or not .35<=scale<=1 or abs(x)>.25 or abs(y)>.25:raise QualityError('INVALID_PLACEMENT')
 quad=np.float32(manifest['logoQuad']);pw=(np.linalg.norm(quad[1]-quad[0])+np.linalg.norm(quad[2]-quad[3]))/2;ph=(np.linalg.norm(quad[3]-quad[0])+np.linalg.norm(quad[2]-quad[1]))/2
 h,w=logo.shape[:2];fit=min(pw/w,ph/h)*scale;left=(pw-w*fit)/2+x*pw;top=(ph-h*fit)/2+y*ph
 if min(w*fit,h*fit)<6:raise QualityError('LOGO_TOO_THIN','This artwork is too thin to read on the cap. Use a compact mark.')
 if left<0 or top<0 or left+w*fit>pw or top+h*fit>ph:raise QualityError('LOGO_OUTSIDE_PANEL')
 local=np.float32([[fit,0,left],[0,fit,top],[0,0,1]])
 project=cv2.getPerspectiveTransform(np.float32([[0,0],[pw,0],[pw,ph],[0,ph]]),quad)
 return project@local
def composite_logo(frame,logo,manifest,placement=None,matrix=None):
 h,w=frame.shape[:2];zoom=w/1344
 if abs(h/768-zoom)>.001:raise QualityError('GEOMETRY_CHANGED')
 motion=np.asarray(matrix if matrix is not None else np.eye(3),np.float64).reshape(3,3)
 outscale=np.diag([zoom,zoom,1]);transform=outscale@motion@placement_matrix(logo,manifest,placement)
 alpha=logo[:,:,3].astype(np.float32)/255;premul=logo[:,:,:3].astype(np.float32)*alpha[:,:,None]
 a=cv2.warpPerspective(alpha,transform,(w,h),flags=cv2.INTER_LINEAR);rgb=cv2.warpPerspective(premul,transform,(w,h),flags=cv2.INTER_LINEAR)
 # The panel and foreground masks share the tracked cap geometry, not screen space.
 panel=cv2.imread(manifest['logoMask'],0);front=cv2.imread(manifest['foregroundMask'],0)
 if panel is None or front is None:raise QualityError('MISSING_MASK')
 gate=cv2.warpPerspective(panel,outscale@motion,(w,h),flags=cv2.INTER_NEAREST).astype(np.float32)/255
 gate*=1-cv2.warpPerspective(front,outscale@motion,(w,h),flags=cv2.INTER_NEAREST).astype(np.float32)/255
 a*=gate;rgb*=gate[:,:,None]
 return np.clip(rgb+frame.astype(np.float32)*(1-a[:,:,None]),0,255).round().astype(np.uint8)

class CapTracker:
 def __init__(self,reference,manifest):
  self.reference=reference;self.manifest=manifest
  who='pepe' if manifest['id'].startswith('pepe') else 'gigachad'
  candidates,_=detect_cloth(reference,who)
  if len(candidates)!=1:raise QualityError('TEMPLATE_UNTRACKABLE')
  self.origin=np.float32(candidates[0]['quad']);self.tracker=ClothTracker(who)
  self.tracker.prev=cv2.cvtColor(reference,cv2.COLOR_BGR2GRAY);self.tracker.q=self.origin.copy()
  self.failed=False
 def track(self,frame):
  if self.failed:raise QualityError('TRACK_LOST')
  if frame.shape[:2]!=(768,1344):frame=cv2.resize(frame,(1344,768),interpolation=cv2.INTER_AREA)
  state=self.tracker.update(frame)
  if not state['valid']:
   self.failed=True;raise QualityError('TRACK_LOST',state.get('why','The cap surface could not be verified.'))
  motion=cv2.getPerspectiveTransform(self.origin,np.float32(state['quad']))
  quad=cv2.perspectiveTransform(np.float32(self.manifest['logoQuad']).reshape(1,-1,2),motion)[0]
  if not np.all(np.isfinite(motion)) or not cv2.isContourConvex(quad) or np.min(quad)<0 or np.max(quad[:,0])>=1344 or np.max(quad[:,1])>=768:
   self.failed=True;raise QualityError('LOGO_OUTSIDE_PANEL')
  return {**state,'matrix':motion.flatten().tolist(),'logoQuad':quad.tolist()}

def command(args):
 result=subprocess.run(args,capture_output=True,text=True)
 if result.returncode:raise QualityError('MEDIA_FAILED',result.stderr[-800:])
 return result.stdout
def media_info(path):return json.loads(command(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)]))
def audio_packets(path):
 return json.loads(command(['ffprobe','-v','error','-select_streams','a','-show_packets','-show_entries','packet=pts_time,dts_time,duration_time,data_hash','-show_data_hash','sha256','-of','json',str(path)])).get('packets',[])
def render_video(manifest,logo,source,output,placement=None):
 info=media_info(source);video=next((s for s in info['streams'] if s['codec_type']=='video'),None)
 if not video:raise QualityError('INVALID_VIDEO')
 if not audio_packets(source):raise QualityError('INVALID_AUDIO','The source clip has no verified audio packets to preserve.')
 w,h=video['width'],video['height'];num,den=map(int,video['avg_frame_rate'].split('/'));fps=num/den if den else 0
 if not 1<=fps<=60 or w>2688 or h>1536 or abs(w/h-1344/768)>.001 or abs(float(video.get('start_time',0)))>.001:raise QualityError('UNSUPPORTED_TIMING')
 times=json.loads(command(['ffprobe','-v','error','-select_streams','v','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',str(source)]))['frames']
 if not times or len(times)>960:raise QualityError('UNSUPPORTED_TIMING')
 for i,frame in enumerate(times):
  if abs(float(frame['best_effort_timestamp_time'])-i/fps)>.001:raise QualityError('UNSUPPORTED_TIMING')
 reference=load_template(manifest);tracker=CapTracker(reference,manifest);capture=cv2.VideoCapture(str(source));frames=[]
 output=Path(output);output.parent.mkdir(parents=True,exist_ok=True);temp=output.with_name(output.stem+'.pending.mp4')
 # File-backed stderr avoids a pipe deadlock while raw frames stream into the encoder.
 with tempfile.TemporaryFile() as err:
  encoder=subprocess.Popen(['ffmpeg','-y','-v','error','-f','rawvideo','-pixel_format','bgr24','-video_size',f'{w}x{h}','-framerate',f'{num}/{den}','-i','pipe:0','-i',str(source),'-map','0:v:0','-map','1:a:0?','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','copy','-fps_mode','passthrough','-movflags','+faststart',str(temp)],stdin=subprocess.PIPE,stderr=err)
  try:
   while True:
    ok,frame=capture.read()
    if not ok:break
    state=tracker.track(frame);state.update(index=len(frames),ptsMs=len(frames)*1000/fps);frames.append(state)
    encoded=composite_logo(frame,logo,manifest,placement,state['matrix']);encoder.stdin.write(encoded.tobytes())
   encoder.stdin.close();code=encoder.wait(timeout=60)
   if code:err.seek(0);raise QualityError('MEDIA_FAILED',err.read().decode(errors='replace')[-800:])
   if len(frames)!=len(times):raise QualityError('MEDIA_CHANGED')
   out=media_info(temp);outvideo=next(s for s in out['streams'] if s['codec_type']=='video')
   if int(outvideo.get('nb_frames',-1))!=len(frames) or abs(float(outvideo.get('duration',0))-len(frames)/fps)>.003 or audio_packets(source)!=audio_packets(temp):raise QualityError('MEDIA_CHANGED','The composed video changed media timing or audio packets.')
   os.replace(temp,output)
  except Exception:
   if encoder.poll() is None:encoder.kill()
   encoder.wait();temp.unlink(missing_ok=True);raise
  finally:capture.release()
 return {'accepted':True,'version':1,'frames':len(frames),'fps':fps,'durationMs':len(frames)*1000/fps,'tracker':'cloth-plane-v1','minClothCoverage':min(f['coverage'] for f in frames),'minEdgeContrast':min(min(f['contrast']) for f in frames),'maxForwardBackwardErrorPx':max(f.get('fb',0) for f in frames),'maxCornerDifference':max(f.get('cornerDifference',0) for f in frames),'audioVerified':True,'inputSha256':sha(source),'outputSha256':sha(output),'tracking':frames}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['normalize','preview','render']);parser.add_argument('--manifest');parser.add_argument('--asset',required=True);parser.add_argument('--placement');parser.add_argument('--video');parser.add_argument('--output',required=True);parser.add_argument('--report',required=True);args=parser.parse_args()
 report={'accepted':False}
 try:
  logo=normalize_logo(args.asset)
  if args.mode=='normalize':
   cv2.imwrite(args.output,logo);report={'accepted':True,'sha256':sha(args.output),'width':logo.shape[1],'height':logo.shape[0]}
  else:
   manifest=json.loads(Path(args.manifest).read_text());placement=json.loads(Path(args.placement).read_text()) if args.placement else None
   if args.mode=='preview':
    image=composite_logo(load_template(manifest),logo,manifest,placement);cv2.imwrite(args.output,image);report={'accepted':True,'sha256':sha(args.output),'templateId':manifest['id'],'templateSha256':manifest['blankCapImage']['sha256']}
   else:report=render_video(manifest,logo,args.video,args.output,placement)
 except QualityError as e:report={'accepted':False,'code':e.code,'error':str(e)}
 except Exception as e:report={'accepted':False,'code':'MEDIA_FAILED','error':str(e)}
 Path(args.report).write_text(json.dumps(report,separators=(',',':'))+'\n');print(json.dumps({k:v for k,v in report.items() if k!='tracking'}))
 return 0 if report['accepted'] else 2
if __name__=='__main__':sys.exit(main())
