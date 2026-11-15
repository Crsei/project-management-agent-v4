import { Component, StrictMode, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import MobileDemo from "./index"
import "./standalone.css"

class DemoBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <main className="mobile-demo-recovery"><h1>设计预览未能显示</h1><p>没有提交任何业务操作。可重新加载演示；页内草稿会重置。</p><button type="button" onClick={() => window.location.reload()}>重新加载预览</button></main>
    return this.props.children
  }
}
const container = document.getElementById("root")
if (!container) throw new Error("Missing mobile Demo root")
createRoot(container).render(<StrictMode>{import.meta.env.PM_LAB_ENABLED
  ? <DemoBoundary><MobileDemo /></DemoBoundary>
  : <main className="mobile-demo-recovery"><h1>设计预览未启用</h1><p>此入口仅用于显式启用 Lab 的受控展示产物。</p></main>}</StrictMode>)
