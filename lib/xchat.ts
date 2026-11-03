import type {
  AttachmentInfo,
  DecryptEventsResult,
  Event,
  SendPayload,
  SigningKeyEntry
} from "@xdevplatform/chat-xdk"
import initChatXdk, {
  Chat,
  __juiceboxClientConfig,
  __setErrorClass,
  base64ToBytes,
  bytesToBase64
} from "@xdevplatform/chat-xdk/pkg/chat_xdk_wasm.js"
import * as juicebox from "juicebox-sdk/juicebox-sdk_bg.js"
import juiceboxWasmUrl from "url:juicebox-sdk/juicebox-sdk_bg.wasm"

import {
  ApiError,
  buildHeaders,
  isRateLimited,
  parseRateLimit
} from "~lib/api"
import {
  XCHAT_GRAPHQL_BASE,
  XCHAT_KEYS_MESSAGE,
  XCHAT_OPERATIONS
} from "~lib/constants"
import {
  formatDuration,
  type DmMessage,
  type DmTextSegment,
  type DmUser
} from "~lib/dm"

declare module "@xdevplatform/chat-xdk/pkg/chat_xdk_wasm.js" {
  export function __juiceboxClientConfig(configJson: string): {
    sdkConfig: unknown
    maxGuessCount: number
  }
  export function __setErrorClass(errorClass: unknown): void
}

type JuiceboxConfig = {
  token_map?: { key?: string; value?: { token?: string } }[]
}

type PublicKey = {
  version: string
  publicKey: string
  signingPublicKey: string
  identityPublicKeySignature: string
  tokenMap?: JuiceboxConfig
}

type RawUser = {
  rest_id?: string
  result?: {
    rest_id?: string
    core?: { name?: string; screen_name?: string }
    avatar?: { image_url?: string }
    get_public_keys?: {
      public_keys_with_token_map?: {
        public_key_with_metadata?: {
          version?: string
          public_key?: {
            public_key?: string
            signing_public_key?: string
            identity_public_key_signature?: string
          }
        }
        token_map?: JuiceboxConfig
      }[]
    }
  }
}

type RawInboxItem = {
  latest_message_events?: unknown
  latest_conversation_key_change_events?: unknown
  conversation_detail?: {
    __typename?: string
    conversation_id?: string
    group_metadata?: { group_name?: string }
    participants_results?: RawUser[]
  }
}

type StoredKeys = {
  keys: string
  version: string
}

type Session = {
  userId: string
  chat: Chat
  signingKeys: SigningKeyEntry[]
  knownSigners: Set<string>
  usersWithKeys: Set<string>
  participants: Map<string, string[]>
  messages: Map<string, Map<string, DmMessage>>
  oldest: Map<string, string>
}

export type XChatConversation = {
  id: string
  isGroup: boolean
  groupName: string | null
  participants: DmUser[]
  messages: DmMessage[]
}

class ChatXdkError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly guessesRemaining: number | null = null
  ) {
    super(message)
  }
}

const URL_PATTERN = /(https?:\/\/[^\s]+)/

let session: Session | null = null
let chatXdkReady: Promise<void> | null = null
let juiceboxReady: Promise<void> | null = null

async function wasmBytes(url: string): Promise<ArrayBuffer> {
  return (await fetch(url)).arrayBuffer()
}

function loadChatXdk(): Promise<void> {
  chatXdkReady ??= (async () => {
    await initChatXdk()
    __setErrorClass(ChatXdkError)
  })().catch((caught) => {
    chatXdkReady = null
    throw caught
  })
  return chatXdkReady
}

function loadJuicebox(): Promise<void> {
  juiceboxReady ??= (async () => {
    const { instance } = await WebAssembly.instantiate(
      await wasmBytes(juiceboxWasmUrl),
      { "./juicebox-sdk_bg.js": juicebox as unknown as WebAssembly.ModuleImports }
    )
    juicebox.__wbg_set_wasm(instance.exports)
  })().catch((caught) => {
    juiceboxReady = null
    throw caught
  })
  return juiceboxReady
}

