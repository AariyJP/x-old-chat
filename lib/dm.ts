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

type XApiUser = {
  id_str?: string
  name?: string
  screen_name?: string
  profile_image_url_https?: string
}

type XApiUrlEntity = {
  url?: string
  expanded_url?: string
  display_url?: string
}

type XApiEntities = {
  urls?: XApiUrlEntity[]
}

type XApiMessageData = {
  id?: string
  time?: string
  sender_id?: string
  recipient_id?: string
  text?: string
  entities?: XApiEntities
}

type XApiReaction = {
  emoji_reaction?: string
  sender_id?: string
}

type XApiMessage = {
  id?: string
  time?: string
  conversation_id?: string
  message_data?: XApiMessageData
  message_reactions?: XApiReaction[]
}

type XApiEntry = {
  message?: XApiMessage
}

type XApiParticipant = {
  user_id?: string
  last_read_event_id?: string
}

type XApiConversation = {
  conversation_id?: string
  name?: string
  participants?: XApiParticipant[]
  sort_timestamp?: string
  max_entry_id?: string
  last_read_event_id?: string
  read_only?: boolean
}

type XApiInboxResponse = {
  inbox_initial_state?: {
    entries?: XApiEntry[]
    users?: Record<string, XApiUser>
    conversations?: Record<string, XApiConversation>
  }
}

type XApiConversationResponse = {
  conversation_timeline?: {
    entries?: XApiEntry[]
    users?: Record<string, XApiUser>
    min_entry_id?: string
    status?: string
  }
}

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

async function getJson<T>(url: string): Promise<T> {
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

  return (await response.json()) as T
}

function parseUsers(raw?: Record<string, XApiUser>): Record<string, DmUser> {
  const users: Record<string, DmUser> = {}
  for (const value of Object.values(raw ?? {})) {
    const id = value.id_str
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

function toSegments(text: string, entities?: XApiEntities): DmTextSegment[] {
  const urls = entities?.urls ?? []
  return text
    .split(TCO_PATTERN)
    .filter((part) => part.length > 0)
    .map((part) => {
      const match = urls.find((entity) => entity.url === part)
      return match
        ? {
            text: match.display_url ?? part,
            href: match.expanded_url ?? part
          }
        : { text: part }
    })
}

function parseMessage(entry: XApiEntry): DmMessage | null {
  const message = entry.message
  const data = message?.message_data
  if (!message?.id || !data) {
    return null
  }
  return {
    id: message.id,
    time: Number(data.time ?? message.time ?? 0),
    senderId: data.sender_id ?? "",
    segments: toSegments(data.text ?? "", data.entities),
    reactions: (message.message_reactions ?? [])
      .map((reaction) => reaction.emoji_reaction)
      .filter((emoji): emoji is string => typeof emoji === "string")
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
  const body = await getJson<XApiInboxResponse>(
    `${API_BASE}/1.1/dm/inbox_initial_state.json?${DM_INBOX_QUERY}`
  )
  const state = body.inbox_initial_state ?? {}

  const previews = new Map<string, DmMessage>()
  for (const entry of state.entries ?? []) {
    const conversationId = entry.message?.conversation_id
    const message = parseMessage(entry)
    if (!conversationId || !message) {
      continue
    }
    const current = previews.get(conversationId)
    if (!current || message.time > current.time) {
      previews.set(conversationId, message)
    }
  }

  const conversations = Object.values(state.conversations ?? {})
    .map((conversation): DmConversation | null => {
      const id = conversation.conversation_id
      if (!id) {
        return null
      }
      const participants = conversation.participants ?? []
      const mine = participants.find((entry) => entry.user_id === myId)
      const partner = participants.find((entry) => entry.user_id !== myId)
      const preview = previews.get(id)
      return {
        id,
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
    .filter((conversation): conversation is DmConversation => conversation !== null)
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
  const body = await getJson<XApiConversationResponse>(
    `${API_BASE}/1.1/dm/conversation/${encodeURIComponent(conversationId)}.json?${query}`
  )
  const timeline = body.conversation_timeline ?? {}

  const messages = (timeline.entries ?? [])
    .map(parseMessage)
    .filter((message): message is DmMessage => message !== null)
    .sort((left, right) => left.time - right.time)

  return {
    messages,
    users: parseUsers(timeline.users),
    minEntryId: timeline.min_entry_id ?? null,
    atEnd: timeline.status === "AT_END"
  }
}
