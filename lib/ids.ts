import { getCookie } from "~lib/cookies"

export function getMyUserId(): string | null {
  const twid = getCookie("twid")
  if (!twid) {
    return null
  }
  const decoded = decodeURIComponent(twid).replace(/^"|"$/g, "")
  if (!decoded.startsWith("u=")) {
    return null
  }
  const id = decoded.slice(2)
  return /^\d+$/.test(id) ? id : null
}

export function buildConversationId(myId: string, theirId: string): string {
  return BigInt(myId) < BigInt(theirId)
    ? `${myId}-${theirId}`
    : `${theirId}-${myId}`
}
