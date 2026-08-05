import type { PlasmoCSConfig } from "plasmo"

import {
  CHAT_PATH,
  COMPOSE_PATH,
  DIRECT_MESSAGE_TAB_SELECTOR,
  HOME_PATH,
  OPEN_VIEWER_KEY
} from "~lib/constants"

export const config: PlasmoCSConfig = {
  matches: ["https://x.com/*"],
  run_at: "document_idle"
}

const HIDDEN_ATTR = "data-xoc-hidden"

function hide(element: HTMLElement) {
  if (element.hasAttribute(HIDDEN_ATTR)) {
    return
  }
  element.setAttribute(HIDDEN_ATTR, "1")
  element.style.setProperty("display", "none", "important")
}

function hideProfileDmButton() {
  document
    .querySelectorAll<HTMLElement>('[data-testid="sendDMFromProfile"]')
    .forEach(hide)
}

function hideShareMenuChatItem() {
  document
    .querySelectorAll<HTMLAnchorElement>(`a[href^="${COMPOSE_PATH}"]`)
    .forEach((link) => {
      const item = link.closest<HTMLElement>('[role="menuitem"]')
      if (item) {
        hide(item)
      }
    })
  document.querySelectorAll<HTMLElement>('[role="menuitem"]').forEach((item) => {
    const text = item.textContent ?? ""
    if (/チャット経由で送信|Send via (Chat|Direct Message)/i.test(text)) {
      hide(item)
    }
  })
}

function redirectAwayFromChat(): boolean {
  if (!window.location.pathname.startsWith(CHAT_PATH)) {
    return false
  }
  window.sessionStorage.setItem(OPEN_VIEWER_KEY, "1")
  window.location.replace(`https://x.com${HOME_PATH}`)
  return true
}

function hideChatDrawer() {
  document
    .querySelectorAll<HTMLElement>('[data-testid="chat-drawer-root"]')
    .forEach(hide)
}

function hideChatBetaTab() {
  document
    .querySelectorAll<HTMLElement>(`a[role="tab"][href^="${CHAT_PATH}"]`)
    .forEach(hide)
}

function relabelDirectMessageTab() {
  document
    .querySelectorAll<HTMLAnchorElement>(DIRECT_MESSAGE_TAB_SELECTOR)
    .forEach((link) => {
      link.setAttribute("aria-label", "メッセージ(OLD)")
      link.querySelectorAll("span").forEach((span) => {
        if (span.textContent === "チャット") {
          span.textContent = "メッセージ(OLD)"
        }
      })
    })
}

function sweep() {
  if (redirectAwayFromChat()) {
    return
  }
  hideProfileDmButton()
  hideShareMenuChatItem()
  hideChatDrawer()
  hideChatBetaTab()
  relabelDirectMessageTab()
}

sweep()
new MutationObserver(sweep).observe(document.documentElement, {
  childList: true,
  subtree: true
})
window.addEventListener("popstate", () => redirectAwayFromChat())
