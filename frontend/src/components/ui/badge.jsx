import * as React from "react"
import { cva } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[var(--color-clawde-ink)] text-[var(--color-clawde-offwhite)] shadow hover:bg-[var(--color-clawde-ink)]/80",
        secondary:
          "border-transparent bg-[var(--color-clawde-parchment)] text-[var(--color-clawde-ink)] hover:bg-[var(--color-clawde-parchment)]/80",
        destructive:
          "border-transparent bg-[var(--color-clawde-oxblood)] text-[var(--color-clawde-offwhite)] shadow hover:bg-[var(--color-clawde-oxblood)]/80",
        outline: "text-[var(--color-clawde-charcoal)] border-[#E2D9CC]",
        brass:
          "border-transparent bg-[var(--color-clawde-brass)] text-white shadow hover:bg-[var(--color-clawde-brass)]/90",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({ className, variant, ...props }) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
