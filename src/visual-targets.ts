import sharp from 'sharp'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import { findVisualIcons } from './visual-icons.ts'

export type Rect={x:number;y:number;width:number;height:number}
export const visualOptionsSchema=z.strictObject({
  enabled:z.boolean().default(true),maxCandidates:z.int().min(1).max(8).default(8),
  budgetMs:z.int().min(1).max(120).default(120),
  minRegionHeightPx:z.int().min(24).max(256).default(32),
  maxRegionAspectRatio:z.number().min(1).max(32).default(8),
})
export type VisualOptions=z.input<typeof visualOptionsSchema>
export interface VisualTarget {id:string;name:'';controlType:'region';bbox:Rect;crop:Rect;basis:'visual';confidence:number;shadowedBy?:string;parent?:string}
export interface VisualExtraction {targets:VisualTarget[];elapsedMs:number;truncated:boolean;reason?:string}
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex')
export const screenshotSha256=(base64:string)=>sha(Buffer.from(base64,'base64'))
export async function imagePixelHash(bytes:Buffer){const {data,info}=await sharp(bytes).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});return sha(Buffer.concat([Buffer.from(`${info.width}:${info.height}:`),data]))}
const area=(r:Rect)=>r.width*r.height
function intersection(a:Rect,b:Rect){return Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y))}
function edgeRun(mask:Uint8Array,start:number,stride:number,length:number){
  let longest=0,current=0
  for(let i=0;i<length;i++){
    current=mask[start+i*stride]?current+1:0
    longest=Math.max(longest,current)
  }
  return longest/length
}

