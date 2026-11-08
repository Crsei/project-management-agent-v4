import { Component, type ReactNode } from "react"
import { Link } from "react-router"
import { LoaderCircle } from "lucide-react"
import { useI18n } from "@/lib/i18n-provider"

export function RouteLoading({ message, returnTo = "/pm" }: { message?: string; returnTo?: string }) {
  const en = useI18n().locale === "en"
  return <main className="route-feedback" aria-busy="true">
    <p role="status"><LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{message ?? (en ? "Loading workspace…" : "正在加载工作区…")}</p>
    <Link to={returnTo}>{en ? "Back to Project Management" : "返回项目管理"}</Link>
  </main>
}

function RouteFailure({ returnTo }: { returnTo: string }) {
  const en = useI18n().locale === "en"
  return <main className="route-feedback">
    <h1>{en ? "Page unavailable" : "页面暂时不可用"}</h1>
    <p role="alert">{en ? "This page could not be loaded. Reload to retry; no message or operation will be resubmitted." : "无法加载此页面。可重新加载后重试；不会重新提交消息或操作。"}</p>
    <button type="button" onClick={() => window.location.reload()}>{en ? "Reload and retry" : "重新加载并重试"}</button>
    <Link to={returnTo}>{en ? "Back to Project Management" : "返回项目管理"}</Link>
  </main>
}

/** Navigation clears only a failed boundary, not the mounted runtime on normal routes. */
export class RouteErrorBoundary extends Component<{ children: ReactNode; resetKey: string; returnTo?: string }, { failed: boolean; resetKey: string }> {
  state = { failed: false, resetKey: this.props.resetKey }
  static getDerivedStateFromError() { return { failed: true } }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { resetKey: string }) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey }
  }
  render() {
    return this.state.failed ? <RouteFailure returnTo={this.props.returnTo ?? "/pm"} /> : this.props.children
  }
}
