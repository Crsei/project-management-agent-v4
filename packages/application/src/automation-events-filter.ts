import { isDeepStrictEqual } from 'node:util';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { DomainError } from '../../domain/src/core.ts';

export function automationEventPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const part of pointer ? pointer.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~')) : []) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
/** Untrusted JMESPath runs in a bounded worker, not the PM event loop or an eval over caller code. */
const expressionWorker = `
const {parentPort,workerData}=require('node:worker_threads');
(async()=>{
 const {search,registerFunction,TYPE_ANY}=require(workerData.engineModule);
 const signature=[{types:[TYPE_ANY]},{types:[TYPE_ANY]}];
 registerFunction('icontains',([value,needle])=>typeof value==='string'&&typeof needle==='string'&&value.toLowerCase().includes(needle.toLowerCase()),signature);
 registerFunction('glob',([value,pattern])=>{
  if(typeof value!=='string'||typeof pattern!=='string'||value.length>100000||pattern.length>2000)return false;
  const tokens=[];
  for(let i=0;i<pattern.length;i++){
   const char=pattern[i];
   if(char==='*'){if(tokens.at(-1)?.type!=='star')tokens.push({type:'star'});}
   else if(char==='?')tokens.push({type:'any'});
   else if(char==='['){const end=pattern.indexOf(']',i+1);if(end<0)tokens.push({type:'literal',char});else{tokens.push({type:'class',chars:pattern.slice(i+1,end)});i=end;}}
   else tokens.push({type:'literal',char});
  }
  let previous=new Uint8Array(value.length+1);previous[0]=1;
  for(const token of tokens){const current=new Uint8Array(value.length+1);if(token.type==='star')current[0]=previous[0];
   for(let j=1;j<=value.length;j++){
    if(token.type==='star')current[j]=previous[j]||current[j-1];
    else if(previous[j-1]){
     const char=value[j-1];let matches=token.type==='any'||token.type==='literal'&&token.char===char;
     if(token.type==='class'){let chars=token.chars;const neg=chars[0]==='!'||chars[0]==='^';if(neg)chars=chars.slice(1);let found=false;for(let k=0;k<chars.length;k++){if(chars[k+1]==='-'&&chars[k+2]){found ||= char>=chars[k]&&char<=chars[k+2];k+=2;}else found ||= chars[k]===char;}matches=neg?!found:found;}
     if(matches)current[j]=1;
    }
   }previous=current;
  }return Boolean(previous[value.length]);
 },signature);
 const result=search(workerData.payload,workerData.expression);
 const truthy=result!==null&&result!==false&&result!==''&&!(Array.isArray(result)&&!result.length)&&!(result&&typeof result==='object'&&!Array.isArray(result)&&!Object.keys(result).length);
 parentPort.postMessage({matched:truthy});
})().catch(()=>parentPort.postMessage({error:'event_filter_invalid'}));
`;
export async function matchesAutomationEventFilter(payload: Record<string, unknown>, filter: Record<string, unknown>): Promise<boolean> {
  if (!Object.keys(filter).length) return true;
  if (Object.hasOwn(filter, 'expression')) {
    if (Object.keys(filter).length !== 1 || typeof filter.expression !== 'string' || !filter.expression.trim() || filter.expression.length > 2000) throw new DomainError('event_filter_invalid', 'JMESPath filter must contain only an expression string of at most 2000 characters');
    const { promise, resolve, reject } = Promise.withResolvers<boolean>();
    const worker = new Worker(expressionWorker, { eval: true, workerData: { expression: filter.expression, payload, engineModule: createRequire(import.meta.url).resolve('@jmespath-community/jmespath') }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
    const timer = setTimeout(() => { reject(new DomainError('event_filter_timeout', 'Event filter exceeded the bounded evaluation deadline')); void worker.terminate(); }, 1000);
    worker.once('message', (value: { matched?: boolean; error?: string }) => { if (value.error) reject(new DomainError('event_filter_invalid', 'Event filter is not a valid supported JMESPath expression')); else resolve(value.matched === true); void worker.terminate(); });
    worker.once('error', () => reject(new DomainError('event_filter_invalid', 'Event filter evaluation failed')));
    worker.once('exit', () => reject(new DomainError('event_filter_invalid', 'Event filter worker did not complete')));
    try { return await promise; } finally { clearTimeout(timer); }
  }
  for (const [path, expected] of Object.entries(filter)) {
    const pointer = path.startsWith('/') ? path : '/' + path.split('.').map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
    if (!isDeepStrictEqual(automationEventPointer(payload, pointer), expected)) return false;
  }
  return true;
}