function storeKeys(
  userId: string,
  keys?: StoredKeys | null
): Promise<StoredKeys | null> {
  return chrome.runtime.sendMessage({ type: XCHAT_KEYS_MESSAGE, userId, keys })
}

async function query<T>(
  operation: keyof typeof XCHAT_OPERATIONS,
  variables: Record<string, unknown>,
  mutation = false
): Promise<T> {
  const queryId = XCHAT_OPERATIONS[operation]
  const url = `${XCHAT_GRAPHQL_BASE}/${queryId}/${operation}`
  let response: Response
  try {
    response = await fetch(
      mutation
        ? url
        : `${url}?${new URLSearchParams({ variables: JSON.stringify(variables) })}`,
      mutation
        ? {
            method: "POST",
            credentials: "include",
            headers: buildHeaders(true),
            body: JSON.stringify({ variables, queryId })
          }
        : { credentials: "include", headers: buildHeaders(false) }
    )
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
  const body = (await response.json().catch(() => null)) as { data?: T } | null
  if (!response.ok || !body?.data) {
    throw new ApiError(
      mutation
        ? "暗号化メッセージの送信に失敗しました。"
        : "暗号化チャットの取得に失敗しました。",
      "unknown"
    )
  }
  return body.data
}

function strings(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value]
  return items.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  )
}

function isLess(left: string, right: string): boolean {
  return BigInt(left) < BigInt(right)
}

function parseUser(raw: RawUser): DmUser | null {
  const id = raw.rest_id ?? raw.result?.rest_id
  if (!id) {
    return null
  }
  return {
    id,
    name: raw.result?.core?.name ?? id,
    screenName: raw.result?.core?.screen_name ?? "",
    avatarUrl: raw.result?.avatar?.image_url ?? null
  }
}

async function fetchPublicKeys(
  ids: string[],
  includeJuiceboxTokens: boolean
): Promise<Map<string, PublicKey[]>> {
  const data = await query<{ user_results_by_rest_ids?: RawUser[] }>(
    "GetPublicKeysQuery",
    { ids, include_juicebox_tokens: includeJuiceboxTokens }
  )
  const keys = new Map<string, PublicKey[]>()
  for (const entry of data.user_results_by_rest_ids ?? []) {
    const userId = entry.rest_id ?? entry.result?.rest_id
    if (!userId) {
      continue
    }
    const items = entry.result?.get_public_keys?.public_keys_with_token_map
    keys.set(
      userId,
      (items ?? []).flatMap((item) => {
        const metadata = item.public_key_with_metadata
        if (!metadata?.version || !metadata.public_key) {
          return []
        }
        return [
          {
            version: metadata.version,
            publicKey: metadata.public_key.public_key ?? "",
            signingPublicKey: metadata.public_key.signing_public_key ?? "",
            identityPublicKeySignature:
              metadata.public_key.identity_public_key_signature ?? "",
            tokenMap: item.token_map
          }
        ]
      })
    )
  }
  return keys
}

function startSession(userId: string, chat: Chat, version: string): void {
  chat.setIdentity({ userId, signingKeyVersion: version })
  chat.setCacheKeys(true)
  chat.setRejectUnverified(false)
  session?.chat.free()
  session = {
    userId,
    chat,
    signingKeys: [],
    knownSigners: new Set(),
    usersWithKeys: new Set(),
    participants: new Map(),
    messages: new Map(),
    oldest: new Map()
  }
}

