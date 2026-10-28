import { analyzeTokens, TokenInputError } from "./controller"
import type { TokenRequest, TokenResponse } from "./controller"
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TokenRequest>) => void) | null
  postMessage: (response: TokenResponse) => void
}
scope.onmessage = async ({ data }) => {
  try {
    scope.postMessage({
      operationId: data.operationId,
      result: await analyzeTokens(data),
    })
  } catch (error) {
    scope.postMessage({
      operationId: data.operationId,
      error:
        error instanceof TokenInputError ? error.failure : { code: "engine" },
    })
  }
}
