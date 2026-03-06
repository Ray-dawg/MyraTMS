"use client"

import { useState, useRef, useEffect } from "react"
import { X, Sparkles, Send, ArrowRight, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"

const quickActions = [
  { label: "Summarize active loads", prompt: "Summarize all active loads - their statuses, origins, destinations, and any risk flags" },
  { label: "Financial overview", prompt: "Give me a financial overview including revenue, margin, and any overdue invoices" },
  { label: "Identify at-risk loads", prompt: "Which loads are currently at risk and why?" },
  { label: "Carrier compliance check", prompt: "Check carrier compliance status across the network. Flag any issues with authority, insurance, or safety ratings." },
]

const transport = new DefaultChatTransport({ api: "/api/ai/chat" })

export function AIAssistant({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [inputValue, setInputValue] = useState("")
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const { messages, sendMessage, status } = useChat({ transport })

  const isStreaming = status === "streaming" || status === "submitted"

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const handleSubmit = (text: string) => {
    if (!text.trim() || isStreaming) return
    sendMessage({ text: text.trim() })
    setInputValue("")
  }

  if (!open) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-96 flex-col rounded-lg border border-border bg-card shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent" />
          <span className="text-sm font-medium text-card-foreground">Myra AI</span>
          {isStreaming && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
          <span className="sr-only">Close AI assistant</span>
        </Button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 max-h-80 min-h-48 scrollbar-thin">
        {messages.length === 0 ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              How can I help you today? I can look up loads, carriers, and financial data in real-time.
            </p>
            <div className="space-y-1.5">
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  onClick={() => handleSubmit(action.prompt)}
                  className="flex w-full items-center justify-between rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs text-foreground hover:bg-secondary/60 transition-colors"
                >
                  <span>{action.label}</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "rounded-md px-3 py-2 text-xs leading-relaxed",
                msg.role === "user"
                  ? "bg-accent/10 text-foreground ml-8"
                  : "bg-secondary/50 text-foreground mr-4"
              )}
            >
              {msg.role === "assistant" && (
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Sparkles className="h-3 w-3 text-accent" />
                  <span className="text-[10px] font-medium text-muted-foreground">Myra AI</span>
                </div>
              )}
              <div className="whitespace-pre-wrap">
                {msg.parts
                  ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
                  .map((p) => p.text)
                  .join("") || ""}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSubmit(inputValue)
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Ask Myra AI..."
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <Button
            type="submit"
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-accent"
            disabled={!inputValue.trim() || isStreaming}
          >
            {isStreaming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            <span className="sr-only">Send message</span>
          </Button>
        </form>
      </div>
    </div>
  )
}
