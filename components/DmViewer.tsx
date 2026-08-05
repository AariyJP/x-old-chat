import { Loader2, Plus, Send, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Alert, AlertDescription } from "~components/ui/alert"
import { Avatar, AvatarFallback, AvatarImage } from "~components/ui/avatar"
import { Button } from "~components/ui/button"
import { Textarea } from "~components/ui/textarea"
import { describeApiError, sendDirectMessage } from "~lib/api"
import {
  fetchConversation,
  fetchInbox,
  type DmConversation,
  type DmMessage,
  type DmUser
} from "~lib/dm"
import { getMyUserId } from "~lib/ids"
import { cn } from "~lib/utils"

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

function MessageBubble({
  message,
  mine
}: {
  message: DmMessage
  mine: boolean
}) {
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div className="max-w-[75%]">
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm",
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
            "mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground",
            mine ? "justify-end" : "justify-start"
          )}>
          {message.reactions.length > 0 && (
            <span>{message.reactions.join("")}</span>
          )}
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
  const bottomRef = useRef<HTMLDivElement>(null)

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
    void (async () => {
      try {
        const thread = await fetchConversation(selectedId)
        if (cancelled) {
          return
        }
        setMessages(thread.messages)
        setUsers((previous) => ({ ...thread.users, ...previous }))
        setMinEntryId(thread.minEntryId)
        setAtEnd(thread.atEnd)
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
  }, [selectedId])

  useEffect(() => {
    if (!threadLoading) {
      bottomRef.current?.scrollIntoView()
    }
  }, [selectedId, threadLoading])

  const selected =
    conversations.find((conversation) => conversation.id === selectedId) ?? null
  const partner = selected?.partnerId ? users[selected.partnerId] : null

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
    if (!selectedId || atEnd || loadingMore || !minEntryId) {
      return
    }
    setLoadingMore(true)
    setThreadError("")
    try {
      const thread = await fetchConversation(selectedId, minEntryId)
      setMessages((previous) => [...thread.messages, ...previous])
      setMinEntryId(thread.minEntryId)
      setAtEnd(thread.atEnd || thread.messages.length === 0)
    } catch (caught) {
      setThreadError(describeApiError(caught))
    } finally {
      setLoadingMore(false)
    }
  }

  async function onSend() {
    if (!selectedId || sending || text.trim().length === 0) {
      return
    }
    setSending(true)
    setThreadError("")
    try {
      await sendDirectMessage(selectedId, text)
      setText("")
      const thread = await fetchConversation(selectedId)
      setMessages(thread.messages)
      setMinEntryId(thread.minEntryId)
      setAtEnd(thread.atEnd)
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
      <div className="flex h-[85vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-xl">
        <aside className="flex w-72 shrink-0 flex-col border-r border-border">
          <div className="flex items-center justify-between border-b border-border py-3 pl-4 pr-2">
            <h2 className="text-base font-bold">メッセージ</h2>
            <div className="flex items-center">
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
            {!loading && !error && conversations.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                会話がありません。
              </p>
            )}
            {conversations.map((conversation) => {
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
                  <Avatar>
                    {avatarUrl && <AvatarImage src={avatarUrl} />}
                    <AvatarFallback>{title.slice(0, 1)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-bold">{title}</p>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {formatTime(conversation.sortTime)}
                      </span>
                    </div>
                    <p className="truncate text-sm text-muted-foreground">
                      {conversation.preview}
                    </p>
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
                  <p className="truncate text-sm font-bold">
                    {titleOf(selected)}
                  </p>
                  {partner && partner.screenName && (
                    <p className="truncate text-xs text-muted-foreground">
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
                {!threadLoading && !atEnd && (
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
                  {messages.map((message) => (
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
                  className="min-h-11 flex-1 resize-none"
                  placeholder={
                    selected.readOnly
                      ? "このスレッドには返信できません"
                      : "メッセージを入力（Ctrl+Enterで送信）"
                  }
                  disabled={sending || selected.readOnly}
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
                <Button
                  size="icon"
                  disabled={
                    sending || selected.readOnly || text.trim().length === 0
                  }
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
