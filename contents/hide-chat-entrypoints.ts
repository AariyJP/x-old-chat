import type { PlasmoCSConfig } from "plasmo"

import { CHAT_PATH, COMPOSE_PATH, CONVERSATIONS_PATH } from "~lib/constants"

export const config: PlasmoCSConfig = {
  matches: ["https://x.com/*"],
  run_at: "document_idle"
}

const HIDDEN_ATTR = "data-xoc-hidden"
const REWIRED_ATTR = "data-xoc-rewired"

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
  if (window.location.pathname.startsWith(CHAT_PATH)) {
    window.location.replace(`https://x.com${CONVERSATIONS_PATH}`)
    return true
  }
  return false
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

function rewireDirectMessageTab() {
  document
    .querySelectorAll<HTMLAnchorElement>(
      '[data-testid="AppTabBar_DirectMessage_Link"]'
    )
    .forEach((link) => {
      link.setAttribute("href", CONVERSATIONS_PATH)
      link.setAttribute("aria-label", "メッセージ(OLD)")
      link.querySelectorAll("span").forEach((span) => {
        if (span.textContent === "チャット") {
          span.textContent = "メッセージ(OLD)"
        }
      })
      if (link.hasAttribute(REWIRED_ATTR)) {
        return
      }
      link.setAttribute(REWIRED_ATTR, "1")
      link.addEventListener(
        "click",
        (event) => {
          event.preventDefault()
          event.stopPropagation()
          window.location.assign(`https://x.com${CONVERSATIONS_PATH}`)
        },
        true
      )
    })
}

function rewireMessagesBackButton() {
  if (!window.location.pathname.startsWith("/messages")) {
    return
  }
  document
    .querySelectorAll<HTMLElement>(
      `[data-testid="app-bar-back"]:not([${REWIRED_ATTR}])`
    )
    .forEach((button) => {
      button.setAttribute(REWIRED_ATTR, "1")
      button.addEventListener(
        "click",
        (event) => {
          if (!window.location.pathname.startsWith("/messages")) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          window.history.back()
        },
        true
      )
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
  rewireDirectMessageTab()
  rewireMessagesBackButton()
}

sweep()
new MutationObserver(sweep).observe(document.documentElement, {
  childList: true,
  subtree: true
})
window.addEventListener("popstate", () => redirectAwayFromChat())
