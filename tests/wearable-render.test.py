"""Exercise the actual raster compositor and motion gates without a provider call."""
import importlib.util,json,tempfile,unittest,sys
sys.path.insert(0,str(__import__('pathlib').Path(__file__).parents[1]/'scripts'))
from pathlib import Path
import cv2
import numpy as np
spec=importlib.util.spec_from_file_location('wearable',Path(__file__).parents[1]/'scripts/wearable-render.py')
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)

class WearableTest(unittest.TestCase):
 def setUp(self):
  self.logo=np.zeros((64,128,4),np.uint8);self.logo[:]=[20,150,240,255]
  cv2.putText(self.logo,'GM',(8,43),cv2.FONT_HERSHEY_SIMPLEX,1,(255,255,255,255),2)
  self.manifest=json.loads(Path('public/wearables/pepe-cap-v1.json').read_text())
 def test_preview_preserves_all_pixels_outside_printable_area(self):
  base=cv2.imread(self.manifest['blankCapImage']['path']);out=w.composite_logo(base,self.logo,self.manifest)
  mask=cv2.imread(self.manifest['logoMask'],0)
  self.assertTrue(np.array_equal(base[mask==0],out[mask==0]));self.assertFalse(np.array_equal(base,out))
 def test_tracking_follows_a_small_motion_but_rejects_missing_cap(self):
  ref=cv2.imread(self.manifest['blankCapImage']['path']);tracker=w.CapTracker(ref,self.manifest)
  moved=cv2.warpAffine(ref,np.float32([[1,0,4],[0,1,2]]),(1344,768))
  result=tracker.track(moved)
  self.assertTrue(result['valid']);self.assertAlmostEqual(result['matrix'][2],4,delta=1.2)
  with self.assertRaises(w.QualityError):tracker.track(np.zeros_like(ref))
 def test_logo_limits_and_manifest_hash_are_enforced(self):
  with self.assertRaises(w.QualityError):w.placement_matrix(self.logo,self.manifest,{'scale':4})
  bad={**self.manifest,'blankCapImage':{**self.manifest['blankCapImage'],'sha256':'bad'}}
  with self.assertRaises(w.QualityError):w.load_template(bad)
 def test_large_motion_is_rejected_instead_of_freezing_last_transform(self):
  ref=cv2.imread(self.manifest['blankCapImage']['path']);tracker=w.CapTracker(ref,self.manifest)
  with self.assertRaises(w.QualityError):tracker.track(cv2.warpAffine(ref,np.float32([[1,0,100],[0,1,0]]),(1344,768)))
 def test_occlusion_and_ambiguous_second_panels_are_rejected_for_both_hosts(self):
  for host in ['pepe','gigachad']:
   manifest=json.loads(Path(f'public/wearables/{host}-cap-v1.json').read_text());ref=w.load_template(manifest)
   for mode in ['green_center','skin_center','dark_center','green_corner','skin_corner','duplicate']:
    tracker=w.CapTracker(ref,manifest);state=tracker.track(ref);quad=np.float32(state['quad']);x,y,width,height=cv2.boundingRect(quad.astype(int));changed=ref.copy()
    color=(45,135,70) if mode.startswith('green') else (108,167,206) if mode.startswith('skin') else (18,25,25)
    if mode=='duplicate':changed[y+120:y+120+height+20,x+200:x+200+width+20]=ref[y-10:y+height+10,x-10:x+width+10]
    elif mode.endswith('center'):cv2.rectangle(changed,(x+width//3,y+height//3),(x+2*width//3,y+2*height//3),color,-1)
    else:cx,cy=quad[0].astype(int);cv2.rectangle(changed,(cx-7,cy-7),(cx+15,cy+15),color,-1)
    with self.subTest(host=host,mode=mode):
     with self.assertRaises(w.QualityError):tracker.track(changed)
     with self.assertRaises(w.QualityError):tracker.track(ref)
 def test_difficult_uploads_have_explicit_limits(self):
  with tempfile.TemporaryDirectory() as folder:
   p=Path(folder)/'mark.png'
   for pixels in [np.zeros((32,32,4),np.uint8),np.zeros((8,4097,3),np.uint8)]:
    cv2.imwrite(str(p),pixels)
    with self.assertRaises(w.QualityError):w.normalize_logo(p)
   p.write_text('<svg>not a raster logo</svg>')
   with self.assertRaises(w.QualityError):w.normalize_logo(p)
   cv2.imwrite(str(p),np.full((32,64),255,np.uint8));self.assertEqual(w.normalize_logo(p).shape[2],4)
   with self.assertRaises(w.QualityError):w.placement_matrix(np.ones((8,4096,4),np.uint8),self.manifest)
 def test_encoder_preserves_audio_packets_and_timestamps(self):
  with tempfile.TemporaryDirectory() as folder:
   src=Path(folder)/'source.mp4';out=Path(folder)/'printed.mp4'
   w.command(['ffmpeg','-y','-v','error','-loop','1','-framerate','10','-i',self.manifest['blankCapImage']['path'],'-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',str(src)])
   result=w.render_video(self.manifest,self.logo,src,out)
   self.assertEqual(result['frames'],10);self.assertTrue(result['audioVerified']);self.assertEqual(w.audio_packets(src),w.audio_packets(out))

if __name__=='__main__':unittest.main()
