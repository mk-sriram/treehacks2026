"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  Send,
  Zap,
  Package,
  Loader2,
  CheckCircle2,
  ArrowRight,
  Sparkles,
} from "lucide-react"

const AGENT_INTRO = {
  id: "intro",
  role: "agent",
  content:
    "What are you looking to procure? Describe the item, quantity, and any constraints like lead time, quality standards, or preferred location. I'll handle the rest.",
  timestamp: new Date(),
}

const EXAMPLE_PROMPTS = [
  "25k stainless steel M8 hex bolts, ISO 9001, need in 30 days, prefer Shenzhen",
  "500 units 1/4\" quarter-turn ball valves, brass, NPT, need WRAS certified",
  "10,000 custom PCBs, 4-layer FR4, ENIG finish, need in 3 weeks from Guangdong",
]

function parseRequirements(messages) {
  const allText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" ")
    .toLowerCase()

  const result = {}

  // Extract quantity
  const qtyMatch = allText.match(
    /(\d[\d,]*)\s*(k\b|units?|pcs?|pieces?|qty)/i
  )
  if (qtyMatch) {
    let qty = qtyMatch[1].replace(/,/g, "")
    if (qtyMatch[2]?.toLowerCase() === "k") {
      qty = (parseInt(qty) * 1000).toString()
    }
    result.quantity = parseInt(qty).toLocaleString()
  }

  // Extract lead time
  const ltMatch = allText.match(
    /(\d+)\s*(days?|weeks?|months?)/i
  )
  if (ltMatch) {
    const num = parseInt(ltMatch[1])
    const unit = ltMatch[2].toLowerCase()
    if (unit.startsWith("week")) {
      result.leadTime = `${num * 7} days`
    } else if (unit.startsWith("month")) {
      result.leadTime = `${num * 30} days`
    } else {
      result.leadTime = `${num} days`
    }
  }

  // Extract quality/certs
  const certPatterns = [
    /iso\s*\d+/gi,
    /din\s*\d+/gi,
    /astm\s*[\w-]+/gi,
    /wras/gi,
    /ce\b/gi,
    /rohs/gi,
    /ul\s*\d*/gi,
    /enig/gi,
  ]
  const certs = []
  for (const pattern of certPatterns) {
    const matches = allText.match(pattern)
    if (matches) certs.push(...matches.map((m) => m.toUpperCase()))
  }
  if (certs.length > 0) {
    result.quality = [...new Set(certs)].join(", ")
  }

  // Extract location
  const locationPatterns = [
    /(?:from|in|near|prefer|located?\s+(?:in|at)?)\s+([A-Z][a-z]+(?:[\s,]+[A-Z][a-z]+)*)/g,
  ]
  for (const pattern of locationPatterns) {
    const match = pattern.exec(messages.map((m) => m.content).join(" "))
    if (match) {
      result.location = match[1].trim()
    }
  }

  // Common cities
  const cities = [
    "shenzhen",
    "guangzhou",
    "dongguan",
    "shanghai",
    "beijing",
    "guangdong",
    "zhejiang",
    "jiangsu",
    "taiwan",
    "vietnam",
    "india",
    "japan",
    "korea",
  ]
  for (const city of cities) {
    if (allText.includes(city)) {
      result.location =
        city.charAt(0).toUpperCase() + city.slice(1) + ", China"
      break
    }
  }

  // Extract item (everything that's not a constraint)
  const itemText = messages.find((m) => m.role === "user")?.content ?? ""
  if (itemText) {
    let item = itemText
      .replace(/\d[\d,]*\s*(k\b|units?|pcs?|pieces?|qty)/gi, "")
      .replace(
        /(?:need\s+)?(?:in|within)\s+\d+\s*(days?|weeks?|months?)/gi,
        ""
      )
      .replace(/(?:from|in|near|prefer)\s+\w+(?:[\s,]+\w+)*/gi, "")
      .replace(/iso\s*\d+/gi, "")
      .replace(/din\s*\d+/gi, "")
      .replace(/,\s*,/g, ",")
      .replace(/^[\s,]+|[\s,]+$/g, "")
      .trim()
    if (item.length > 5) {
      result.item = item
    }
  }

  return result
}

function getAgentResponse(extraction, messageCount) {
  const missing = []
  if (!extraction.item) missing.push("item description")
  if (!extraction.quantity) missing.push("quantity needed")
  if (!extraction.leadTime) missing.push("lead time requirement")
  if (!extraction.quality) missing.push("quality standards")

  if (missing.length === 0) {
    return `Got it. Here's what I've extracted:\n\n**Item:** ${extraction.item}\n**Quantity:** ${extraction.quantity}\n**Lead Time:** ${extraction.leadTime}\n**Quality:** ${extraction.quality}\n\nLooks good to proceed. I'll start the procurement workflow now.`
  }

  if (messageCount <= 1) {
    if (missing.length <= 2) {
      return `Almost there. I still need: ${missing.join(" and ")}. Or say "go" and I'll work with what I have.`
    }
    return `I got some of that. Could you also specify: ${missing.join(", ")}? Or just say "go" to proceed with defaults.`
  }

  return `Thanks. Still missing: ${missing.join(", ")}. Say "go" to start with what I have, or add more details.`
}

