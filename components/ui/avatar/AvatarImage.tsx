import * as React from "react"

export type AvatarImageProps = React.ImgHTMLAttributes<HTMLImageElement>

export function AvatarImage({ src, ...props }: AvatarImageProps) {
  const [failed, setFailed] = React.useState(false)
  if (failed || !src) {
    return null
  }
  return (
    <img
      src={src}
      className="absolute inset-0 h-full w-full object-cover"
      onError={() => setFailed(true)}
      {...props}
    />
  )
}
