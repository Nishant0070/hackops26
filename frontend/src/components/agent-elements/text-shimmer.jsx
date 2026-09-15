import React from "react"
import { cn } from "@/lib/utils"

export function TextShimmer({
  children = "Clawde is reviewing the case records...",
  className,
  as: Component = "p",
}) {
  return (
    <Component
      className={cn(
        "inline-block text-sm font-medium bg-gradient-to-r from-[var(--color-clawde-charcoal)] via-[var(--color-clawde-brass)] to-[var(--color-clawde-charcoal)] bg-[length:200%_100%] bg-clip-text text-transparent animate-pulse",
        className
      )}
    >
      {children}
    </Component>
  )
}
