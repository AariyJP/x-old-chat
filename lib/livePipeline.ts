import { ApiError, buildHeaders } from "~lib/api"
import { LIVE_PIPELINE_BASE } from "~lib/constants"

const SUBSCRIPTION_REFRESH_MS = 45000

const SILENCE_TIMEOUT_MS = 60000

const RECONNECT_BASE_MS = 2000

const RECONNECT_MAX_MS = 60000

type LivePipelineMessage = {
  topic?: string
  payload?: {
    config?: { session_id?: string }
    dm_update?: { conversation_id?: string; user_id?: string }
  }
}

export function subscribeDmUpdates(
  conversationId: string,
  onUpdate: () => void
): () => void {
  const topic = `/dm_update/${conversationId}`
  let closed = false
  let controller: AbortController | null = null
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  let sessionId: string | null = null
  let failures = 0

  function stopRefreshTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  function armSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer)
    }
    silenceTimer = setTimeout(() => controller?.abort(), SILENCE_TIMEOUT_MS)
  }

  async function refreshSubscription() {
    if (!sessionId) {
      return
    }
    try {
      const response = await fetch(
        `${LIVE_PIPELINE_BASE}/1.1/live_pipeline/update_subscriptions`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            ...buildHeaders(false),
            "content-type": "application/x-www-form-urlencoded",
            "livepipeline-session": sessionId
          },
          body: new URLSearchParams({ sub_topics: topic, unsub_topics: "" })
        }
      )
      if (!response.ok) {
        controller?.abort()
      }
    } catch {
      controller?.abort()
    }
  }

  function handleLine(line: string) {
    if (line.trim().length === 0) {
      return
    }
    let parsed: LivePipelineMessage
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    const id = parsed.payload?.config?.session_id
    if (id) {
      sessionId = id
      stopRefreshTimer()
      refreshTimer = setInterval(refreshSubscription, SUBSCRIPTION_REFRESH_MS)
    }
    if (parsed.payload?.dm_update) {
      onUpdate()
    }
  }

  async function readStream() {
    controller = new AbortController()
    armSilenceTimer()
    const response = await fetch(
      `${LIVE_PIPELINE_BASE}/live_pipeline/events?topic=${encodeURIComponent(topic)}`,
      {
        credentials: "include",
        headers: buildHeaders(false),
        signal: controller.signal
      }
    )
    if (!response.ok) {
      throw new ApiError(
        `live pipeline responded ${response.status}`,
        response.status === 429 ? "rate_limit" : "unknown"
      )
    }
    failures = 0
    const reader = response.body?.getReader()
    if (!reader) {
      return
    }
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }
      armSilenceTimer()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        handleLine(line)
      }
    }
  }

  async function run() {
    while (!closed) {
      try {
        await readStream()
      } catch {
        failures += 1
      }
      stopRefreshTimer()
      sessionId = null
      if (closed) {
        return
      }
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** failures,
        RECONNECT_MAX_MS
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  void run()

  return () => {
    closed = true
    controller?.abort()
    stopRefreshTimer()
    if (silenceTimer) {
      clearTimeout(silenceTimer)
    }
  }
}
