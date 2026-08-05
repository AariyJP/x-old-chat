import { USER_BY_SCREEN_NAME_QUERY_ID_FALLBACK } from "~lib/constants"

const PATTERNS = [
  /queryId:"([a-zA-Z0-9_-]{16,})",operationName:"UserByScreenName"/,
  /operationName:"UserByScreenName",[^}]*?queryId:"([a-zA-Z0-9_-]{16,})"/
]

let cached: string | null = null

function extractFrom(source: string): string | null {
  for (const pattern of PATTERNS) {
    const queryId = source.match(pattern)?.[1]
    if (queryId) {
      return queryId
    }
  }
  return null
}

export async function getUserByScreenNameQueryId(): Promise<string> {
  if (cached) {
    return cached
  }

  const sources = Array.from(
    document.querySelectorAll<HTMLScriptElement>("script[src]")
  )
    .map((script) => script.src)
    .filter((src) => src.includes("abs.twimg.com"))

  for (const src of sources) {
    try {
      const response = await fetch(src)
      if (!response.ok) {
        continue
      }
      const found = extractFrom(await response.text())
      if (found) {
        cached = found
        return found
      }
    } catch {
      continue
    }
  }

  cached = USER_BY_SCREEN_NAME_QUERY_ID_FALLBACK
  return cached
}
