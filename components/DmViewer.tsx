import {
  Loader2,
  Lock,
  LockOpen,
  Plus,
  Send,
  X
} from "lucide-react"
import { REGEXP_ONLY_DIGITS } from "input-otp"
import { useEffect, useMemo, useRef, useState } from "react"

import { Alert, AlertDescription } from "~components/ui/alert"
import { Avatar, AvatarFallback, AvatarImage } from "~components/ui/avatar"
import { Button } from "~components/ui/button"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot
} from "~components/ui/input-otp"
import { Textarea } from "~components/ui/textarea"
import { describeApiError, sendDirectMessage } from "~lib/api"
import { XCHAT_CONVERSATION_PREFIX } from "~lib/constants"
import {
  fetchConversation,
  fetchInbox,
  type DmConversation,
  type DmMessage,
  type DmUser
} from "~lib/dm"
import { buildConversationId, getMyUserId } from "~lib/ids"
import { subscribeDmUpdates } from "~lib/livePipeline"
import { cn } from "~lib/utils"
import {
  canEncryptXChat,
  fetchXChatHistory,
  fetchXChatInbox,
  lockXChat,
  restoreXChat,
  sendXChatMessage,
  unlockXChat,
  type XChatConversation
} from "~lib/xchat"

export type DmViewerProps = {
  initialConversationId?: string | null
  onNewMessage: () => void
  onClose: () => void
}

function formatTime(time: number): string {
  if (!time) {
    return ""
  }
  const date = new Date(time)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: "numeric", day: "numeric" })
  }
  return date.toLocaleDateString([], {
    year: "numeric",
    month: "numeric",
    day: "numeric"
  })
}

function isSameMessage(left: DmMessage, right: DmMessage): boolean {
  return (
    left.time === right.time &&
    left.senderId === right.senderId &&
    left.reactions.length === right.reactions.length &&
    left.reactions.every((emoji, index) => emoji === right.reactions[index]) &&
    left.segments.length === right.segments.length &&
    left.segments.every((segment, index) => {
      const other = right.segments[index]
      return segment.text === other?.text && segment.href === other?.href
    })
  )
}

function mergeMessages(
  previous: DmMessage[],
  incoming: DmMessage[]
): DmMessage[] {
  const byId = new Map(previous.map((message) => [message.id, message]))
  let changed = false
  for (const message of incoming) {
    const current = byId.get(message.id)
    if (
      current &&
      (isSameMessage(current, message) || message.encrypted === false)
    ) {
      continue
    }
    byId.set(message.id, message)
    changed = true
  }
  if (!changed) {
    return previous
  }
  return [...byId.values()].sort((left, right) => left.time - right.time)
}

function mergeXChat(
  conversations: DmConversation[],
  xchat: XChatConversation[],
  myId: string | null
): DmConversation[] {
  if (!myId || xchat.length === 0) {
    return conversations
  }
  const merged = new Map(
    conversations.map((conversation) => [conversation.id, conversation])
  )
  for (const entry of xchat) {
    const others = entry.participants.filter((user) => user.id !== myId)
    const memberIds = entry.id.split(":")
    const partnerId = entry.isGroup
      ? undefined
      : memberIds.find((memberId) => memberId !== myId) ??
        (memberIds.includes(myId) ? myId : undefined)
    const id = partnerId
      ? buildConversationId(myId, partnerId)
      : `${XCHAT_CONVERSATION_PREFIX}${entry.id}`
    const current = merged.get(id)
    const last = entry.messages
      .filter((message) => message.event !== "encrypted")
      .at(-1)
    const newer = last !== undefined && (!current || last.time > current.sortTime)
    merged.set(id, {
      id,
      name:
        current?.name ??
        (partnerId
          ? null
          : entry.groupName ?? others.map((user) => user.name).join(", ")),
      partnerId: current?.partnerId ?? partnerId ?? null,
      preview: newer
        ? last.segments.map((segment) => segment.text).join("")
        : current?.preview ?? "",
      sortTime: newer ? last.time : current?.sortTime ?? 0,
      previewEncrypted: newer
        ? last.encrypted === true
        : current?.previewEncrypted ?? false,
      unread: current?.unread ?? false,
      readOnly: current?.readOnly ?? !partnerId,
      xchatId: entry.id
    })
  }
  return [...merged.values()].sort(
    (left, right) => right.sortTime - left.sortTime
  )
}