function recoverError(caught: unknown): ApiError {
  const failure =
    typeof caught === "object" && caught !== null
      ? (caught as { reason?: unknown; guesses_remaining?: unknown })
      : { reason: caught }
  if (failure.reason === 0) {
    const remaining =
      typeof failure.guesses_remaining === "number"
        ? `（残り${failure.guesses_remaining}回）`
        : ""
    return new ApiError(`PINが正しくありません。${remaining}`, "auth")
  }
  if (failure.reason === 4) {
    return new ApiError(
      "PINの試行回数の上限に達しました。しばらく待って再試行してください。",
      "rate_limit"
    )
  }
  return new ApiError("暗号化チャットの鍵を復元できませんでした。", "unknown")
}

export function isXChatUnlocked(userId: string): boolean {
  return session?.userId === userId
}

export async function restoreXChat(userId: string): Promise<boolean> {
  if (isXChatUnlocked(userId)) {
    return true
  }
  const stored = await storeKeys(userId)
  if (!stored) {
    return false
  }
  await loadChatXdk()
  const keys = base64ToBytes(stored.keys)
  const chat = new Chat()
  try {
    if (!keys) {
      throw new Error("invalid keys")
    }
    chat.importKeys({ keys, signingKeyVersion: stored.version })
  } catch {
    chat.free()
    await storeKeys(userId, null)
    return false
  } finally {
    keys?.fill(0)
  }
  startSession(userId, chat, stored.version)
  return true
}

export async function unlockXChat(userId: string, pin: string): Promise<void> {
  const versions = (await fetchPublicKeys([userId], true)).get(userId) ?? []
  const latest = versions.reduce<PublicKey | undefined>(
    (best, key) => (!best || isLess(best.version, key.version) ? key : best),
    undefined
  )
  const tokenMap = latest?.tokenMap?.token_map ?? []
  if (!latest || tokenMap.length === 0) {
    throw new ApiError(
      "暗号化チャットが未設定です。公式アプリで暗号化チャットとPINを設定してください。",
      "unknown"
    )
  }
  await Promise.all([loadChatXdk(), loadJuicebox()])

  const tokens = new Map(
    tokenMap.map((entry) => [
      (entry.key ?? "").toLowerCase().replace(/^0x/, ""),
      entry.value?.token
    ])
  )
  Object.assign(globalThis, {
    JuiceboxGetAuthToken: async (realmId: string | Uint8Array) => {
      const hex =
        typeof realmId === "string"
          ? realmId
          : Array.from(realmId, (byte) =>
              byte.toString(16).padStart(2, "0")
            ).join("")
      const token = tokens.get(hex.toLowerCase().replace(/^0x/, ""))
      if (!token) {
        throw new Error(`Juicebox token missing for realm ${hex}`)
      }
      return token
    }
  })

  const { sdkConfig } = __juiceboxClientConfig(JSON.stringify(latest.tokenMap))
  const client = new juicebox.Client(new juicebox.Configuration(sdkConfig), [])
  let secret: Uint8Array
  try {
    secret = await client.recover(
      new TextEncoder().encode(pin),
      new Uint8Array(0)
    )
  } catch (caught) {
    throw recoverError(caught)
  }

  const chat = new Chat()
  try {
    chat.importKeys({ keys: secret, signingKeyVersion: latest.version })
    await storeKeys(userId, {
      keys: bytesToBase64(secret),
      version: latest.version
    })
  } catch {
    chat.free()
    throw new ApiError("暗号化チャットの鍵を読み込めませんでした。", "unknown")
  } finally {
    secret.fill(0)
  }
  startSession(userId, chat, latest.version)
}

export async function lockXChat(userId: string): Promise<void> {
  if (session?.userId === userId) {
    session.chat.free()
    session = null
  }
  await storeKeys(userId, null)
}

function requireSession(): Session {
  if (!session) {
    throw new ApiError("暗号化チャットのPINを入力してください。", "auth")
  }
  return session
}

