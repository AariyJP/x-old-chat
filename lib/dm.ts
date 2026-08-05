import {
  ApiError,
  buildHeaders,
  isRateLimited,
  parseRateLimit
} from "~lib/api"
import {
  API_BASE,
  DM_CONVERSATION_QUERY,
  DM_INBOX_QUERY
} from "~lib/constants"

export type DmUser = {
  id: string
  name: string
  screenName: string
  avatarUrl: string | null
}

export type DmTextSegment = {
  text: string
  href?: string
}

export type DmMessage = {
  id: string
  time: number
  senderId: string
  segments: DmTextSegment[]
  reactions: string[]
}

export type DmConversation = {
  id: string
  name: string | null
  partnerId: string | null
  preview: string
  sortTime: number
  unread: boolean
  readOnly: boolean
}

export type DmInbox = {
  conversations: DmConversation[]
  users: Record<string, DmUser>
}

export type DmThread = {
  messages: DmMessage[]
  users: Record<string, DmUser>
  minEntryId: string | null
  atEnd: boolean
}

const TCO_PATTERN = /(https:\/\/t\.co\/[A-Za-z0-9]+)/g

async function getJson(url: string): Promise<any> {
  let response: Response
  try {
    response = await fetch(url, {
      credentials: "include",
      headers: buildHeaders(false)
    })
  } catch {
    throw new ApiError("通信に失敗しました。再試行してください。", "network")
  }

  if (isRateLimited(response)) {
    throw new ApiError(
      "取得回数の上限に達しました。しばらく待って再試行してください。",
      "rate_limit",
      parseRateLimit(response)
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError("認証エラー。x.comに再ログインしてください。", "auth")
  }
  if (!response.ok) {
    throw new ApiError("メッセージの取得に失敗しました。", "unknown")
  }

  return response.json()
}

function parseUsers(raw: unknown): Record<string, DmUser> {
  const users: Record<string, DmUser> = {}
  for (const value of Object.values((raw ?? {}) as Record<string, any>)) {
    const id = value?.id_str
    if (!id) {
      continue
    }
    users[id] = {
      id,
      name: value.name ?? value.screen_name ?? id,
      screenName: value.screen_name ?? "",
      avatarUrl: value.profile_image_url_https ?? null
    }
  }
  return users
}

function toSegments(text: string, entities: any): DmTextSegment[] {
  const urls: any[] = entities?.urls ?? []
  return text
    .split(TCO_PATTERN)
    .filter((part) => part.length > 0)
    .map((part) => {
      const match = urls.find((url) => url?.url === part)
      return match
        ? {
            text: match.display_url ?? part,
            href: match.expanded_url ?? part
          }
        : { text: part }
    })
}

function parseMessage(entry: any): DmMessage | null {
  const message = entry?.message
  const data = message?.message_data
  if (!message?.id || !data) {
    return null
  }
  return {
    id: String(message.id),
    time: Number(data.time ?? message.time ?? 0),
    senderId: data.sender_id ?? "",
    segments: toSegments(data.text ?? "", data.entities),
    reactions: (message.message_reactions ?? [])
      .map((reaction: any) => reaction?.emoji_reaction)
      .filter((emoji: unknown): emoji is string => typeof emoji === "string")
  }
}

function isUnread(maxEntryId?: string, lastReadEventId?: string): boolean {
  if (!maxEntryId || !lastReadEventId) {
    return false
  }
  try {
    return BigInt(maxEntryId) > BigInt(lastReadEventId)
  } catch {
    return false
  }
}

export async function fetchInbox(myId: string): Promise<DmInbox> {
  const body = await getJson(
    `${API_BASE}/1.1/dm/inbox_initial_state.json?${DM_INBOX_QUERY}`
  )
  const state = body?.inbox_initial_state ?? {}

  const previews = new Map<string, DmMessage>()
  for (const entry of state.entries ?? []) {
    const conversationId = entry?.message?.conversation_id
    const message = parseMessage(entry)
    if (!conversationId || !message) {
      continue
    }
    const current = previews.get(conversationId)
    if (!current || message.time > current.time) {
      previews.set(conversationId, message)
    }
  }

  const conversations = Object.values(
    (state.conversations ?? {}) as Record<string, any>
  )
    .map((conversation): DmConversation => {
      const participants: any[] = conversation.participants ?? []
      const mine = participants.find((entry) => entry?.user_id === myId)
      const partner = participants.find((entry) => entry?.user_id !== myId)
      const preview = previews.get(conversation.conversation_id)
      return {
        id: conversation.conversation_id,
        name: conversation.name ?? null,
        partnerId: partner?.user_id ?? null,
        preview: preview
          ? preview.segments.map((segment) => segment.text).join("")
          : "",
        sortTime: Number(conversation.sort_timestamp ?? 0),
        unread: isUnread(
          conversation.max_entry_id,
          mine?.last_read_event_id ?? conversation.last_read_event_id
        ),
        readOnly: conversation.read_only === true
      }
    })
    .sort((left, right) => right.sortTime - left.sortTime)

  return { conversations, users: parseUsers(state.users) }
}

export async function fetchConversation(
  conversationId: string,
  maxId?: string
): Promise<DmThread> {
  const query = maxId
    ? `${DM_CONVERSATION_QUERY}&max_id=${encodeURIComponent(maxId)}`
    : DM_CONVERSATION_QUERY
  const body = await getJson(
    `${API_BASE}/1.1/dm/conversation/${encodeURIComponent(conversationId)}.json?${query}`
  )
  const timeline = body?.conversation_timeline ?? {}

  const messages = (timeline.entries ?? [])
    .map(parseMessage)
    .filter((message: DmMessage | null): message is DmMessage => message !== null)
    .sort((left: DmMessage, right: DmMessage) => left.time - right.time)

  return {
    messages,
    users: parseUsers(timeline.users),
    minEntryId: timeline.min_entry_id ?? null,
    atEnd: timeline.status === "AT_END"
  }
}
