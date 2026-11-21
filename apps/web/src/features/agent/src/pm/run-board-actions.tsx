import { Link } from "react-router-dom"
import { MessageSquare, RefreshCw, Square, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useAgentText } from "../i18n"
import styles from "./run-board-actions.module.css"

export function RunBoardActionsDialog({
  title, sessionHref, terminalHref, panelTerminal, newSessionHref, newSessionChatOnly, attention, canStop, pending, onStop, onPanelTerminal, onCopy, onRefresh, onClose,
}: {
  title: string
  sessionHref: string
  terminalHref: string | null
  panelTerminal: boolean
  newSessionHref: string | null
  newSessionChatOnly: boolean
  attention: boolean
  canStop: boolean
  pending: boolean
  onStop: () => void
  onPanelTerminal: () => void
  onCopy: () => void
  onRefresh: () => void
  onClose: () => void
}) {
  const t = useAgentText()
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className={styles.dialog}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t("只操作当前会话或从它的已核验目录派生动作；停止不会把业务任务标记为完成。", "Only this Session or actions derived from its verified folder are affected; stopping never marks the business task complete.")}</DialogDescription>
      </DialogHeader>
      <div className={styles.actions}>
        <Button render={<Link to={sessionHref} />}><MessageSquare aria-hidden="true" />{attention ? t("在 Chat 处理", "Respond in Chat") : t("打开 Chat", "Open Chat")}</Button>
        <Button variant="outline" disabled={!canStop || pending} onClick={onStop}><Square aria-hidden="true" />{pending ? t("正在停止…", "Stopping…") : t("停止生成", "Stop generation")}</Button>
        {panelTerminal && <Button variant="outline" onClick={onPanelTerminal}><Terminal aria-hidden="true" />{t("在面板中打开终端", "Open terminal in panel")}</Button>}
        {terminalHref && <Button variant="outline" render={<Link to={terminalHref} />}><Terminal aria-hidden="true" />{t("在 Chat 打开终端", "Open terminal in Chat")}</Button>}
        {newSessionHref && <Button variant="outline" render={<Link to={newSessionHref} />}>{newSessionChatOnly ? t("新建仅对话会话", "New chat-only session") : t("用此文件夹新建会话", "New session in this folder")}</Button>}
        <Button variant="ghost" onClick={onCopy}>{t("复制会话 ID", "Copy Session ID")}</Button>
        <Button variant="ghost" onClick={onRefresh}><RefreshCw aria-hidden="true" />{t("刷新运行输出", "Refresh run output")}</Button>
      </div>
      <DialogFooter><Button variant="outline" onClick={onClose}>{t("关闭", "Close")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