/** Bounded local colour/edge grid; no OCR/model, and never a semantic button label. */
export async function extractVisualTargets(bytes:Buffer,client:Rect,uia:{id:string;bbox:Rect}[]=[],options:VisualOptions={},now=()=>performance.now()):Promise<VisualExtraction>{
  const config=visualOptionsSchema.parse(options),started=now()
  const result=(targets:VisualTarget[],truncated=false,reason?:string):VisualExtraction=>({targets,elapsedMs:Math.max(0,now()-started),truncated,...(reason?{reason}:{})})
  if(!config.enabled)return result([],false,'disabled')
  const expired=()=>now()-started>config.budgetMs
  const {data,info}=await sharp(bytes,{limitInputPixels:50_000_000}).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true})
  if(expired())return result([],true,'budget-exceeded')
  const left=Math.max(0,Math.ceil(client.x)),top=Math.max(0,Math.ceil(client.y)),right=Math.min(info.width,Math.floor(client.x+client.width)),bottom=Math.min(info.height,Math.floor(client.y+client.height))
  if(![left,top,right,bottom].every(Number.isFinite)||right-left<24||bottom-top<24)return result([],false,'client-unavailable')
  const step=4,cols=Math.ceil((right-left)/step),rows=Math.ceil((bottom-top)/step),count=cols*rows
  const colors=new Map<number,number>()
  let key=0,frequency=0
  // A four-level colour bucket preserves low-contrast surfaces such as dark theme cards.
  for(let y=top;y<bottom;y+=step*2){
    if(expired())return result([],true,'budget-exceeded')
    for(let x=left;x<right;x+=step*2){
      const i=(y*info.width+x)*3,k=(data[i]>>2)<<12|(data[i+1]>>2)<<6|(data[i+2]>>2)
      const hits=(colors.get(k)??0)+1
      colors.set(k,hits)
      if(hits>frequency){key=k;frequency=hits}
    }
  }
  const red=(key>>12)*4+2,green=((key>>6)&63)*4+2,blue=(key&63)*4+2
  const mask=new Uint8Array(count)
  for(let y=0;y<rows;y++){
    if(expired())return result([],true,'budget-exceeded')
    const cellTop=top+y*step,rowOffset=cellTop*info.width*3
    const centerY=Math.min(cellTop+2,bottom-1)*info.width*3
    for(let x=0;x<cols;x++){
      const cellLeft=left+x*step,center=centerY+Math.min(cellLeft+2,right-1)*3
      if(Math.abs(data[center]-red)>6||Math.abs(data[center+1]-green)>6||Math.abs(data[center+2]-blue)>6){
        mask[y*cols+x]=1
        continue
      }
      // Sample the top and left edges to retain thin outlines crossing this cell.
      const first=rowOffset+cellLeft*3
      for(let offset=0;offset<Math.min(step,right-cellLeft);offset++){
        const i=first+offset*3
        if(Math.abs(data[i]-red)>21||Math.abs(data[i+1]-green)>21||Math.abs(data[i+2]-blue)>21){mask[y*cols+x]=1;break}
      }
      if(mask[y*cols+x])continue
      for(let offset=1;offset<Math.min(step,bottom-cellTop);offset++){
        const i=first+offset*info.width*3
        if(Math.abs(data[i]-red)>21||Math.abs(data[i+1]-green)>21||Math.abs(data[i+2]-blue)>21){mask[y*cols+x]=1;break}
      }
    }
  }
  const seen=new Uint8Array(count),queue=new Int32Array(count),rectangles:{bbox:Rect;confidence:number}[]=[]
  const rowHits=new Uint32Array(rows),columnHits=new Uint32Array(cols)
  for(let start=0;start<count;start++){
    if((start&255)===0&&expired())return result([],true,'budget-exceeded')
    if(!mask[start]||seen[start])continue
    let take=0,put=1,minX=start%cols,maxX=minX,minY=Math.floor(start/cols),maxY=minY,cells=0
    queue[0]=start;seen[start]=1
    while(take<put){
      if((take&1023)===0&&expired())return result([],true,'budget-exceeded')
      const at=queue[take++],x=at%cols,y=Math.floor(at/cols);cells++
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const nx=x+dx,ny=y+dy,next=ny*cols+nx
        if(nx>=0&&ny>=0&&nx<cols&&ny<rows&&mask[next]&&!seen[next]){seen[next]=1;queue[put++]=next}
      }
    }
    if(maxX-minX+1<24/step||maxY-minY+1<24/step)continue
    rowHits.fill(0,minY,maxY+1);columnHits.fill(0,minX,maxX+1)
    for(let i=0;i<put;i++){
      const at=queue[i]
      rowHits[Math.floor(at/cols)]++
      columnHits[at%cols]++
    }
    // Discard sparse extensions from JPEG ringing and attached text strokes.
    // A rectangular border still has high coverage along all four edges.
    const rowCoverage=(maxX-minX+1)*.24,columnCoverage=(maxY-minY+1)*.24
    while(minY<maxY&&rowHits[minY]<rowCoverage)minY++
    while(maxY>minY&&rowHits[maxY]<rowCoverage)maxY--
    while(minX<maxX&&columnHits[minX]<columnCoverage)minX++
    while(maxX>minX&&columnHits[maxX]<columnCoverage)maxX--
    const bbox={x:left+minX*step,y:top+minY*step,width:Math.min(right,left+(maxX+1)*step)-(left+minX*step),height:Math.min(bottom,top+(maxY+1)*step)-(top+minY*step)}
    if(bbox.width<24||area(bbox)>.8*(right-left)*(bottom-top))continue
    // A shallow or unusually wide block is likely a line of text. Remove it
    // before scoring so it cannot consume a slot or affect confidence ranking.
    if (bbox.height < config.minRegionHeightPx || bbox.width / bbox.height > config.maxRegionAspectRatio) continue
    let edge=0,total=0
    for(let x=minX;x<=maxX;x++){edge+=mask[minY*cols+x]+mask[maxY*cols+x];total+=2}
    for(let y=minY+1;y<maxY;y++){edge+=mask[y*cols+minX]+mask[y*cols+maxX];total+=2}
    const boxCols=maxX-minX+1,boxRows=maxY-minY+1
    const fill=Math.min(1,cells/(boxCols*boxRows)),confidence=Math.min(.95,.35+.45*edge/Math.max(1,total)+.15*fill)
    const horizontal=Math.min(edgeRun(mask,minY*cols+minX,1,boxCols),edgeRun(mask,maxY*cols+minX,1,boxCols))
    const vertical=Math.min(edgeRun(mask,minY*cols+minX,cols,boxRows),edgeRun(mask,minY*cols+maxX,cols,boxRows))
    if(confidence<.55||fill<.78&&(horizontal<.5||vertical<.5))continue
    rectangles.push({bbox,confidence})
  }
  // Prefer enclosing card outlines over their internal icon/text components.
  const merged=rectangles.filter((r,i)=>!rectangles.some((other,j)=>i!==j&&area(other.bbox)>area(r.bbox)&&intersection(r.bbox,other.bbox)/area(r.bbox)>.9))
    .sort((a,b)=>b.confidence-a.confidence||area(b.bbox)-area(a.bbox))
  const parents:VisualTarget[]=merged.slice(0,config.maxCandidates).sort((a,b)=>a.bbox.y-b.bbox.y||a.bbox.x-b.bbox.x).map((r,index)=>{
    const shadow=uia.find(target=>intersection(r.bbox,target.bbox)/Math.max(area(r.bbox),area(target.bbox))>.8)
    return {id:`visual-${index}`,name:'' as const,controlType:'region' as const,bbox:r.bbox,crop:{...r.bbox},basis:'visual' as const,confidence:Math.round(r.confidence*1000)/1000,...(shadow?{shadowedBy:shadow.id}:{})}
  })
  if(expired())return result([],true,'budget-exceeded')

  // Spend only part of the remaining time on optional icons. Keep the existing
  // full-frame budget and reserve time for result projection and image proof.
  const iconDeadline = Math.min(started + config.budgetMs - 8, now() + 24)
  const children: VisualTarget[] = []
  let countLimited = merged.length > config.maxCandidates
  let iconTimeLimited = false
  for (const parent of parents) {
    if (parent.shadowedBy) continue
    const icons = findVisualIcons(data, info.width, parent.bbox, () => now() >= iconDeadline)
    if (!icons) {
      iconTimeLimited = true
      break
    }
    const available = Math.min(3, config.maxCandidates - parents.length - children.length)
    if (icons.length > available) countLimited = true
    icons.slice(0, available).forEach(({bbox,confidence},index) => {
      const shadow = uia.find(target => intersection(bbox,target.bbox) / Math.max(area(bbox),area(target.bbox)) > .8)
      children.push({id:`${parent.id}.icon-${index}`,name:'',controlType:'region',bbox,crop:{...bbox},basis:'visual',confidence,
        parent:parent.id,...(shadow?{shadowedBy:shadow.id}:{})})
    })
  }
  if(expired())return result([],true,'budget-exceeded')
  const reason = countLimited ? 'candidate-limit' : iconTimeLimited ? 'icon-budget-exceeded' : undefined
  return result([...parents,...children],!!reason,reason)
}

/** Difference bounding box in the delivered before-image coordinates, not a success assertion. */
export async function visualDifference(before:string,after:string){
  const started=performance.now(),beforeBytes=Buffer.from(before,'base64'),afterBytes=Buffer.from(after,'base64')
  const a=await sharp(beforeBytes).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true})
  const b=await sharp(afterBytes).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true})
  let bbox:Rect|null=null
  if(a.info.width!==b.info.width||a.info.height!==b.info.height)bbox={x:0,y:0,width:a.info.width,height:a.info.height}
  else{
    let minX=a.info.width,minY=a.info.height,maxX=-1,maxY=-1
    for(let y=0;y<a.info.height;y++)for(let x=0;x<a.info.width;x++){
      const i=(y*a.info.width+x)*3
      if(Math.max(Math.abs(a.data[i]-b.data[i]),Math.abs(a.data[i+1]-b.data[i+1]),Math.abs(a.data[i+2]-b.data[i+2]))>20){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)}
    }
    if(maxX>=minX)bbox={x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1}
  }
  return {beforeScreenshotSha256:sha(beforeBytes),afterScreenshotSha256:sha(afterBytes),changedRegion:bbox,elapsedMs:performance.now()-started}
}
