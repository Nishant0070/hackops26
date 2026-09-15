import React from "react"
import ReactMarkdown from "react-markdown"
import { cn } from "@/lib/utils"

export function Markdown({ content, className }) {
  if (!content) return null

  return (
    <div
      className={cn(
        "prose prose-sm max-w-none text-inherit leading-relaxed font-sans",
        "[&_p]:mb-2 [&_p:last-child]:mb-0",
        "[&_strong]:font-semibold [&_strong]:text-inherit",
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2 [&_li]:mb-1",
        "[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2 [&_li]:mb-1",
        "[&_h1]:text-base [&_h1]:font-bold [&_h1]:font-serif [&_h1]:my-2",
        "[&_h2]:text-sm [&_h2]:font-bold [&_h2]:font-serif [&_h2]:my-2",
        "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:my-1.5",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-[var(--color-clawde-brass)] [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:my-2",
        "[&_code]:bg-[#E2D9CC]/50 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono",
        className
      )}
    >
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  )
}
