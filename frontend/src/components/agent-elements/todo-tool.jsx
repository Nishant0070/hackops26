import React from "react"
import { CheckCircle2, Circle, Clock } from "lucide-react"
import { cn } from "@/lib/utils"

export function TodoTool({ items = [], className, title = "Pipeline Steps" }) {
  if (!items || items.length === 0) return null

  return (
    <div
      className={cn(
        "rounded-lg border border-[#E2D9CC] bg-[var(--color-clawde-parchment)] p-3 text-sm text-[var(--color-clawde-charcoal)] shadow-sm",
        className
      )}
    >
      {title && (
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-clawde-ink)]/70 mb-2 font-serif">
          {title}
        </div>
      )}
      <ul className="space-y-2">
        {items.map((item, idx) => {
          const isDone = item.status === "completed" || item.status === "done"
          const isInProgress = item.status === "running" || item.status === "in_progress"
          return (
            <li key={item.id || idx} className="flex items-center gap-2 text-xs">
              {isDone ? (
                <CheckCircle2 className="w-4 h-4 text-green-700 shrink-0" />
              ) : isInProgress ? (
                <Clock className="w-4 h-4 text-[var(--color-clawde-brass)] animate-spin shrink-0" />
              ) : (
                <Circle className="w-4 h-4 text-gray-400 shrink-0" />
              )}
              <span className={cn(isDone && "text-gray-600 line-through")}>
                {item.label || item.text}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
