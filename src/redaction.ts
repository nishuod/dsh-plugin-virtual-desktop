/** Diagnostic copies only: never change values used for authorization or execution. */
export function redactText(value:string):string {
  return value
    .replace(/([A-Za-z]:[\\/]Users[\\/])([^\\/"'\r\n]+)/gi,'$1[redacted]')
    .replace(/((?:-g[up]|--?(?:password|passwd|token|secret|api[-_]?key))\s*(?:=|\s)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,'$1[redacted]')
    .replace(/((?:password|passwd|token|secret|api[-_]?key)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,'$1[redacted]')
}
export function redactDiagnostics<T>(value:T):T {
  return scrub(value,false)
}

/** Public operational receipts retain file handles; display and diagnostic copies remain scrubbed. */
export function projectToolReceipt<T>(value:T):T {
  return scrub(value,true)
}

function scrub<T>(value:T,operational:boolean):T {
  if(typeof value==='string')return redactText(value) as T
  if(Array.isArray(value))return value.map(item=>scrub(item,operational)) as T
  if(!value || typeof value!=='object')return value
  const result=Object.fromEntries(Object.entries(value).map(([key,item])=>{
    if(/^(?:password|passwd|token|secret|api[-_]?key|nonce|authorization)$/i.test(key))return [key,'[redacted]']
    if(operational&&key==='filePath'&&typeof item==='string')return [key,item]
    if(key==='argv' && Array.isArray(item)){
      let secret=false
      return [key,item.map(arg=>{const s=String(arg);if(secret){secret=false;return '[redacted]'}secret=/^(?:-g[up]|--?(?:password|passwd|token|secret|api[-_]?key))$/i.test(s);return redactText(s)})]
    }
    return [key,scrub(item,operational)]
  }))
  const original=value as Record<string,unknown>
  if(operational&&typeof original.filePath==='string'){
    result.filePathDisplay=redactText(original.filePath)
    // The attachment fallback is the same operational handle, not a diagnostic path.
    if(original.nextTool==='read_image'&&original.nextToolArgs&&typeof original.nextToolArgs==='object'&&
      (original.nextToolArgs as Record<string,unknown>).file_path===original.filePath)
      result.nextToolArgs={...result.nextToolArgs,file_path:original.filePath}
  }
  return result as T
}
