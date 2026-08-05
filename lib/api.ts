import {
  API_BASE,
  BEARER_TOKEN,
  DM_NEW2_QUERY,
  USER_BY_SCREEN_NAME_FEATURES
} from "~lib/constants"
import { getCsrfToken } from "~lib/cookies"
import { getUserByScreenNameQueryId } from "~lib/queryId"

export type ResolvedUser = {
  restId: string
  name: string
  screenName: string
  avatarUrl: string | null
  canDm: boolean
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "not_found"
      | "auth"
      | "blank"
      | "rate_limit"
      | "network"
      | "unknown",
    readonly resetAt?: Date
  ) {
    super(message)
  }
}

export function describeApiError(caught: unknown): string {
  if (caught instanceof ApiError) {
    if (caught.resetAt) {
      return `${caught.message}（解除予定: ${caught.resetAt.toLocaleTimeString()}）`
    }
    return caught.message
  }
  return "予期しないエラーが発生しました。"
}

export function buildHeaders(withContentType: boolean): HeadersInit {
  const csrf = getCsrfToken()
  if (!csrf) {
    throw new ApiError(
      "認証エラー。x.comに再ログインしてください。",
      "auth"
    )
  }
  const headers: Record<string, string> = {
    authorization: BEARER_TOKEN,
    "x-csrf-token": csrf,
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes"
  }
  if (withContentType) {
    headers["content-type"] = "application/json"
  }
  return headers
}

export function parseRateLimit(response: Response): Date | undefined {
  const reset = response.headers.get("x-rate-limit-reset")
  return reset ? new Date(Number(reset) * 1000) : undefined
}

export function isRateLimited(response: Response): boolean {
  return (
    response.status === 429 ||
    response.headers.get("x-rate-limit-remaining") === "0"
  )
}

export async function resolveUser(
  screenName: string
): Promise<ResolvedUser> {
  const queryId = await getUserByScreenNameQueryId()
  const params = new URLSearchParams({
    variables: JSON.stringify({
      screen_name: screenName,
      withGrokTranslatedBio: true
    }),
    features: JSON.stringify(USER_BY_SCREEN_NAME_FEATURES)
  })

  let response: Response
  try {
    response = await fetch(
      `${API_BASE}/graphql/${queryId}/UserByScreenName?${params}`,
      { credentials: "include", headers: buildHeaders(false) }
    )
  } catch {
    throw new ApiError("通信に失敗しました。再試行してください。", "network")
  }

  if (isRateLimited(response)) {
    throw new ApiError(
      "送信回数の上限に達しました。しばらく待って再試行してください。",
      "rate_limit",
      parseRateLimit(response)
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError("認証エラー。x.comに再ログインしてください。", "auth")
  }
  if (!response.ok) {
    throw new ApiError("ユーザー情報の取得に失敗しました。", "unknown")
  }

  const body = await response.json()
  const result = body?.data?.user?.result
  const restId = result?.rest_id
  if (!restId) {
    throw new ApiError("ユーザーが見つかりません。", "not_found")
  }

  const legacy = result.legacy ?? {}
  const core = result.core ?? {}
  return {
    restId,
    name: core.name ?? legacy.name ?? screenName,
    screenName: core.screen_name ?? legacy.screen_name ?? screenName,
    avatarUrl:
      result.avatar?.image_url ?? legacy.profile_image_url_https ?? null,
    canDm: result.dm_permissions?.can_dm === true
  }
}

export async function sendDirectMessage(
  conversationId: string,
  text: string
): Promise<void> {
  if (text.trim().length === 0) {
    throw new ApiError("メッセージ本文を入力してください。", "blank")
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE}/1.1/dm/new2.json?${DM_NEW2_QUERY}`, {
      method: "POST",
      credentials: "include",
      headers: buildHeaders(true),
      body: JSON.stringify({
        conversation_id: conversationId,
        recipient_ids: true,
        request_id: globalThis.crypto.randomUUID(),
        text,
        cards_platform: "Web-12",
        include_cards: 1,
        include_quote_count: true,
        dm_users: true
      })
    })
  } catch {
    throw new ApiError("通信に失敗しました。再試行してください。", "network")
  }

  if (isRateLimited(response)) {
    throw new ApiError(
      "送信回数の上限に達しました。しばらく待って再試行してください。",
      "rate_limit",
      parseRateLimit(response)
    )
  }

  const body = await response.json().catch(() => null)

  if (!response.ok) {
    const errors: { code?: number; message?: string }[] = body?.errors ?? []
    if (errors.some((error) => error.code === 151)) {
      throw new ApiError("メッセージ本文を入力してください。", "blank")
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApiError("認証エラー。x.comに再ログインしてください。", "auth")
    }
    throw new ApiError(
      errors[0]?.message ?? "送信に失敗しました。",
      "unknown"
    )
  }

  if (!body?.entries?.some((entry: { message?: unknown }) => entry.message)) {
    throw new ApiError("送信結果を確認できませんでした。", "unknown")
  }
}
