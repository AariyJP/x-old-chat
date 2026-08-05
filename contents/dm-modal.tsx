import cssText from "data-text:~styles/globals.css"
import type { PlasmoCSConfig, PlasmoGetStyle } from "plasmo"
import { useEffect, useState } from "react"

import DmComposer from "~components/DmComposer"
import DmViewer from "~components/DmViewer"
import {
  CHAT_PATH,
  COMPOSE_PATH,
  MESSAGES_PATH,
  OPEN_VIEWER_KEY
} from "~lib/constants"

export const config: PlasmoCSConfig = {
  matches: ["https://x.com/*"],
  run_at: "document_idle"
}

export const getStyle: PlasmoGetStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

const HOOKED_ATTR = "data-xoc-hooked"

export default function DmModal() {
  const [composerOpen, setComposerOpen] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)

  function openViewer(id: string | null) {
    setConversationId(id)
    setComposerOpen(false)
    setViewerOpen(true)
  }

  function openComposer() {
    setComposerOpen(true)
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || (!composerOpen && !viewerOpen)) {
        return
      }
      event.stopPropagation()
      if (composerOpen) {
        setComposerOpen(false)
        return
      }
      setViewerOpen(false)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [composerOpen, viewerOpen])

  useEffect(() => {
    if (window.sessionStorage.getItem(OPEN_VIEWER_KEY)) {
      window.sessionStorage.removeItem(OPEN_VIEWER_KEY)
      openViewer(null)
    }

    function hookLinks() {
      const selector = [
        `a[href^="${MESSAGES_PATH}"]:not([${HOOKED_ATTR}])`,
        `a[href^="${CHAT_PATH}"]:not([${HOOKED_ATTR}])`
      ].join(", ")
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        selector
      )) {
        link.setAttribute(HOOKED_ATTR, "1")
        link.addEventListener(
          "click",
          (event) => {
            event.preventDefault()
            event.stopPropagation()
            if ((link.getAttribute("href") ?? "").startsWith(COMPOSE_PATH)) {
              openComposer()
              return
            }
            openViewer(null)
          },
          true
        )
      }
    }

    hookLinks()
    const observer = new MutationObserver(hookLinks)
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    })
    return () => observer.disconnect()
  }, [])

  return (
    <>
      {viewerOpen && (
        <DmViewer
          initialConversationId={conversationId}
          onNewMessage={openComposer}
          onClose={() => setViewerOpen(false)}
        />
      )}
      {composerOpen && (
        <DmComposer
          onClose={() => setComposerOpen(false)}
          onOpenConversation={openViewer}
        />
      )}
    </>
  )
}