async function ensureSigningKeys(
  current: Session,
  userIds: string[]
): Promise<void> {
  const missing = [...new Set(userIds)].filter(
    (id) => !current.knownSigners.has(id)
  )
  if (missing.length === 0) {
    return
  }
  const keys = await fetchPublicKeys(missing, false)
  for (const userId of missing) {
    for (const key of keys.get(userId) ?? []) {
      current.signingKeys.push({
        userId,
        publicKeyVersion: key.version,
        publicKey: key.signingPublicKey,
        identityPublicKey: key.publicKey,
        identityPublicKeySignature: key.identityPublicKeySignature
      })
    }
    current.knownSigners.add(userId)
    if (keys.get(userId)?.length) {
      current.usersWithKeys.add(userId)
    }
  }
  current.chat.setSigningKeys(current.signingKeys)
}

function linkify(text: string): DmTextSegment[] {
  return text
    .split(URL_PATTERN)
    .map((part, index) =>
      index % 2 === 1 ? { text: part, href: part } : { text: part }
    )
    .filter((segment) => segment.text.length > 0)
}

type ThriftValue = number | boolean | Uint8Array | ThriftFields | null

type ThriftFields = Map<number, ThriftValue>

function parseThrift(bytes: Uint8Array): ThriftFields | null {
  let index = 0
  const take = (count: number): Uint8Array | null => {
    if (count < 0 || index + count > bytes.length) {
      return null
    }
    index += count
    return bytes.subarray(index - count, index)
  }
  const integer = (size: number): number | null => {
    const slice = take(size)
    if (!slice) {
      return null
    }
    const value = slice.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n)
    return Number(BigInt.asIntN(size * 8, value))
  }
  const repeat = (count: number | null, read: () => boolean): null | undefined => {
    if (count === null || count < 0) {
      return undefined
    }
    for (let i = 0; i < count; i++) {
      if (!read()) {
        return undefined
      }
    }
    return null
  }
  const value = (type: number): ThriftValue | undefined => {
    switch (type) {
      case 2: {
        const byte = take(1)?.[0]
        return byte === undefined ? undefined : byte !== 0
      }
      case 3:
        return integer(1) ?? undefined
      case 4:
        return take(8) ? null : undefined
      case 6:
        return integer(2) ?? undefined
      case 8:
        return integer(4) ?? undefined
      case 10:
        return integer(8) ?? undefined
      case 11: {
        const count = integer(4)
        return (count === null ? null : take(count)) ?? undefined
      }
      case 12:
        return fields() ?? undefined
      case 13: {
        const types = take(2)
        const count = integer(4)
        const [key, item] = types ?? []
        if (key === undefined || item === undefined) {
          return undefined
        }
        return repeat(
          count,
          () => value(key) !== undefined && value(item) !== undefined
        )
      }
      case 14:
      case 15: {
        const item = take(1)?.[0]
        const count = integer(4)
        if (item === undefined) {
          return undefined
        }
        return repeat(count, () => value(item) !== undefined)
      }
      default:
        return undefined
    }
  }
  const fields = (): ThriftFields | null => {
    const result: ThriftFields = new Map()
    for (;;) {
      const type = take(1)?.[0]
      if (type === undefined) {
        return null
      }
      if (type === 0) {
        return result
      }
      const id = integer(2)
      const parsed = value(type)
      if (id === null || parsed === undefined) {
        return null
      }
      result.set(id, parsed)
    }
  }
  return fields()
}

function callLabel(eventB64: string | undefined): string | null {
  const bytes = eventB64 ? base64ToBytes(eventB64) : undefined
  const detail = bytes ? parseThrift(bytes)?.get(7) : undefined
  const create = detail instanceof Map ? detail.get(1) : undefined
  const contents = create instanceof Map ? create.get(100) : undefined
  const entry =
    contents instanceof Uint8Array ? parseThrift(contents)?.get(1) : undefined
  if (!(entry instanceof Map)) {
    return null
  }
  const kind = (fields: ThriftFields, id: number) =>
    fields.get(id) === false ? "ビデオ通話" : "音声通話"
  const ended = entry.get(10)
  if (ended instanceof Map) {
    const label = `通話終了（${kind(ended, 3)}）`
    const seconds = ended.get(2)
    return typeof seconds === "number" && seconds > 0
      ? `${label} ${formatDuration(seconds)}`
      : label
  }
  const missed = entry.get(11)
  return missed instanceof Map ? `通話終了（${kind(missed, 2)}）` : null
}

