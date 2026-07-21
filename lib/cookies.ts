export function getCookie(name: string): string | null {
  const prefix = `${name}=`
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(prefix)) {
      return part.slice(prefix.length)
    }
  }
  return null
}

export function getCsrfToken(): string | null {
  return getCookie("ct0")
}
