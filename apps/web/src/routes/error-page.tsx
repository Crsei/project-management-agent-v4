import { useParams } from "react-router"
import {
  ErrorPageScreen,
  isHttpErrorCode,
} from "@/components/blocks/error-page"

/**
 * Standalone error routes (`/errors/401|403|404|500|503`). A retry reloads the
 * document because these routes have no owning service operation to re-run.
 */
export function PmErrorRoute() {
  const { code: rawCode } = useParams<{ code: string }>()
  const parsed = Number(rawCode)
  const code = isHttpErrorCode(parsed) ? parsed : 404
  return (
    <ErrorPageScreen
      code={code}
      onRetry={
        code === 500 || code === 503
          ? () => window.location.reload()
          : undefined
      }
    />
  )
}
