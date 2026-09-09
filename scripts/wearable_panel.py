"""Template-specific cloth plane tracker. Missing evidence rejects the entire take.

Four corners are independently checked against cloth color, all four edge contrasts,
forward/backward flow, and interior/corner photometry. No unvalidated held transforms.
"""
import cv2
import numpy as np
def ordered(p):
 p=np.asarray(p,dtype=np.float32).reshape(4,2); s=p.sum(1);d=np.diff(p,axis=1).ravel()
 return p[[np.argmin(s),np.argmin(d),np.argmax(s),np.argmax(d)]]

def detect(frame,who):
 lab=cv2.cvtColor(frame,cv2.COLOR_BGR2LAB)
 center=np.array([131,140]) if who=='pepe' else np.array([133,137])
 lo=85 if who=='pepe' else 70
 mask=((lab[:,:,0]>lo)&(lab[:,:,0]<180)&(np.abs(lab[:,:,1].astype(float)-center[0])<8)&(np.abs(lab[:,:,2].astype(float)-center[1])<10)).astype(np.uint8)*255
 mask[430:]=0;mask[:,:220]=0;mask[:,1080:]=0
 mask=cv2.morphologyEx(mask,cv2.MORPH_OPEN,np.ones((2,2),np.uint8));mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
 contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE);out=[]
 for c in contours:
  area=cv2.contourArea(c)
  if not 900<area<20000:continue
  per=cv2.arcLength(c,True);approx=None
  for eps in [.018,.022,.026,.030]:
   a=cv2.approxPolyDP(c,per*eps,True)
   if len(a)==4 and cv2.isContourConvex(a):approx=a;break
  if approx is None:continue
  q=ordered(approx); sides=np.linalg.norm(np.roll(q,-1,axis=0)-q,axis=1);ratio=(sides[0]+sides[2])/(sides[1]+sides[3])
  if not 1.55<ratio<3.5 or min(sides)<20:continue
  angle=np.degrees(np.arctan2(q[1,1]-q[0,1],q[1,0]-q[0,0]))
  if abs(angle)>30:continue
  if not .9<area/cv2.contourArea(q)<1.1:continue
  patch=np.zeros(mask.shape,np.uint8);cv2.fillConvexPoly(patch,q.astype(np.int32),255);eroded=cv2.erode(patch,np.ones((5,5),np.uint8))>0
  coverage=float(np.mean(mask[eroded]>0));colorstd=float(np.percentile(lab[:,:,0][eroded],90)-np.percentile(lab[:,:,0][eroded],10))
  # Every edge must bound the light cloth against darker cap material, not skin or a wall.
  edge_contrast=[]
  for i in range(4):
   v=q[(i+1)%4]-q[i];normal=np.array([-v[1],v[0]])/np.linalg.norm(v)
   locations=np.linspace(q[i],q[(i+1)%4],11)[2:-2]
   inside=np.rint(locations+normal*8).astype(int);outside=np.rint(locations-normal*12).astype(int)
   contrast=lab[inside[:,1],inside[:,0],0].astype(float)-lab[outside[:,1],outside[:,0],0].astype(float)
   edge_contrast.append(float(np.median(contrast)))
  if coverage<.93 or colorstd>30 or min(edge_contrast)<12:continue
  out.append({'quad':q.tolist(),'coverage':coverage,'std':colorstd,'contrast':edge_contrast,'area':area,'angle':float(angle)})
 return out,mask

CANON=np.float32([[20,20],[140,20],[140,80],[20,80]])

def certify(frame,mask,q):
 if not cv2.isContourConvex(q) or np.min(q)<15 or np.max(q[:,0])>1328 or np.max(q[:,1])>752:return False,{'why':'bounds'}
 patch=np.zeros(mask.shape,np.uint8);cv2.fillConvexPoly(patch,np.int32(q),255);inner=cv2.erode(patch,np.ones((7,7),np.uint8))>0
 lab=cv2.cvtColor(frame,cv2.COLOR_BGR2LAB);coverage=float(np.mean(mask[inner]>0));contrast=[]
 for i in range(4):
  v=q[(i+1)%4]-q[i];normal=np.array([-v[1],v[0]])/np.linalg.norm(v);positions=np.linspace(q[i],q[(i+1)%4],11)[2:-2];inside=np.rint(positions+normal*8).astype(int);outside=np.rint(positions-normal*12).astype(int)
  contrast.append(float(np.median(lab[inside[:,1],inside[:,0],0].astype(float)-lab[outside[:,1],outside[:,0],0].astype(float))))
 return coverage>=.96 and min(contrast)>=15,{'coverage':coverage,'contrast':contrast}

def warp(gray,q):return cv2.warpPerspective(gray,cv2.getPerspectiveTransform(q,CANON),(160,100))

class Tracker:
 def __init__(self,who):self.who=who;self.prev=None;self.q=None
 def update(self,frame):
  gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY);candidates,mask=detect(frame,self.who);item={'valid':False,'candidates':len(candidates),'method':'none'};q=None
  if len(candidates)>1:item['why']='ambiguous'
  elif self.q is not None:
   forward,status,_=cv2.calcOpticalFlowPyrLK(self.prev,gray,self.q.reshape(-1,1,2),None,winSize=(25,25),maxLevel=3)
   if forward is None or status is None:return {'valid':False,'why':'flow_lost'}
   back,bs,_=cv2.calcOpticalFlowPyrLK(gray,self.prev,forward,None,winSize=(25,25),maxLevel=3)
   if back is None or bs is None:return {'valid':False,'why':'flow_lost'}
   prediction=forward.reshape(4,2);fb=float(np.max(np.linalg.norm(back.reshape(4,2)-self.q,axis=1)));step=float(np.max(np.linalg.norm(prediction-self.q,axis=1)))
   ratio=cv2.contourArea(prediction)/cv2.contourArea(self.q);item.update(fb=fb,step=step,areaRatio=ratio)
   valid=np.all(status)&np.all(bs)&(fb<.8)&(step<40)&(.84<ratio<1.18)
   if valid:
    q=prediction;item['method']='flow'
    if len(candidates)==1:
     detected=np.float32(candidates[0]['quad']);residual=float(np.max(np.linalg.norm(detected-prediction,axis=1)));item['residual']=residual
     if residual<3:q=.85*prediction+.15*detected;item['method']='flow+detect'
     elif residual>8:valid=False;item['why']='detector_disagreement'
    certified,metrics=certify(frame,mask,q);item.update(metrics);valid=bool(valid and certified)
    aligned=warp(gray,q);old=warp(self.prev,self.q);difference=np.abs(aligned.astype(float)-old.astype(float));center=difference[26:74,26:134]
    photo=float(np.percentile(center,95));corner=max(float(np.mean(difference[y-6:y+6,x-6:x+6])) for x,y in CANON.astype(int));item.update(photo95=photo,cornerDifference=corner)
    valid=valid and photo<24 and corner<14
   if valid:item['valid']=True
   elif 'why' not in item:item['why']='flow_or_cloth_evidence'
  elif len(candidates)==1:
   q=np.float32(candidates[0]['quad']);valid,metrics=certify(frame,mask,q);item.update(metrics);item['method']='detect';item['valid']=bool(valid)
  if q is not None:item['quad']=q.tolist()
  self.q=q if item['valid'] else None;self.prev=gray
  return item
