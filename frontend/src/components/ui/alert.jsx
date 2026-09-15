import * as React from "react"
import { cva } from "class-variance-authority"
import { cn } from "@/lib/utils"

const alertVariants = cva(
  "relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground",
  {
    variants: {
      variant: {
        default: "bg-[var(--color-clawde-parchment)] text-[var(--color-clawde-charcoal)] border-[#E2D9CC]",
        destructive:
          "border-[var(--color-clawde-oxblood)]/50 text-[var(--color-clawde-oxblood)] bg-[var(--color-clawde-oxblood)]/10 dark:border-[var(--color-clawde-oxblood)] [&>svg]:text-[var(--color-clawde-oxblood)]",
        warning:
          "border-[var(--color-clawde-brass)]/50 text-[var(--color-clawde-charcoal)] bg-[var(--color-clawde-brass)]/10 [&>svg]:text-[var(--color-clawde-brass)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const Alert = React.forwardRef(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
))
Alert.displayName = "Alert"

const AlertTitle = React.forwardRef(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn("mb-1 font-medium leading-none tracking-tight", className)}
    {...props}
  />
))
AlertTitle.displayName = "AlertTitle"

const AlertDescription = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm [&_p]:leading-relaxed", className)}
    {...props}
  />
))
AlertDescription.displayName = "AlertDescription"

export { Alert, AlertTitle, AlertDescription }
