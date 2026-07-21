import * as React from "react"

import { cn } from "~lib/utils"
import { alertVariants, type AlertVariants } from "."

export type AlertProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: AlertVariants["variant"]
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
)
Alert.displayName = "Alert"
