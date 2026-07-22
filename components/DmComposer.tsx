import { Loader2, X } from "lucide-react"
import { useState } from "react"

import { Alert, AlertDescription } from "~components/ui/alert"
import { Avatar, AvatarFallback, AvatarImage } from "~components/ui/avatar"
import { Button } from "~components/ui/button"
import { Input } from "~components/ui/input"
import { Label } from "~components/ui/label"
import { Textarea } from "~components/ui/textarea"
import {
  ApiError,
  resolveUser,
  sendDirectMessage,
  type ResolvedUser
} from "~lib/api"
import { buildConversationId, getMyUserId } from "~lib/ids"

export type DmComposerProps = {
  onClose: () => void
}

function describe(caught: unknown): string {
  if (caught instanceof ApiError) {
    if (caught.resetAt) {
      return `${caught.message}（解除予定: ${caught.resetAt.toLocaleTimeString()}）`
    }
    return caught.message
  }
  return "予期しないエラーが発生しました。"
}

export default function DmComposer({ onClose }: DmComposerProps) {
  const [screenName, setScreenName] = useState("")
  const [text, setText] = useState("")
  const [resolved, setResolved] = useState<ResolvedUser | null>(null)
  const [resolving, setResolving] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")

  const normalizedScreenName = screenName.trim().replace(/^@/, "")
  const canSend =
    resolved !== null &&
    resolved.canDm &&
    text.trim().length > 0 &&
    !sending

  async function onResolve() {
    if (normalizedScreenName.length === 0 || resolving) {
      return
    }
    setResolving(true)
    setError("")
    setResolved(null)
    try {
      setResolved(await resolveUser(normalizedScreenName))
    } catch (caught) {
      setError(describe(caught))
    } finally {
      setResolving(false)
    }
  }

  async function onSend() {
    if (!canSend || !resolved) {
      return
    }
    const myId = getMyUserId()
    if (!myId) {
      setError("認証エラー。x.comに再ログインしてください。")
      return
    }

    setSending(true)
    setError("")
    try {
      const conversationId = buildConversationId(myId, resolved.restId)
      await sendDirectMessage(conversationId, text)
      window.location.href = `https://x.com/messages/${conversationId}`
    } catch (caught) {
      setError(describe(caught))
    } finally {
      setSending(false)
    }
  }

  function onShowDm() {
    if (!resolved) {
      return
    }
    const myId = getMyUserId()
    if (!myId) {
      setError("認証エラー。x.comに再ログインしてください。")
      return
    }
    const conversationId = buildConversationId(myId, resolved.restId)
    window.location.href = `https://x.com/messages/${conversationId}`
  }

  return (
    <div
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold">新しいメッセージ</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X />
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="xoc-screen-name">宛先</Label>
          <div className="flex gap-2">
            <Input
              id="xoc-screen-name"
              value={screenName}
              placeholder="ユーザー名"
              disabled={sending}
              onChange={(event) => setScreenName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  onResolve()
                }
              }}
            />
            <Button
              variant="secondary"
              disabled={normalizedScreenName.length === 0 || resolving}
              onClick={onResolve}>
              {resolving ? <Loader2 className="animate-spin" /> : <span>解決</span>}
            </Button>
          </div>
        </div>

        {resolved && (
          <div className="mt-4 flex items-center gap-3 rounded-lg bg-secondary p-3">
            <Avatar>
              {resolved.avatarUrl && <AvatarImage src={resolved.avatarUrl} />}
              <AvatarFallback>{resolved.name.slice(0, 1)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold">{resolved.name}</p>
              <p className="truncate text-sm text-muted-foreground">
                @{resolved.screenName}
              </p>
            </div>
          </div>
        )}

        {resolved && !resolved.canDm && (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>この相手にはDMを送信できません。</AlertDescription>
          </Alert>
        )}

        <div className="mt-4 space-y-2">
          <Label htmlFor="xoc-text">メッセージ</Label>
          <Textarea
            id="xoc-text"
            value={text}
            className="min-h-28 resize-none"
            placeholder="メッセージを入力"
            disabled={sending}
            onChange={(event) => setText(event.target.value)}
          />
        </div>

        {error && (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button className="mt-5 w-full" disabled={!canSend} onClick={onSend}>
          {sending && <Loader2 className="animate-spin" />}
          <span>{sending ? "送信中..." : "送信"}</span>
        </Button>

        <Button
          variant="outline"
          className="mt-2 w-full"
          disabled={!resolved || sending}
          onClick={onShowDm}>
          <span>DMを表示</span>
        </Button>
      </div>
    </div>
  )
}
