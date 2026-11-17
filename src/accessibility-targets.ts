import type { PrivacyTarget } from './privacy.ts'
import type { FrameAccessibility } from './native-contract.ts'

type Rect={x:number;y:number;width:number;height:number}
type Size={width:number;height:number}
type UiaTarget=Extract<NonNullable<FrameAccessibility['suggestedTargets']>[number],{basis:'uia-bounds'}>

export function projectTargetBounds(bounds:Rect,screen:Rect,raw:Size,region:Rect,image:Size):Rect|undefined {
  // SDK window capture has a one-pixel inset; use the same inverse as input delivery.
  const left=((bounds.x-screen.x-1)*raw.width/(screen.width-2)-region.x)*image.width/region.width
  const top=((bounds.y-screen.y-1)*raw.height/(screen.height-2)-region.y)*image.height/region.height
  const right=left+bounds.width*raw.width/(screen.width-2)*image.width/region.width
  const bottom=top+bounds.height*raw.height/(screen.height-2)*image.height/region.height
  // Refuse partially clipped controls: a clipped centre can hit a different control.
  if(![left,top,right,bottom].every(Number.isFinite)||left<0||top<0||right>image.width||bottom>image.height)return undefined
  const bbox={x:Math.ceil(left),y:Math.ceil(top),width:Math.floor(right)-Math.ceil(left),height:Math.floor(bottom)-Math.ceil(top)}
  return bbox.width>=2&&bbox.height>=2?bbox:undefined
}

/** Convert native UIA screen bounds into this exact redacted JPEG's coordinates. */
export function suggestedTargets(targets:PrivacyTarget[],screen:Rect,raw:Size,region:Rect,image:Size):UiaTarget[]{
  return targets.filter(t=>t.enabled).slice(0,64).flatMap((target,index)=>{
    const bbox=projectTargetBounds(target.bounds,screen,raw,region,image)
    if(!bbox)return []
    return [{id:`uia-${index}`,name:target.name.slice(0,512),controlType:target.controlType,bbox,basis:'uia-bounds' as const,crop:{...bbox}}]
  })
}
