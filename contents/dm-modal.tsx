import cssText from "data-text:~styles/globals.css"
import type { PlasmoCSConfig, PlasmoGetStyle } from "plasmo"
import { useEffect, useState } from "react"

import DmComposer from "~components/DmComposer"
import { COMPOSE_PATH } from "~lib/constants"

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
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function hookComposeLinks() {
      const links = document.querySelectorAll<HTMLAnchorElement>(
        `a[href^="${COMPOSE_PATH}"]:not([${HOOKED_ATTR}])`
      )
      for (const link of links) {
        if (link.closest('[role="menuitem"]')) {
          continue
        }
        link.setAttribute(HOOKED_ATTR, "1")
        link.addEventListener(
          "click",
          (event) => {
            event.preventDefault()
            event.stopPropagation()
            setOpen(true)
          },
          true
        )
      }
    }

    hookComposeLinks()
    const observer = new MutationObserver(hookComposeLinks)
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    })
    return () => observer.disconnect()
  }, [])

  return open ? <DmComposer onClose={() => setOpen(false)} /> : null
}
