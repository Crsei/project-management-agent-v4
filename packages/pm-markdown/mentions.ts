import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { maskHiddenComments,type SyntaxNode } from './syntax.ts';
const parser=unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const identity=/^pm-user:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const literalTypes:Record<string,true>={blockquote:true,code:true,inlineCode:true,html:true,math:true,inlineMath:true,image:true,imageReference:true,linkReference:true,definition:true};
const voidHtml:Record<string,true>={area:true,base:true,br:true,col:true,embed:true,hr:true,img:true,input:true,link:true,meta:true,param:true,source:true,track:true,wbr:true};
/** Raw HTML inline tags can bracket separate Markdown AST nodes. Never activate their contents. */
function walkActiveLinks(node:SyntaxNode,visit:(node:SyntaxNode)=>void):void {
 if(Object.hasOwn(literalTypes,node.type))return;
 if(node.type==='link'){visit(node);return;}
 let htmlDepth=0;
 for(const child of node.children??[]) {
  if(child.type==='html') {
   for(const tag of (child.value??'').matchAll(/<\s*(\/?)\s*([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    if(tag[1])htmlDepth=Math.max(0,htmlDepth-1);
    else if(!Object.hasOwn(voidHtml,tag[2]!.toLowerCase())&&!/\/\s*>$/.test(tag[0]))htmlDepth++;
   }
   continue;
  }
  if(!htmlDepth)walkActiveLinks(child,visit);
 }
}
function mentionId(node:SyntaxNode,source:string):string|null {
 const match=identity.exec(node.url??''),start=node.position?.start.offset,end=node.position?.end.offset;
 const raw=start===undefined||end===undefined?'':source.slice(start,end);
 // Literal destination is required: percent/entity/backslash aliases are not identities.
 return match&&node.children?.length&&node.children.every(child=>child.type==='text')&&raw.startsWith('[@')&&raw.endsWith(`](${node.url})`)?match[1]!:null;
}
/** Canonical inline links only, never rendered HTML, reference links or literal examples. */
export function extractPersonalMentions(source:string):string[] {
 const ids=new Set<string>(),masked=maskHiddenComments(source);
 walkActiveLinks(parser.parse(masked) as SyntaxNode,node=>{const id=mentionId(node,masked);if(id)ids.add(id);});
 return [...ids].sort();
}
export function addedPersonalMentions(before:string,after:string):string[] {
 const previous=new Set(extractPersonalMentions(before)),current=extractPersonalMentions(after);
 if(current.length>50)throw new Error('mention_limit_exceeded');
 return current.filter(id=>!previous.has(id));
}
export function personalMentionToken(userId:string,name:string):string {
 if(!identity.test(`pm-user:${userId}`))throw new Error('Invalid mention identity');
 return `[@${name.replace(/[\r\n]/g,' ').replace(/[\\`*_[\]<>!~$]/g,'\\$&')}](pm-user:${userId})`;
}
/** Inert neutral chips: untrusted labels are never presented as verified member identity. */
export function remarkPersonalMentions() {
 return (tree:SyntaxNode,file:{value?:unknown})=>{
  const source=typeof file.value==='string'?maskHiddenComments(file.value):'';
  walkActiveLinks(tree,node=>{
   if(!mentionId(node,source))return;
   node.type='pmPersonalMention';delete node.url;
   node.children=[{type:'text',value:'@成员 / Member'}];
   node.data={hName:'span',hProperties:{className:'pm-personal-mention','data-pm-mention':'true',title:'Personal mention · 个人提及'}};
  });
 };
}
