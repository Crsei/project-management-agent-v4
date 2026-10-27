import { defaultShouldDehydrateQuery, QueryClient } from "@tanstack/react-query"

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: false,
        refetchOnWindowFocus: false,
      },
      dehydrate: {
        shouldDehydrateQuery: defaultShouldDehydrateQuery,
      },
    },
  })
}
