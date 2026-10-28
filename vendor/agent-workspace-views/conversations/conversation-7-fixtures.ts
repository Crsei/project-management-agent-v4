import type { ComposerDemoSource } from "../demo-source"
import type { ChangedFile } from "./resource-model"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
export const conversation7Scenarios = [
  ...commonScenarios,
  { id: "preview-error", name: { "zh-CN": "预览失败", en: "Preview error" } },
] as const
export type Conversation7Scenario = CommonScenario | "preview-error"
export interface Conversation7Fixture {
  source: ComposerDemoSource
  html: string
  files: ChangedFile[]
}
export const mainlineHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'; base-uri 'none'"><title>Mainline landing page · local static fixture</title><style>
:root{color-scheme:light dark}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font:14px/1.6 system-ui;background:Canvas;color:CanvasText}a{color:inherit;text-decoration:none}nav{display:flex;align-items:center;gap:20px;margin:24px auto;padding:12px 20px;max-width:820px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:14px}nav strong{margin-right:auto}.cta{display:inline-block;border-radius:8px;padding:10px 18px;background:CanvasText;color:Canvas;font-weight:600}header{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:40px;align-items:start;padding:64px 24px 40px;text-align:left;max-width:1120px;margin:auto}header>div{min-width:0}.eyebrow{font-size:11px;letter-spacing:.15em;color:color-mix(in srgb,CanvasText 65%,transparent)}h1{font-size:clamp(32px,5vw,52px);line-height:1.1;letter-spacing:-.04em;margin:20px 0}header p{max-width:470px;margin:20px 0;color:color-mix(in srgb,CanvasText 65%,transparent)}.heroActions{display:flex;flex-wrap:wrap;gap:8px;margin-top:28px}.cta.secondary{background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 18%,transparent)}.product{max-width:1072px;margin:0 24px 32px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:12px;display:grid;grid-template-columns:150px 1fr;text-align:left;min-height:260px;box-shadow:0 16px 60px color-mix(in srgb,CanvasText 8%,transparent)}.side{padding:20px;background:color-mix(in srgb,CanvasText 3%,Canvas);border-right:1px solid color-mix(in srgb,CanvasText 14%,transparent)}.side p{font-size:12px;margin:12px 0}.board{padding:20px}.columns{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.issue{border:1px solid color-mix(in srgb,CanvasText 14%,transparent);padding:12px;margin:10px 0;border-radius:6px;font-size:12px}.features{display:grid;grid-template-columns:1fr;gap:24px;border-left:1px dashed color-mix(in srgb,CanvasText 14%,transparent);padding-left:28px}.features article{display:grid;grid-template-columns:18px minmax(0,1fr);column-gap:12px}.features svg{width:18px;height:18px;margin-top:4px;grid-row:1/3;fill:none;stroke:currentColor;stroke-width:1.5}.features h2{font-size:14px;line-height:24px;margin:0}.features p{font-size:11px;line-height:18px;margin:2px 0 0;color:color-mix(in srgb,CanvasText 65%,transparent)}.brands{text-align:center;padding:32px 24px}.brands div{display:flex;justify-content:center;gap:40px;font-size:22px;font-weight:600;padding:24px 0}.about{max-width:720px;margin:64px auto;padding:0 24px}.about h2{font-size:32px;letter-spacing:-.03em}.about li{padding:12px 0;border-bottom:1px solid color-mix(in srgb,CanvasText 14%,transparent)}details{border-bottom:1px solid color-mix(in srgb,CanvasText 14%,transparent);padding:12px 0}summary{cursor:pointer}footer{display:flex;justify-content:space-between;max-width:820px;margin:64px auto 0;padding:24px;border-top:1px solid color-mix(in srgb,CanvasText 14%,transparent);font-size:12px}@media(min-width:1120px){.product{margin-left:auto;margin-right:auto}}@media(max-width:780px){header{grid-template-columns:1fr;padding-top:40px;gap:32px}.features{grid-template-columns:repeat(2,minmax(0,1fr));border-left:0;padding-left:0}nav{margin:12px;gap:12px}.brands div{gap:20px;font-size:18px}}@media(max-width:480px){nav{flex-wrap:wrap}nav strong{width:100%}header{padding-top:40px}.product{grid-template-columns:1fr}.side{display:none}.columns{grid-template-columns:1fr}.features{grid-template-columns:1fr}.brands div{flex-wrap:wrap}.about h2{font-size:26px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style></head><body><nav aria-label="Mainline"><strong>◈ Mainline</strong><a href="about:srcdoc#features">Features</a><a href="about:srcdoc#about">About</a><a href="about:srcdoc#pricing">Pricing</a><a href="about:srcdoc#faq">FAQ</a><a class="cta" href="about:srcdoc#template">Get started</a></nav><header><div><span class="eyebrow">OPEN-SOURCE PRODUCT OPERATIONS</span><h1>Mainline Next.js template</h1><p>An open-source website template built with shadcn/ui, Tailwind CSS, and Next.js.</p><div class="heroActions"><a class="cta" href="about:srcdoc#template">Get template</a><a class="cta secondary" href="about:srcdoc#template">Built by shadcnblocks.com →</a></div></div><section id="features" class="features"><article><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7"/><circle cx="9" cy="9" r="1"/></svg><h2>Tailored workflows</h2><p>Track progress across custom issue flows for your team.</p></article><article><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="7" cy="7" r="5"/><circle cx="11" cy="11" r="5"/></svg><h2>Cross-team projects</h2><p>Collaborate across teams and departments.</p></article><article><svg viewBox="0 0 18 18" aria-hidden="true"><path d="m9 2 7 7-7 7-7-7Z"/></svg><h2>Milestones</h2><p>Break projects down into concrete phases.</p></article><article><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3 8v7M7 3v12M11 6v9M15 10v5"/></svg><h2>Progress insights</h2><p>Track scope, velocity, and progress over time.</p></article></section></header><div class="product" role="img" aria-label="Mainline product workspace showing an issue board"><div class="side"><strong>◈ Mainline</strong><p>Inbox</p><p>My issues</p><p>Workspace</p><p>Projects</p><p>Product roadmap</p></div><div class="board"><strong>Product roadmap</strong><p>Website launch · Cycle 12</p><div class="columns"><div>Backlog<div class="issue">Research onboarding</div><div class="issue">Review team workflow</div></div><div>In progress<div class="issue">Design product overview</div><div class="issue">Build feature grid</div></div><div>Done<div class="issue">Publish design system</div><div class="issue">Plan milestones</div></div></div></div></div><section class="brands"><span class="eyebrow">DESIGNED FOR TEAMS SHIPPING THEIR BEST WORK</span><div><span>Mercury</span><span>Linear</span><span>Arc</span><span>Watershed</span></div></section><section id="about" class="about"><h2>Made for modern product teams</h2><p>Mainline is built on the habits that make excellent product teams successful: staying focused, moving quickly, and aiming for high-quality work.</p><ul><li>Purpose-built for product development</li><li>Manage projects end-to-end</li><li>Build momentum and healthy habits</li></ul></section><section id="pricing" class="about"><h2>Open source. Free to build.</h2><p>Adapt the template to your team’s workflow. This local preview does not create an account or process payment.</p></section><section id="faq" class="about"><h2>FAQ</h2><details><summary>What is included?</summary><p>A responsive marketing layout with navigation, hero, feature grid, brands and footer.</p></details><details><summary>Does this preview execute generated code?</summary><p>No. It is a fixed, script-free local HTML fixture.</p></details></section><section id="template" class="about"><h2>Get the Mainline template</h2><p>Local preview only. Template attribution: shadcnblocks.com. No external service, signup or generated JSX is executed here.</p><a href="about:srcdoc#features">Explore the features ↑</a></section><footer><span>© Mainline</span><span>Free template by shadcnblocks.com · local static adaptation</span></footer></body></html>`
export function createConversation7Fixture(
  scenario: Conversation7Scenario,
): Conversation7Fixture {
  const source = createThreadFixture(
    "conversation-7",
    scenario,
    {
      "zh-CN":
        "以免费 Mainline 营销模板为起点，给我完整的响应式 landing page。",
      en: "Use the free Mainline marketing template as the starting point and give me a complete responsive landing page.",
    },
    {
      "zh-CN":
        "保留营销层级，整理导航、hero、产品工作区、功能、品牌、正文和 footer。右侧展示固定安全 HTML；不执行生成 JSX 或加载远程网站。",
      en: "The marketing hierarchy retains navigation, hero, product workspace, features, brands, body and footer. The workspace presents fixed safe HTML, without executing generated JSX or loading remote sites.",
    },
  )
  if (scenario !== "empty")
    source.sessions[0].messages.push(
      {
        id: "c7-show",
        role: "user",
        text: {
          "zh-CN": "继续对话时保持预览，切换 Code 时保留仓库。",
          en: "Keep the preview open while we continue, and retain the repository when switching to Code.",
        },
      },
      {
        id: "c7-ready",
        role: "assistant",
        text: {
          "zh-CN":
            "预览在宽工作区中保持挂载。Code 显示三个文件及只读源码，切换不会替换会话或草稿。",
          en: "The preview is mounted in the wide workspace. Code shows the three files and read-only source without replacing the thread or draft.",
        },
      },
      {
        id: "c7-check",
        role: "user",
        text: {
          "zh-CN": "检查 desktop、tablet、phone 预览。",
          en: "Check desktop, tablet and phone preview states.",
        },
      },
      {
        id: "c7-verified",
        role: "assistant",
        text: {
          "zh-CN":
            "### 预览视口\n- Desktop：完整导航、hero、产品区与功能网格\n- Tablet：两列功能网格\n- Phone：单列布局\n\n视口控件只改变固定 HTML 的呈现宽度；不连接浏览器后端。原站直接 React 的实现改为明确脚本禁用的安全静态 iframe。",
          en: "### Preview viewports\n- Desktop: navigation, hero, product workspace and feature grid\n- Tablet: two-column features\n- Phone: single-column layout\n\nControls only resize fixed HTML; no browser backend is connected. The reference’s direct React rendering is deliberately replaced by a script-disabled static iframe.",
        },
      },
    )
  return {
    source,
    html: mainlineHtml,
    files: [
      {
        fileId: "page",
        path: "src/app/page.tsx",
        kind: "added",
        content:
          'import { Hero } from "@/components/marketing/hero"\nimport { Features } from "@/components/marketing/features"\nexport default function Page() {\n  return <main><Hero /><Features /><section id="about">Made for modern product teams</section><footer>© Mainline</footer></main>\n}',
        lines: [],
      },
      {
        fileId: "hero",
        path: "src/components/marketing/hero.tsx",
        kind: "added",
        content:
          'export function Hero() {\n  return <header><p>OPEN-SOURCE PRODUCT OPERATIONS</p><h1>Mainline Next.js template</h1><p>An open-source website template built with shadcn/ui, Tailwind CSS, and Next.js.</p><a href="#template">Get template</a></header>\n}',
        lines: [],
      },
      {
        fileId: "features",
        path: "src/components/marketing/features.tsx",
        kind: "added",
        content:
          'const features = ["Tailored workflows", "Cross-team projects", "Milestones", "Progress insights"]\nexport function Features() {\n  return <section id="features">{features.map(title => <article key={title}><h2>{title}</h2></article>)}</section>\n}',
        lines: [],
      },
    ],
  }
}