function toMessage(event: Event, originalB64?: string): DmMessage | null {
  const id = event.sequenceId ?? event.id
  const contentType = event.content?.contentType ?? "text"
  if (event.type !== "message" || !id || !event.senderId) {
    return null
  }
  if (contentType === "unknown") {
    const label = callLabel(originalB64)
    return label
      ? {
          id,
          time: Number(event.createdAtMsec ?? 0),
          senderId: "",
          segments: [{ text: label }],
          reactions: [],
          encrypted: false,
          fromXChat: true,
          event: "call"
        }
      : null
  }
  if (contentType !== "text") {
    return null
  }
  const attachments: AttachmentInfo[] = event.attachments ?? []
  const text =
    event.content?.text ||
    attachments
      .map((attachment) => attachment.postUrl ?? attachment.url)
      .filter((link): link is string => typeof link === "string")
      .join("\n")
  const hasMedia = attachments.some(
    (attachment) => attachment.attachmentType === "media"
  )
  if (text.trim().length === 0 && !hasMedia) {
    return null
  }
  return {
    id,
    time: Number(event.createdAtMsec ?? 0),
    senderId: event.senderId,
    segments: [
      ...linkify(text),
      ...(hasMedia ? [{ text: text ? "\n（画像）" : "（画像）" }] : [])
    ],
    reactions: [],
    encrypted: Boolean(event.conversationKeyVersion),
    verified: event.verified === true,
    fromXChat: true
  }
}

function encryptionNotice(event: Event, conversationId: string): DmMessage | null {
  if (event.type !== "keyChange" || !event.createdAtMsec) {
    return null
  }
  return {
    id: `keychange:${conversationId}`,
    time: Number(event.createdAtMsec),
    senderId: "",
    segments: [{ text: "会話が暗号化されました" }],
    reactions: [],
    encrypted: true,
    verified: true,
    fromXChat: true,
    event: "encrypted"
  }
}

function decrypt(
  current: Session,
  conversationId: string,
  events: string[]
): void {
  if (events.length === 0) {
    return
  }
  const result = current.chat.decryptEvents({ events }) as DecryptEventsResult
  for (const { event, originalB64 } of result.events) {
    const id = event.conversationId || conversationId
    if (!id) {
      continue
    }
    const oldest = current.oldest.get(id)
    if (event.sequenceId && (!oldest || isLess(event.sequenceId, oldest))) {
      current.oldest.set(id, event.sequenceId)
    }
    const message =
      toMessage(event, originalB64) ?? encryptionNotice(event, id)
    if (!message) {
      continue
    }
    let messages = current.messages.get(id)
    if (!messages) {
      messages = new Map()
      current.messages.set(id, messages)
    }
    const existing = messages.get(message.id)
    if (existing?.event === "encrypted" && existing.time <= message.time) {
      continue
    }
    messages.set(message.id, message)
  }
}

function cachedMessages(current: Session, conversationId: string): DmMessage[] {
  return [...(current.messages.get(conversationId)?.values() ?? [])].sort(
    (left, right) => left.time - right.time
  )
}