function ExtractionChip({ label, value, found }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs transition-all duration-300",
        found
          ? "bg-primary/10 border-primary/30 text-primary"
          : "bg-muted/50 border-border/50 text-muted-foreground/50"
      )}
    >
      {found ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <span className="w-3 h-3 rounded-full border border-current" />
      )}
      <span className="font-medium">{label}</span>
      {found && value && (
        <span className="text-foreground/80 font-mono truncate max-w-[140px]">
          {value}
        </span>
      )}
    </div>
  )
}

export function RequirementsChat({ onComplete }) {
  const [messages, setMessages] = useState([AGENT_INTRO])
  const [input, setInput] = useState("")
  const [isThinking, setIsThinking] = useState(false)
  const [extraction, setExtraction] = useState({})
  const [isTransitioning, setIsTransitioning] = useState(false)
  const inputRef = useRef(null)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, isThinking])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || isThinking) return

    const userMsg = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMsg])
    setInput("")
    setIsThinking(true)

    // Minimum delay for UI feel (so it doesn't flash too fast)
    const minDelay = new Promise(resolve => setTimeout(resolve, 600));
    
    // Call LLM extraction API
    const allMessages = [...messages, userMsg];
    let extracted = {};
    
    try {
      const [res] = await Promise.all([
        fetch('/api/extract-requirements', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ messages: allMessages })
        }),
        minDelay
      ]);

      if (res.ok) {
        const data = await res.json();
        extracted = data.extraction || {};
        console.log('OpenAI extraction:', extracted);
      } else {
        throw new Error(`API error ${res.status}`);
      }
    } catch (e) {
      console.error('⚠️ [FALLBACK] Gemini API extraction failed. Switching to Regex parser.', e);
      extracted = parseRequirements(allMessages) || {};
    }

    setExtraction(extracted)

    const wantsToGo =
      text.toLowerCase().includes("go") ||
      text.toLowerCase().includes("start") ||
      text.toLowerCase().includes("proceed") ||
      text.toLowerCase().includes("run") ||
      text.toLowerCase().includes("looks good") ||
      text.toLowerCase().includes("let's do it") ||
      text.toLowerCase().includes("yes")

    const hasEnough =
      (extracted.item && extracted.item.length > 2 && extracted.quantity) || allMessages.length >= 5

    if (wantsToGo || (hasEnough && Object.keys(extracted).length >= 3)) { // Slightly relaxed count
      const finalRfq = {
        item: extracted.item || "Custom procurement item",
        quantity: extracted.quantity || "1,000",
        leadTime: extracted.leadTime || "30 days",
        quality: extracted.quality || "Standard",
        location: extracted.location || "Auto-detected",
      }

      const confirmMsg = {
        id: `agent-${Date.now()}`,
        role: "agent",
        content: `Locked in. Starting procurement agent now.\n\n**${finalRfq.item}** -- ${finalRfq.quantity}\nLead time: ${finalRfq.leadTime} | Quality: ${finalRfq.quality}`,
        timestamp: new Date(),
        extraction: finalRfq,
      }

      setMessages((prev) => [...prev, confirmMsg])
      setIsThinking(false)
      setIsTransitioning(true)

      setTimeout(() => onComplete(finalRfq), 2000)
    } else {
      const userMessageCount = allMessages.filter(
        (m) => m.role === "user"
      ).length
      const responseText = getAgentResponse(extracted, userMessageCount)

      const agentMsg = {
        id: `agent-${Date.now()}`,
        role: "agent",
        content: responseText,
        timestamp: new Date(),
        extraction: extracted,
      }

      setMessages((prev) => [...prev, agentMsg])
      setIsThinking(false)
    }
  }, [input, isThinking, messages, onComplete])

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleExampleClick = (prompt) => {
    setInput(prompt)
    inputRef.current?.focus()
  }

  return (
    <div
      className={cn(
        "min-h-screen bg-background flex flex-col items-center justify-center transition-all duration-700",
        isTransitioning && "opacity-0 scale-95"
      )}
    >
      <div className="w-full max-w-2xl flex flex-col h-[min(90vh,800px)] px-4">
        {/* Header */}
        <div className="flex flex-col items-center gap-3 py-8">
          <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-primary/15 border border-primary/20">
            <Zap className="h-6 w-6 text-primary" />
          </div>
          <div className="flex flex-col items-center gap-1">
            <h1 className="text-xl font-semibold text-foreground text-balance text-center">
              Procurement Agent
            </h1>
            <p className="text-sm text-muted-foreground text-center text-pretty max-w-md">
              Describe what you need to source. The agent will parse your
              requirements and kick off the full procurement workflow.
            </p>
          </div>
        </div>

        {/* Extraction chips */}
        <div className="flex flex-wrap items-center justify-center gap-2 mb-4">
          <ExtractionChip label="Item" value={extraction.item} found={!!extraction.item} />
          <ExtractionChip label="Qty" value={extraction.quantity} found={!!extraction.quantity} />
          <ExtractionChip label="Lead Time" value={extraction.leadTime} found={!!extraction.leadTime} />
          <ExtractionChip label="Quality" value={extraction.quality} found={!!extraction.quality} />
        </div>

        {/* Messages */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="flex flex-col gap-3 pb-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  "flex gap-3",
                  msg.role === "user" ? "justify-end" : "justify-start"
                )}
              >
                {msg.role === "agent" && (
                  <div className="flex items-start pt-1 shrink-0">
                    <div className="w-7 h-7 rounded-lg bg-primary/15 border border-primary/20 flex items-center justify-center">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                    </div>
                  </div>
                )}
                <div
                  className={cn(
                    "max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed",
                    msg.role === "user"
                      ? "bg-primary/15 text-foreground border border-primary/20"
                      : "bg-secondary/80 text-foreground border border-border/50"
                  )}
                >
                  {msg.content.split("\n").map((line, i) => {
                    if (line.startsWith("**") && line.includes("**")) {
                      const parts = line.split("**")
                      return (
                        <p key={i} className={cn(i > 0 && "mt-1")}>
                          {parts.map((part, j) =>
                            j % 2 === 1 ? (
                              <span key={j} className="font-semibold text-foreground">
                                {part}
                              </span>
                            ) : (
                              <span key={j}>{part}</span>
                            )
                          )}
                        </p>
                      )
                    }
                    if (line === "") return <br key={i} />
                    return (
                      <p key={i} className={cn(i > 0 && "mt-1")}>
                        {line}
                      </p>
                    )
                  })}
                </div>
              </div>
            ))}

            {isThinking && (
              <div className="flex gap-3 justify-start">
                <div className="flex items-start pt-1 shrink-0">
                  <div className="w-7 h-7 rounded-lg bg-primary/15 border border-primary/20 flex items-center justify-center">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                  </div>
                </div>
                <div className="bg-secondary/80 border border-border/50 rounded-xl px-4 py-3 flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">
                    Parsing requirements...
                  </span>
                </div>
              </div>
            )}

            {isTransitioning && (
              <div className="flex justify-center py-4">
                <div className="flex items-center gap-2 bg-primary/10 border border-primary/30 rounded-full px-5 py-2.5">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span className="text-sm font-medium text-primary">
                    Launching procurement workflow...
                  </span>
                  <ArrowRight className="h-4 w-4 text-primary" />
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        {/* Example prompts */}
        {messages.length <= 1 && (
          <div className="flex flex-col gap-2 mb-3">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50 text-center">
              Try an example
            </span>
            <div className="flex flex-col gap-1.5">
              {EXAMPLE_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => handleExampleClick(prompt)}
                  className="text-left text-xs text-muted-foreground hover:text-foreground bg-secondary/50 hover:bg-secondary border border-border/50 hover:border-border rounded-lg px-3 py-2.5 transition-all"
                >
                  <Package className="h-3 w-3 inline mr-2 opacity-50" />
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input */}
        <div className="pb-6 pt-2">
          <div className="relative flex items-end gap-2 bg-secondary/80 border border-border/50 rounded-xl px-4 py-3 focus-within:border-primary/30 transition-colors">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe your procurement needs..."
              disabled={isThinking || isTransitioning}
              rows={1}
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none min-h-[24px] max-h-[120px]"
              style={{ height: "auto" }}
              onInput={(e) => {
                const target = e.target
                target.style.height = "auto"
                target.style.height = `${Math.min(target.scrollHeight, 120)}px`
              }}
            />
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!input.trim() || isThinking || isTransitioning}
              className="h-8 w-8 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
            >
              <Send className="h-4 w-4" />
              <span className="sr-only">Send message</span>
            </Button>
          </div>
          <div className="flex items-center justify-center mt-2">
            <Badge
              variant="outline"
              className="text-[10px] text-muted-foreground/50 border-border/30"
            >
              Press Enter to send
            </Badge>
          </div>
        </div>
      </div>
    </div>
  )
}
