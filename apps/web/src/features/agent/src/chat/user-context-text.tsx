import { useState } from "react";
import type { TextMessagePartComponent } from "@assistant-ui/react";
import { collectComposerInlineTokens } from "@agent-workspace/client-runtime";
import { FileIcon } from "lucide-react";
import { ContextChip, ContextChipLabel } from "./context-chip";
import { useChatActions } from "./chat-actions";
import { referenceLabel } from "./rich-composer-document";
import { SkillContextIcon } from "./context-chip-parts";

/** The real file/Skill wire tokens stay in message text; presentation does not claim loading. */
export const UserContextText: TextMessagePartComponent = ({ text }) => {
  const navigation = useChatActions();
  const [error, setError] = useState<string>();
  const content = [];
  let offset = 0;
  for (const token of collectComposerInlineTokens(`${text} `)) {
    if (token.start < offset || token.end > text.length) continue;
    if (token.start > offset) content.push(<span key={`text:${offset}`}>{text.slice(offset, token.start)}</span>);
    const skill = token.type === "skill";
    const Icon = skill ? SkillContextIcon : FileIcon;
    content.push(<ContextChip key={`token:${token.start}`} data-message-source-token={token.source} kind={skill ? "skill" : "file"} render={!skill ? <button type="button" /> : undefined} title={skill ? `${token.value} · Skill token; selection does not prove this Skill was loaded.` : token.value} onClick={!skill ? () => { try { if (!navigation) throw new Error("Source navigation is unavailable."); navigation.openFile(token.value); } catch (cause) { setError(String(cause)); } } : undefined}><Icon /><ContextChipLabel>{referenceLabel(skill ? "skill" : "file", token.value)}</ContextChipLabel></ContextChip>);
    offset = token.end;
  }
  if (offset < text.length) content.push(<span key={`text:${offset}`}>{text.slice(offset)}</span>);
  return <span className="whitespace-pre-wrap">{content}{error && <span role="alert" className="block text-xs text-destructive">{error}</span>}</span>;
};