function MessageBubble({
  message,
  mine
}: {
  message: DmMessage
  mine: boolean
}) {
  if (message.event) {
    return (
      <div className="flex flex-col items-center py-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          {message.event === "encrypted" && (
            <Lock className="size-3 [&_rect]:fill-current" />
          )}
          {message.segments.map((segment) => segment.text).join("")}
        </span>
        <span>{formatTime(message.time)}</span>
      </div>
    )
  }
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div className="max-w-[75%]">
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-[15px]",
            mine
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-secondary-foreground"
          )}>
          {message.segments.length === 0 && (
            <span className="italic opacity-70">（本文なし）</span>
          )}
          {message.segments.map((segment, index) =>
            segment.href ? (
              <a
                key={index}
                href={segment.href}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2">
                {segment.text}
              </a>
            ) : (
              <span key={index}>{segment.text}</span>
            )
          )}
        </div>
        <div
          className={cn(
            "mt-0.5 flex items-center gap-1 text-xs text-muted-foreground",
            mine ? "justify-end" : "justify-start"
          )}>
          {message.reactions.length > 0 && (
            <span>{message.reactions.join("")}</span>
          )}
          <span
            title={
              !message.encrypted
                ? "暗号化なし"
                : message.verified
                  ? "暗号化済み"
                  : "暗号化済み（署名未確認）"
            }>
            {message.encrypted ? (
              <Lock
                className={cn(
                  "size-3 [&_rect]:fill-current",
                  !message.verified && "text-amber-500"
                )}
              />
            ) : (
              <LockOpen className="size-3" />
            )}
          </span>
          <span>{formatTime(message.time)}</span>
        </div>
      </div>
    </div>
  )
}

