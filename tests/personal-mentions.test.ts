import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { addedPersonalMentions,extractPersonalMentions,personalMentionToken,remarkPersonalMentions } from '../packages/pm-markdown/mentions.ts';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { SyntaxNode } from '../packages/pm-markdown/syntax.ts';
const id='abcdefab-1111-4111-8111-abcdefabcdef',token=personalMentionToken(id,'重名用户');
test('mentions use canonical UUID identity, not display label, with per-version set difference',()=>{
 assert.deepEqual(extractPersonalMentions(`${token} ${personalMentionToken(id,'changed label')} @name`),[id]);
 assert.deepEqual(addedPersonalMentions(token,personalMentionToken(id,'改名')),[]);
 assert.deepEqual(addedPersonalMentions('',token),[id]);assert.deepEqual(addedPersonalMentions(token,''),[]);
 assert.deepEqual(extractPersonalMentions(personalMentionToken(id,'Name *role* <span> $math$ [label]')), [id]);
});
test('literal Markdown containers and URI aliases never activate mention routing',()=>{
 const literals=[`\`${token}\``,`\`\`\`md\n${token}\n\`\`\``,`> ${token}`,`%% ${token} %%`,`<div>${token}</div>`,`prefix <span>${token}</span> suffix`,`$${token}$`,`![x](pm-user:${id})`,`[@x][user]\n\n[user]: pm-user:${id}`,`\\${token}`,`[@x](pm-user:${id}?x=1)`,`[@x](pm-user:${id}#fragment)`,`[@x](pm-user:${id.toUpperCase()})`,`[@x](pm-user:%31${id.slice(1)})`,`[@x](pm-user:${id}/extra)`];
 for(const literal of literals) assert.deepEqual(extractPersonalMentions(literal),[],literal);
});
test('the full pending body is bounded at fifty distinct identities without truncation',()=>{
 const tokens=Array.from({length:51},()=>personalMentionToken(randomUUID(),'Member'));
 assert.equal(addedPersonalMentions('',tokens.slice(0,50).join(' ')).length,50);
 assert.throws(()=>addedPersonalMentions('',tokens.join(' ')),/mention_limit_exceeded/);
 assert.equal(extractPersonalMentions(Array(100).fill(token).join(' ')).length,1);
});
test('rendering produces an inert neutral mention chip without trusting its label or allowing pm-user URLs',()=>{
 const tree=unified().use(remarkParse).parse(`[@Forged administrator](pm-user:${id})`) as SyntaxNode;
 remarkPersonalMentions()(tree,{value:`[@Forged administrator](pm-user:${id})`});
 const mention=tree.children?.[0]?.children?.[0];assert.equal(mention?.type,'pmPersonalMention');assert.equal(mention?.url,undefined);
 assert.equal(mention?.data?.hName,'span');assert.equal(mention?.children?.[0]?.value,'@成员 / Member');
});
