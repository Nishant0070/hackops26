import React, { useEffect, useRef, useState } from "react"
import { Copy, Check, Volume2, VolumeX, AlertTriangle, FileText, Info } from "lucide-react"
import { cn } from "@/lib/utils"
import { Markdown } from "./markdown"
import { TextShimmer } from "./text-shimmer"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

export function MessageList({
  messages = [],
  isLoading = false,
  onSpeak,
  speakingIndex = null,
  onStopSpeech,
  className,
}) {
  const containerRef = useRef(null)
  const [copiedId, setCopiedId] = useState(null)

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [messages, isLoading])

  const handleCopy = (text, id) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => {
      setCopiedId(null)
    }, 2000)
  }

  return (
    <div
      ref={containerRef}
      className={cn("flex-1 overflow-y-auto space-y-4 p-4 pr-2", className)}
    >
      {messages.map((msg, index) => {
        const isUser = msg.role === "user"
        const isAssistant = msg.role === "assistant"
        const msgId = msg.id || index
        const isCopied = copiedId === msgId
        const isSpeakingThis = speakingIndex === index

        return (
          <div
            key={msgId}
            className={cn(
              "flex flex-col max-w-[88%]",
              isUser ? "ml-auto items-end" : "mr-auto items-start"
            )}
          >
            {/* User message */}
            {isUser && (
              <div className="bg-[var(--color-clawde-ink)] text-[var(--color-clawde-offwhite)] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm shadow-sm">
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
            )}

            {/* Assistant message */}
            {isAssistant && (
              <div className="flex flex-col gap-2 w-full">
                {/* Source Badge Pill */}
                {msg.source && (
                  <div className="flex items-center gap-1.5">
                    {msg.cross_document && msg.source_filename ? (
                      <Badge
                        variant="secondary"
                        className="text-[11px] font-medium tracking-wide flex items-center gap-1 border border-[#E2D9CC] bg-[var(--color-clawde-brass)]/20 text-[var(--color-clawde-ink)]"
                      >
                        <FileText className="w-3 h-3 text-[var(--color-clawde-ink)]" />
                        Answer drawn from another filing in this case: {msg.source_filename}
                      </Badge>
                    ) : msg.source === "general" ? (
                      <Badge
                        variant="brass"
                        className="text-[11px] font-medium tracking-wide flex items-center gap-1 shadow-sm"
                      >
                        <Info className="w-3 h-3" />
                        General guidance — not from your document
                      </Badge>
                    ) : (
                      <Badge
                        variant="secondary"
                        className="text-[11px] font-medium tracking-wide flex items-center gap-1 border border-[#E2D9CC]"
                      >
                        <FileText className="w-3 h-3 text-[var(--color-clawde-ink)]" />
                        From your document
                      </Badge>
                    )}
                  </div>
                )}

                {/* Main bubble */}
                <div className="bg-[var(--color-clawde-parchment)] border border-[#E2D9CC] text-[var(--color-clawde-charcoal)] rounded-2xl rounded-tl-sm p-4 text-sm shadow-sm w-full">
                  <Markdown content={msg.content} />

                  {/* Unverified Figure Safety Alert */}
                  {msg.unverifiedFigure && (
                    <Alert variant="warning" className="mt-3 py-2 px-3 text-xs">
                      <AlertTriangle className="w-4 h-4 text-[var(--color-clawde-brass)]" />
                      <div>
                        <AlertTitle className="text-xs font-bold text-[var(--color-clawde-charcoal)]">
                          Limitation / Timeline Verification Required
                        </AlertTitle>
                        <AlertDescription className="text-xs text-[var(--color-clawde-charcoal)]/90 mt-0.5">
                          This general advice mentions specific timelines or statutory periods. Because local court rules and High Court amendments vary by state, please verify this figure with an advocate or the relevant court registry.
                        </AlertDescription>
                      </div>
                    </Alert>
                  )}

                  {/* Bottom toolbar: Copy + Audio */}
                  <div className="flex items-center justify-end gap-2 mt-3 pt-2 border-t border-[#E2D9CC]/60 text-xs text-gray-500">
                    <button
                      type="button"
                      onClick={() => handleCopy(msg.content, msgId)}
                      className="p-1 rounded hover:bg-[#EAE2D2] transition-colors flex items-center gap-1"
                      title="Copy response"
                    >
                      {isCopied ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-green-700" />
                          <span className="text-[10px] text-green-700">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span className="text-[10px]">Copy</span>
                        </>
                      )}
                    </button>

                    {onSpeak && (
                      <button
                        type="button"
                        onClick={() =>
                          isSpeakingThis ? onStopSpeech?.() : onSpeak(msg.content, index)
                        }
                        className={cn(
                          "p-1 rounded hover:bg-[#EAE2D2] transition-colors flex items-center gap-1",
                          isSpeakingThis && "text-[var(--color-clawde-oxblood)] font-medium"
                        )}
                        title={isSpeakingThis ? "Stop speaking" : "Read aloud"}
                      >
                        {isSpeakingThis ? (
                          <>
                            <VolumeX className="w-3.5 h-3.5" />
                            <span className="text-[10px]">Stop</span>
                          </>
                        ) : (
                          <>
                            <Volume2 className="w-3.5 h-3.5" />
                            <span className="text-[10px]">Listen</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* Loading state indicator */}
      {isLoading && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-[var(--color-clawde-parchment)] border border-[#E2D9CC] w-fit shadow-sm">
          <TextShimmer />
        </div>
      )}
    </div>
  )
}
