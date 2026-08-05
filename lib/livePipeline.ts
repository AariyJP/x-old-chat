import { BEARER_TOKEN, LIVE_PIPELINE_BASE } from "~lib/constants"
import { getCsrfToken } from "~lib/cookies"

const SUBSCRIPTION_REFRESH_MS = 45000

const SILENCE_TIMEOUT_MS = 60000

const RECONNECT_DELAY_MS = 2000

function buildLiveHeaders(): Record<string, string> {
  return {
    authorization: BEARER_TOKEN,
    "x-csrf-token": getCsrfToken() ?? "",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes"
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
      await fetch(
        `${LIVE_PIPELINE_BASE}/1.1/live_pipeline/update_subscriptions`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            ...buildLiveHeaders(),
            "content-type": "application/x-www-form-urlencoded",
            "livepipeline-session": sessionId
          },
          body: new URLSearchParams({ sub_topics: topic, unsub_topics: "" })
        }
      )
    } catch {
      return
    }
  }

  function handleLine(line: string) {
    if (line.trim().length === 0) {
      return
    }
    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    const id = parsed?.payload?.config?.session_id
    if (id) {
      sessionId = id
      if (refreshTimer) {
        clearInterval(refreshTimer)
      }
      refreshTimer = setInterval(refreshSubscription, SUBSCRIPTION_REFRESH_MS)
    }
    if (parsed?.payload?.dm_update) {
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
        headers: buildLiveHeaders(),
        signal: controller.signal
      }
    )
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
        if (closed) {
          return
        }
      }
      if (closed) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS))
    }
  }

  void run()

  return () => {
    closed = true
    controller?.abort()
    if (refreshTimer) {
      clearInterval(refreshTimer)
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer)
    }
  }
}