export default function DmViewer({
  initialConversationId,
  onNewMessage,
  onClose
}: DmViewerProps) {
  const myId = useMemo(() => getMyUserId(), [])
  const [conversations, setConversations] = useState<DmConversation[]>([])
  const [users, setUsers] = useState<Record<string, DmUser>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConversationId ?? null
  )
  const [messages, setMessages] = useState<DmMessage[]>([])
  const [threadLoading, setThreadLoading] = useState(false)
  const [threadError, setThreadError] = useState("")
  const [minEntryId, setMinEntryId] = useState<string | null>(null)
  const [atEnd, setAtEnd] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [autoScrollKey, setAutoScrollKey] = useState(0)
  const [xchatConversations, setXChatConversations] = useState<
    XChatConversation[]
  >([])
  const [xchatUnlocked, setXChatUnlocked] = useState(false)
  const [xchatFormOpen, setXChatFormOpen] = useState(false)
  const [xchatBusy, setXChatBusy] = useState(false)
  const [xchatError, setXChatError] = useState("")
  const [xchatHasMore, setXChatHasMore] = useState(false)
  const [pin, setPin] = useState("")
  const [sendPlain, setSendPlain] = useState(false)
  const [lockConfirmOpen, setLockConfirmOpen] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<DmMessage[]>([])

  const visibleMessages = useMemo(() => {
    const legacyCalls = messages
      .filter((message) => message.event === "call" && !message.fromXChat)
      .map((message) => message.time)
    return messages.filter(
      (message) =>
        message.event !== "call" ||
        !message.fromXChat ||
        !legacyCalls.some((time) => Math.abs(time - message.time) < 60000)
    )
  }, [messages])
  const mergedConversations = useMemo(
    () => mergeXChat(conversations, xchatConversations, myId),
    [conversations, xchatConversations, myId]
  )
  const selected =
    mergedConversations.find(
      (conversation) => conversation.id === selectedId
    ) ?? null
  const selectedXChatId = selected?.xchatId ?? null
  const partner = selected?.partnerId ? users[selected.partnerId] : null
  const canEncrypt =
    xchatUnlocked &&
    selectedXChatId !== null &&
    canEncryptXChat(selectedXChatId)
  const encrypt = canEncrypt && (!sendPlain || selected?.readOnly === true)
  const writable = selected !== null && (!selected.readOnly || encrypt)

  async function loadXChat() {
    try {
      const list = await fetchXChatInbox()
      setXChatConversations(list)
      setUsers((previous) => ({
        ...Object.fromEntries(
          list.flatMap((entry) => entry.participants).map((user) => [user.id, user])
        ),
        ...previous
      }))
    } catch (caught) {
      setXChatError(describeApiError(caught))
    }
  }

  async function onUnlock() {
    const value = pin.trim()
    if (!myId || xchatBusy || value.length < 4) {
      return
    }
    setXChatBusy(true)
    setXChatError("")
    try {
      await unlockXChat(myId, value)
      setPin("")
      setXChatUnlocked(true)
      setXChatFormOpen(false)
      await loadXChat()
    } catch (caught) {
      setXChatError(describeApiError(caught))
    } finally {
      setXChatBusy(false)
    }
  }

  async function onLock() {
    if (!myId) {
      return
    }
    setLockConfirmOpen(false)
    await lockXChat(myId)
    setXChatUnlocked(false)
    setXChatConversations([])
    setXChatError("")
  }

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  function applyThreadMessages(incoming: DmMessage[]) {
    const known = new Set(messagesRef.current.map((message) => message.id))
    const hasNew = incoming.some((message) => !known.has(message.id))
    setMessages((previous) => mergeMessages(previous, incoming))
    if (hasNew) {
      setAutoScrollKey((key) => key + 1)
    }
  }

  useEffect(() => {
    if (!myId) {
      setError("認証エラー。x.comに再ログインしてください。")
      setLoading(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const inbox = await fetchInbox(myId)
        if (cancelled) {
          return
        }
        setConversations(inbox.conversations)
        setUsers((previous) => ({ ...inbox.users, ...previous }))
      } catch (caught) {
        if (!cancelled) {
          setError(describeApiError(caught))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
      try {
        if ((await restoreXChat(myId)) && !cancelled) {
          setXChatUnlocked(true)
          await loadXChat()
        }
      } catch (caught) {
        if (!cancelled) {
          setXChatError(describeApiError(caught))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [myId])

  useEffect(() => {
    if (!selectedId) {
      return
    }
    let cancelled = false
    setThreadLoading(true)
    setThreadError("")
    setMessages([])
    setSendPlain(false)
    void (async () => {
      try {
        const [thread, history] = await Promise.all([
          selectedId.startsWith(XCHAT_CONVERSATION_PREFIX)
            ? null
            : fetchConversation(selectedId).catch((caught) => {
                if (selectedXChatId) {
                  return null
                }
                throw caught
              }),
          selectedXChatId ? fetchXChatHistory(selectedXChatId) : null
        ])
        if (cancelled) {
          return
        }
        setMessages((previous) =>
          mergeMessages(
            mergeMessages(previous, thread?.messages ?? []),
            history?.messages ?? []
          )
        )
        if (thread) {
          setUsers((previous) => ({ ...thread.users, ...previous }))
        }
        setMinEntryId(thread?.minEntryId ?? null)
        setAtEnd(thread?.atEnd ?? true)
        setXChatHasMore(history?.hasMore ?? false)
      } catch (caught) {
        if (!cancelled) {
          setThreadError(describeApiError(caught))
        }
      } finally {
        if (!cancelled) {
          setThreadLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId, selectedXChatId])

  useEffect(() => {
    if (!threadLoading) {
      bottomRef.current?.scrollIntoView()
    }
  }, [selectedId, threadLoading, autoScrollKey])

  useEffect(() => {
    if (!selectedId || selectedId.startsWith(XCHAT_CONVERSATION_PREFIX)) {
      return
    }
    const conversationId = selectedId
    let cancelled = false
    let refreshing = false
    let pending = false

    async function refresh() {
      if (refreshing) {
        pending = true
        return
      }
      refreshing = true
      try {
        for (;;) {
          pending = false
          const thread = await fetchConversation(conversationId)
          if (cancelled) {
            return
          }
          applyThreadMessages(thread.messages)
          if (!pending) {
            return
          }
        }
      } catch {
        return
      } finally {
        refreshing = false
      }
    }

    const unsubscribe = subscribeDmUpdates(conversationId, () => void refresh())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [selectedId])

  function titleOf(conversation: DmConversation): string {
    if (conversation.name) {
      return conversation.name
    }
    const user = conversation.partnerId ? users[conversation.partnerId] : null
    return user?.name ?? "不明なユーザー"
  }

  function avatarOf(conversation: DmConversation): string | null {
    const user = conversation.partnerId ? users[conversation.partnerId] : null
    return user?.avatarUrl ?? null
  }

  async function onLoadMore() {
    if (!selectedId || loadingMore || (atEnd && !xchatHasMore)) {
      return
    }
    setLoadingMore(true)
    setThreadError("")
    try {
      if (!atEnd && minEntryId) {
        const thread = await fetchConversation(selectedId, minEntryId)
        setMessages((previous) => mergeMessages(previous, thread.messages))
        setMinEntryId(thread.minEntryId)
        setAtEnd(thread.atEnd || thread.messages.length === 0)
      }
      if (xchatHasMore && selectedXChatId) {
        const history = await fetchXChatHistory(selectedXChatId)
        setMessages((previous) => mergeMessages(previous, history.messages))
        setXChatHasMore(history.hasMore)
      }
    } catch (caught) {
      setThreadError(describeApiError(caught))
    } finally {
      setLoadingMore(false)
    }
  }

  async function onSend() {
    if (!selectedId || sending || !writable || text.trim().length === 0) {
      return
    }
    setSending(true)
    setThreadError("")
    try {
      if (encrypt && selectedXChatId) {
        const sent = await sendXChatMessage(selectedXChatId, text)
        setText("")
        applyThreadMessages(sent)
        return
      }
      await sendDirectMessage(selectedId, text)
      setText("")
      applyThreadMessages((await fetchConversation(selectedId)).messages)
    } catch (caught) {
      setThreadError(describeApiError(caught))
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}>
      <div className="flex h-[90vh] w-full max-w-6xl overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-xl">
        <aside className="flex w-96 shrink-0 flex-col border-r border-border">
          <div className="flex items-center justify-between border-b border-border py-3 pl-4 pr-2">
            <h2 className="text-xl font-bold">メッセージ</h2>
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="icon"
                aria-label={
                  xchatUnlocked
                    ? "暗号化チャットをロック"
                    : "暗号化チャットを表示"
                }
                title={
                  xchatUnlocked
                    ? "暗号化チャットをロック"
                    : "暗号化チャットを表示"
                }
                onClick={() =>
                  xchatUnlocked
                    ? setLockConfirmOpen((open) => !open)
                    : setXChatFormOpen((open) => !open)
                }>
                {xchatUnlocked ? (
                  <Lock className="[&_rect]:fill-current" />
                ) : (
                  <LockOpen />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="新しいメッセージ"
                onClick={onNewMessage}>
                <Plus />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="閉じる"
                onClick={onClose}>
                <X />
              </Button>
            </div>
          </div>
          {lockConfirmOpen && xchatUnlocked && (
            <Alert className="m-3 w-auto border-border">
              <AlertDescription className="space-y-3">
                <p>
                  暗号化チャットをロックしますか？もう一度表示するにはPINの入力が必要です。
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLockConfirmOpen(false)}>
                    キャンセル
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void onLock()}>
                    ロック
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          {xchatFormOpen && !xchatUnlocked && (
            <form
              className="space-y-2 border-b border-border p-4"
              onSubmit={(event) => {
                event.preventDefault()
                void onUnlock()
              }}>
              <p className="text-sm text-muted-foreground">
                暗号化チャットのPINを入力してください。PINを何度も間違えると鍵を復元できなくなります。
              </p>
              <div className="flex items-center justify-between gap-2">
                <InputOTP
                  maxLength={4}
                  pattern={REGEXP_ONLY_DIGITS}
                  autoComplete="off"
                  value={pin}
                  disabled={xchatBusy}
                  onChange={setPin}>
                  <InputOTPGroup>
                    {[0, 1, 2, 3].map((index) => (
                      <InputOTPSlot
                        key={index}
                        index={index}
                        className="size-10 text-base [-webkit-text-security:disc]"
                      />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
                <Button
                  type="submit"
                  disabled={xchatBusy || pin.length < 4}>
                  {xchatBusy ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <span>解除</span>
                  )}
                </Button>
              </div>
            </form>
          )}
          {xchatError && (
            <Alert variant="destructive" className="m-3">
              <AlertDescription>{xchatError}</AlertDescription>
            </Alert>
          )}
          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && error && (
              <Alert variant="destructive" className="m-3">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {!loading && !error && mergedConversations.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                会話がありません。
              </p>
            )}
            {mergedConversations.map((conversation) => {
              const title = titleOf(conversation)
              const avatarUrl = avatarOf(conversation)
              return (
                <button
                  key={conversation.id}
                  onClick={() => setSelectedId(conversation.id)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent",
                    conversation.id === selectedId && "bg-accent"
                  )}>
                  <Avatar className="size-12">
                    {avatarUrl && <AvatarImage src={avatarUrl} />}
                    <AvatarFallback>{title.slice(0, 1)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-[15px] font-bold">{title}</p>
                      <span className="ml-auto shrink-0 text-sm text-muted-foreground">
                        {formatTime(conversation.sortTime)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      {conversation.previewEncrypted ? (
                        <Lock className="size-3.5 shrink-0 [&_rect]:fill-current" />
                      ) : (
                        <LockOpen className="size-3.5 shrink-0" />
                      )}
                      <p className="truncate text-[15px]">
                        {conversation.preview}
                      </p>
                    </div>
                  </div>
                  {conversation.unread && (
                    <span className="size-2 shrink-0 rounded-full bg-primary" />
                  )}
                </button>
              )
            })}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {!selected && (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              会話を選択してください。
            </div>
          )}

          {selected && (
            <>
              <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                <Avatar>
                  {avatarOf(selected) && (
                    <AvatarImage src={avatarOf(selected) as string} />
                  )}
                  <AvatarFallback>
                    {titleOf(selected).slice(0, 1)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="truncate text-base font-bold">
                    {titleOf(selected)}
                  </p>
                  {partner && partner.screenName && (
                    <p className="truncate text-sm text-muted-foreground">
                      @{partner.screenName}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-3">
                {threadLoading && (
                  <div className="flex justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                )}
                {!threadLoading && (!atEnd || xchatHasMore) && (
                  <div className="mb-3 flex justify-center">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={loadingMore}
                      onClick={onLoadMore}>
                      {loadingMore ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <span>以前のメッセージを読み込む</span>
                      )}
                    </Button>
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  {visibleMessages.map((message) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      mine={message.senderId === myId}
                    />
                  ))}
                </div>
                <div ref={bottomRef} />
              </div>

              {threadError && (
                <Alert variant="destructive" className="mx-4 mb-2">
                  <AlertDescription>{threadError}</AlertDescription>
                </Alert>
              )}

              <div className="flex items-end gap-2 border-t border-border p-3">
                <Textarea
                  value={text}
                  className="min-h-12 flex-1 resize-none text-[15px]"
                  placeholder={
                    !writable
                      ? "このスレッドには返信できません"
                      : encrypt
                        ? "暗号化メッセージを入力（Ctrl+Enterで送信）"
                        : "メッセージを入力（Ctrl+Enterで送信）"
                  }
                  disabled={sending || !writable}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey)
                    ) {
                      event.preventDefault()
                      void onSend()
                    }
                  }}
                />
                {canEncrypt && (
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={encrypt ? "暗号化して送信" : "暗号化せずに送信"}
                    title={encrypt ? "暗号化して送信" : "暗号化せずに送信"}
                    disabled={sending || selected.readOnly}
                    onClick={() => setSendPlain((plain) => !plain)}>
                    {encrypt ? (
                      <Lock className="[&_rect]:fill-current" />
                    ) : (
                      <LockOpen />
                    )}
                  </Button>
                )}
                <Button
                  size="icon"
                  disabled={sending || !writable || text.trim().length === 0}
                  onClick={onSend}>
                  {sending ? <Loader2 className="animate-spin" /> : <Send />}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
