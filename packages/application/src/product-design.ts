import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { DomainError } from '../../domain/src/core.ts';
import type { DesignBundle, ProductDesign } from '../../contracts/src/product-design.ts';

const limit = 8 * 1024 * 1024;
const types: Record<string,string> = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',svg:'image/svg+xml',html:'text/html',htm:'text/html',css:'text/css',md:'text/plain',txt:'text/plain',json:'application/json'};
const fail = (message:string):never=>{throw new DomainError('invalid_product_design',message,422);};
function safeName(name:string) {
  if(!name || name.length>240 || name.startsWith('/') || /[\\:\x00-\x1f]/.test(name) || name.split('/').some(p=>p==='..'||p==='.'||!p)) fail('设计包包含不安全或不支持的文件路径。');
  return name;
}
function crc32(data:Uint8Array) {
  let crc=0xffffffff;
  for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
/** In-memory, bounded ZIP import. No extraction to disk and no executable content is run. */
export function inspectDesignBytes(bytes:Buffer,fileName:string):Pick<DesignBundle,'assets'|'unsupported'|'sha256'> {
  if(!bytes.length||bytes.length>limit)fail('设计文件须为1字节至8 MiB。');
  const assets:DesignBundle['assets']=[],unsupported:string[]=[],seen=new Set<string>();let total=0;
  function add(name:string,data:Buffer){
    safeName(name);if(seen.has(name.toLowerCase()))fail('设计包包含重复文件名。');seen.add(name.toLowerCase());
    total+=data.length;if(total>limit||data.length>2*1024*1024)fail('设计包解压后超过8 MiB或单项超过2 MiB。');
    const mediaType=types[name.split('.').at(-1)!.toLowerCase()];
    if(!mediaType){unsupported.push(name);return;}
    if(assets.length>=64)fail('最多支持64个设计素材。');
    assets.push({name,mediaType,base64:data.toString('base64')});
  }
  if(!fileName.toLowerCase().endsWith('.zip'))add(fileName,bytes);
  else {
    let end=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
    if(end<0)fail('无法识别ZIP目录。');
    const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
    if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==count||count>256||count===0||offset+size!==end)fail('仅支持普通单卷ZIP，最多256个条目。');
    let cursor=offset;
    for(let index=0;index<count;index++){
      if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)fail('ZIP目录损坏。');
      const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),packed=bytes.readUInt32LE(cursor+20),unpacked=bytes.readUInt32LE(cursor+24),nameSize=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),local=bytes.readUInt32LE(cursor+42);
      const mode=bytes.readUInt32LE(cursor+38)>>>16;
      if(cursor+46+nameSize+extra+comment>end||flags&1||![0,8].includes(method)||bytes.readUInt16LE(cursor+34)||(mode&0xf000)===0xa000)fail('不支持加密、链接或此ZIP压缩格式。');
      const nameBytes=bytes.subarray(cursor+46,cursor+46+nameSize);
      let name:string;try{name=new TextDecoder('utf-8',{fatal:true}).decode(nameBytes);}catch{fail('文件名需使用UTF-8编码。');}
      cursor+=46+nameSize+extra+comment;
      if(name!.endsWith('/')){safeName(name!.slice(0,-1));if(unpacked!==0)fail('目录条目异常。');continue;}
      safeName(name!);
      if(unpacked>2*1024*1024||total+unpacked>limit||local+30>offset||bytes.readUInt32LE(local)!==0x04034b50)fail('设计包内容过大或文件头无效。');
      const localName=bytes.readUInt16LE(local+26),start=local+30+localName+bytes.readUInt16LE(local+28);
      if(start+packed>offset||!bytes.subarray(local+30,local+30+localName).equals(nameBytes)||bytes.readUInt16LE(local+8)!==method||bytes.readUInt16LE(local+6)!==flags)fail('ZIP文件头与目录不一致。');
      const compressed=bytes.subarray(start,start+packed);let data:Buffer;
      try{data=method===0?compressed:inflateRawSync(compressed,{maxOutputLength:2*1024*1024});}catch{fail('设计包解压失败或超过大小限制。');}
      if(data!.length!==unpacked||crc32(data!)!==crc)fail('ZIP内容校验失败。');
      add(name!,data!);
    }
    if(cursor!==end)fail('ZIP目录长度不一致。');
  }
  if(!assets.length)fail('未发现可预览的设计文件；支持图片、HTML、CSS及文本。');
  return {assets,unsupported,sha256:createHash('sha256').update(bytes).digest('hex')};
}

export async function resolveProductDesign(input: {versionId:string;projectId:string;expected?:ProductDesign}, ports: {
  version:(id:string)=>Promise<{kind:string;projectId:string|null}>;
  content:(id:string)=>Promise<{bytes:Buffer;fileName:string}>;
}):Promise<DesignBundle> {
  const version=await ports.version(input.versionId);
  if(version.kind!=='artifact_version'||version.projectId!==input.projectId)throw new DomainError('design_not_found','设计文件不属于当前项目或不可访问。',404);
  const content=await ports.content(input.versionId),bundle={versionId:input.versionId,fileName:content.fileName,...inspectDesignBytes(content.bytes,content.fileName)};
  if(input.expected&&input.expected.sha256!==bundle.sha256)fail('设计版本内容校验不一致。');
  return bundle;
}
