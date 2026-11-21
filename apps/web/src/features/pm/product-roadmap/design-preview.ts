import type { DesignBundle } from '../../../../../../packages/contracts/src/product-design';
const decode=(value:string)=>new TextDecoder().decode(Uint8Array.from(atob(value),c=>c.charCodeAt(0)));
export function previewDocument(asset:DesignBundle['assets'][number],assets:DesignBundle['assets']):string{
  const doc=new DOMParser().parseFromString(decode(asset.base64),'text/html');
  const resolve=(ref:string,owner=asset.name)=>{try{const base=new URL(owner,'https://design.invalid/'),url=new URL(ref,base);if(url.origin!==base.origin)return undefined;return assets.find(a=>a.name===decodeURIComponent(url.pathname.slice(1)));}catch{return undefined;}};
  const data=(a:DesignBundle['assets'][number])=>`data:${a.mediaType};base64,${a.base64}`;
  const inlineImage=(ref:string)=>/^data:image\/(png|jpeg|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(ref);
  const image=(ref:string,owner=asset.name)=>{const a=resolve(ref,owner);return a?.mediaType.startsWith('image/')?data(a):inlineImage(ref)?ref:'';};
  const css=(value:string,owner=asset.name)=>value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(_m,_q,ref:string)=>`url("${image(ref,owner)}")`);
  const resolvedStyles=new Set<Element>();
  doc.querySelectorAll('script,iframe,object,embed,base,meta[http-equiv]').forEach(n=>n.remove());
  doc.querySelectorAll('link').forEach(link=>{const a=resolve(link.getAttribute('href')??'');if(a?.mediaType==='text/css'){const style=doc.createElement('style');style.textContent=css(decode(a.base64),a.name);resolvedStyles.add(style);link.replaceWith(style);}else link.remove();});
  doc.querySelectorAll('*').forEach(node=>{for(const attr of [...node.attributes])if(/^on/i.test(attr.name)||['srcset','action','formaction','target','srcdoc','ping'].includes(attr.name))node.removeAttribute(attr.name);
    if(node.hasAttribute('href')&&!node.getAttribute('href')?.startsWith('#'))node.removeAttribute('href');
    if(node.hasAttribute('src')){const value=node.tagName==='IMG'?image(node.getAttribute('src')!):'';if(value)node.setAttribute('src',value);else node.removeAttribute('src');}
    if(node.hasAttribute('style'))node.setAttribute('style',css(node.getAttribute('style')!));
  });
  doc.querySelectorAll('style').forEach(n=>{if(!resolvedStyles.has(n))n.textContent=css(n.textContent??'');});
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'"></head><body>${doc.head.innerHTML}${doc.body.innerHTML}</body></html>`;
}
export const designText=decode;
