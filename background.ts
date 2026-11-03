import { XCHAT_KEYS_MESSAGE } from "~lib/constants"

type KeysRequest = {
  type?: string
  userId?: string
  keys?: unknown
}

function openStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("xchat", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("keys")
    request.onsuccess = () =>
      resolve(request.result.transaction("keys", mode).objectStore("keys"))
    request.onerror = () => reject(request.error)
  })
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function handle(userId: string, keys: unknown): Promise<unknown> {
  if (keys === undefined) {
    return (await settle((await openStore("readonly")).get(userId))) ?? null
  }
  const store = await openStore("readwrite")
  if (keys === null) {
    await settle(store.delete(userId))
  } else {
    await settle(store.put(keys, userId))
  }
  return null
}

chrome.runtime.onMessage.addListener(
  (message: KeysRequest, sender, sendResponse) => {
    if (
      message?.type !== XCHAT_KEYS_MESSAGE ||
      !message.userId ||
      sender.id !== chrome.runtime.id
    ) {
      return false
    }
    handle(message.userId, message.keys).then(sendResponse, () =>
      sendResponse(null)
    )
    return true
  }
)