export async function fetchXChatInbox(): Promise<XChatConversation[]> {
  const current = requireSession()
  const data = await query<{
    get_initial_chat_page?: {
      items?: RawInboxItem[]
      encoded_message_events?: unknown
    }
  }>("GetInitialXChatPageQuery", {})
  const page = data.get_initial_chat_page

  const entries = (page?.items ?? []).flatMap((item) => {
    const detail = item.conversation_detail
    if (!detail?.conversation_id) {
      return []
    }
    return [
      {
        id: detail.conversation_id,
        isGroup: detail.__typename === "XChatGroupConversationDetail",
        groupName: detail.group_metadata?.group_name ?? null,
        participants: (detail.participants_results ?? [])
          .map(parseUser)
          .filter((user): user is DmUser => user !== null),
        events: [
          ...strings(item.latest_conversation_key_change_events),
          ...strings(item.latest_message_events)
        ]
      }
    ]
  })

  await ensureSigningKeys(current, [
    current.userId,
    ...entries.flatMap((entry) => entry.participants.map((user) => user.id))
  ])
  const batches: [string, string[]][] = [
    ...entries.map((entry): [string, string[]] => [entry.id, entry.events]),
    ["", strings(page?.encoded_message_events)]
  ]
  for (const entry of entries) {
    current.participants.set(
      entry.id,
      entry.participants.map((user) => user.id)
    )
  }
  for (const [conversationId, events] of batches) {
    try {
      decrypt(current, conversationId, events)
    } catch {
      continue
    }
  }

  return entries.map((entry) => ({
    id: entry.id,
    isGroup: entry.isGroup,
    groupName: entry.groupName,
    participants: entry.participants,
    messages: cachedMessages(current, entry.id)
  }))
}

export async function fetchXChatHistory(
  conversationId: string
): Promise<{ messages: DmMessage[]; hasMore: boolean }> {
  const current = requireSession()
  await ensureSigningKeys(current, [
    current.userId,
    ...(current.participants.get(conversationId) ?? [])
  ])
  const before = current.oldest.get(conversationId)
  if (!before) {
    return { messages: cachedMessages(current, conversationId), hasMore: false }
  }
  const data = await query<{
    get_conversation_page?: {
      encoded_message_events?: unknown
      missing_conversation_key_change_events?: unknown
      has_more?: boolean
    }
  }>("GetConversationPageQuery", {
    conversation_id: conversationId,
    min_local_sequence_id: before,
    min_conversation_key_version: "0"
  })
  const page = data.get_conversation_page
  decrypt(current, conversationId, [
    ...strings(page?.missing_conversation_key_change_events),
    ...strings(page?.encoded_message_events)
  ])
  return {
    messages: cachedMessages(current, conversationId),
    hasMore:
      page?.has_more === true && current.oldest.get(conversationId) !== before
  }
}

function memberIds(current: Session, conversationId: string): string[] {
  return [
    ...new Set([
      ...(current.participants.get(conversationId) ?? []),
      ...(conversationId.includes(":") ? conversationId.split(":") : [])
    ])
  ]
}

export function canEncryptXChat(conversationId: string): boolean {
  if (!session) {
    return false
  }
  const current = session
  const others = memberIds(current, conversationId).filter(
    (id) => id !== current.userId
  )
  return others.every((id) => current.usersWithKeys.has(id))
}

export async function sendXChatMessage(
  conversationId: string,
  text: string
): Promise<DmMessage[]> {
  const current = requireSession()
  if (text.trim().length === 0) {
    throw new ApiError("メッセージ本文を入力してください。", "blank")
  }
  let payload: SendPayload
  try {
    payload = current.chat.encryptMessage({ conversationId, text }) as SendPayload
  } catch {
    throw new ApiError("メッセージを暗号化できませんでした。", "unknown")
  }
  const data = await query<{
    xchat_send_create_message_event?: { encoded_message_event?: string }
  }>(
    "SendMessageCreateMutation",
    {
      conversation_id: conversationId,
      message_id: payload.messageId,
      encoded_message_create_event: payload.encodedMessageCreateEvent,
      encoded_message_event_signature: payload.encodedMessageEventSignature
    },
    true
  )
  decrypt(
    current,
    conversationId,
    strings(data.xchat_send_create_message_event?.encoded_message_event)
  )
  return cachedMessages(current, conversationId)
}
