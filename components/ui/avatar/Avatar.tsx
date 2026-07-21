import * as React from "react"

import { cn } from "~lib/utils"
import { avatarVariant, type AvatarVariants } from "."

export type AvatarProps = React.HTMLAttributes<HTMLDivElement> & {
  size?: AvatarVariants["size"]
  shape?: AvatarVariants["shape"]
}

export const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ className, size = "sm", shape = "circle", ...props }, ref) => (
    <div
      ref={ref}
      className={cn("relative", avatarVariant({ size, shape }), className)}
      {...props}
    />
  )
)
Avatar.displayName = "Avatar"
