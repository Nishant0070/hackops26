import React, { useRef } from "react"
import { Send, Mic, MicOff, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

export function InputBar({
  value,
  onChange,
  onSend,
  isLoading = false,
  placeholder = "Ask Clawde about this document...",
  suggestions = [],
  onSelectSuggestion,
  isListening = false,
  onToggleSpeech,
  className,
}) {
  const textareaRef = useRef(null)

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (!isLoading && value.trim()) {
        onSend(value)
      }
    }
  }

  const handleSendClick = () => {
    if (!isLoading && value.trim()) {
      onSend(value)
    }
  }

  return (
    <div className={cn("flex flex-col gap-2 w-full", className)}>
      {suggestions && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1">
          {suggestions.map((s, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => onSelectSuggestion ? onSelectSuggestion(s) : onSend(s)}
              className="text-xs px-2.5 py-1 rounded-full bg-[var(--color-clawde-parchment)] border border-[#E2D9CC] text-[var(--color-clawde-charcoal)] hover:bg-[#EAE2D2] hover:border-[var(--color-clawde-brass)] transition-colors text-left"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* No <form> tag used, per strict project guidelines */}
      <div className="relative flex items-center bg-[var(--color-clawde-offwhite)] rounded-xl border border-[#E2D9CC] focus-within:border-[var(--color-clawde-brass)] focus-within:ring-1 focus-within:ring-[var(--color-clawde-brass)] shadow-sm transition-all overflow-hidden">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isLoading}
          className="flex-1 bg-transparent py-3 pl-3 pr-20 text-sm text-[var(--color-clawde-charcoal)] placeholder:text-gray-400 focus:outline-none resize-none min-h-[44px] max-h-[120px]"
        />

        <div className="absolute right-2 flex items-center gap-1">
          {onToggleSpeech && (
            <button
              type="button"
              onClick={onToggleSpeech}
              title={isListening ? "Stop listening" : "Speak question"}
              className={cn(
                "p-1.5 rounded-lg text-gray-500 hover:text-[var(--color-clawde-ink)] hover:bg-[#EAE2D2]/50 transition-colors",
                isListening && "text-[var(--color-clawde-oxblood)] bg-red-100 animate-pulse"
              )}
            >
              {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          )}

          <button
            type="button"
            onClick={handleSendClick}
            disabled={isLoading || !value.trim()}
            className="p-1.5 rounded-lg bg-[var(--color-clawde-ink)] text-[var(--color-clawde-offwhite)] hover:bg-[var(--color-clawde-ink)]/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            title="Send"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
