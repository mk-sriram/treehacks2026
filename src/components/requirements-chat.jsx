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
        "flex items-center gap-2.5 px-4 py-2 rounded-full border text-sm font-medium transition-all duration-300",
        found
          ? "bg-primary/10 border-primary/30 text-primary"
          : "bg-muted/50 border-border/50 text-muted-foreground/50"
      )}
    >
      {found ? (
        <CheckCircle2 className="h-4 w-4 shrink-0" />
      ) : (
        <span className="w-4 h-4 rounded-full border-2 border-current shrink-0" />
      )}
      <span>{label}</span>
      {found && value && (
        <span className="text-foreground/90 font-mono truncate max-w-[180px]">
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
      console.error('⚠️ [FALLBACK] OpenAI API extraction failed. Switching to Regex parser.', e);
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

      onComplete(finalRfq)
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
        "min-h-screen flex flex-col items-center justify-center",
        "bg-gradient-to-b from-background via-background to-card/40"
      )}
    >
      <div className="w-full max-w-4xl flex flex-col h-[min(92vh,900px)] px-8 lg:px-12">
        {/* Header - Palantir-style: bold, prominent */}
        <div className="flex flex-col items-center gap-6 pt-12 pb-8">
          <div className="flex items-center justify-center w-20 h-20 rounded-2xl bg-primary/10 border border-primary/20 shadow-xl shadow-primary/5">
            <Zap className="h-10 w-10 text-primary" />
          </div>
          <div className="flex flex-col items-center gap-3">
            <h1 className="text-4xl lg:text-5xl font-bold text-foreground tracking-tight font-[family-name:var(--font-display)]">
              Procure
            </h1>
            <p className="text-base lg:text-lg text-muted-foreground/80 text-center text-pretty max-w-xl leading-relaxed">
              Describe what you need to source. The agent will parse your
              requirements and kick off the full procurement workflow.
            </p>
          </div>
        </div>

        {/* Extraction chips - larger */}
        <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
          <ExtractionChip label="Item" value={extraction.item} found={!!extraction.item} />
          <ExtractionChip label="Qty" value={extraction.quantity} found={!!extraction.quantity} />
          <ExtractionChip label="Lead Time" value={extraction.leadTime} found={!!extraction.leadTime} />
          <ExtractionChip label="Quality" value={extraction.quality} found={!!extraction.quality} />
        </div>

        {/* Messages */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="flex flex-col gap-5 pb-6">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  "flex gap-4",
                  msg.role === "user" ? "justify-end" : "justify-start"
                )}
              >
                {msg.role === "agent" && (
                  <div className="flex items-start pt-1.5 shrink-0">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                      <Sparkles className="h-5 w-5 text-primary" />
                    </div>
                  </div>
                )}
                <div
                  className={cn(
                    "max-w-[82%] rounded-2xl px-5 py-4 text-base lg:text-lg leading-relaxed",
                    msg.role === "user"
                      ? "bg-primary/10 text-foreground border border-primary/20"
                      : "bg-card text-foreground border border-border/50"
                  )}
                >
                  {msg.content.split("\n").map((line, i) => {
                    if (line.startsWith("**") && line.includes("**")) {
                      const parts = line.split("**")
                      return (
                        <p key={i} className={cn(i > 0 && "mt-2")}>
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
                      <p key={i} className={cn(i > 0 && "mt-2")}>
                        {line}
                      </p>
                    )
                  })}
                </div>
              </div>
            ))}

            {isThinking && (
              <div className="flex gap-4 justify-start">
                <div className="flex items-start pt-1.5 shrink-0">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Sparkles className="h-5 w-5 text-primary" />
                  </div>
                </div>
                <div className="bg-card border border-border/50 rounded-2xl px-5 py-4 flex items-center gap-3">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span className="text-base lg:text-lg text-muted-foreground">
                    Parsing requirements...
                  </span>
                </div>
              </div>
            )}

            {isTransitioning && (
              <div className="flex justify-center py-8">
                <div className="flex items-center gap-4 bg-primary/10 border border-primary/20 rounded-full px-8 py-4 shadow-xl shadow-primary/5">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span className="text-base lg:text-lg font-semibold text-primary font-[family-name:var(--font-display)]">
                    Launching procurement workflow
                  </span>
                  <ArrowRight className="h-5 w-5 text-primary" />
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        {/* Example prompts - larger, more prominent */}
        {messages.length <= 1 && (
          <div className="flex flex-col gap-4 mb-6">
            <span className="text-xs lg:text-sm uppercase tracking-[0.2em] text-muted-foreground/50 text-center font-semibold">
              Try an example
            </span>
            <div className="flex flex-col gap-2">
              {EXAMPLE_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => handleExampleClick(prompt)}
                  className="text-left text-sm lg:text-base text-muted-foreground/80 hover:text-foreground bg-card/70 hover:bg-card border border-border/40 hover:border-primary/20 rounded-xl px-5 py-4 transition-all duration-200 hover:shadow-md"
                >
                  <Package className="h-5 w-5 inline mr-3 opacity-50" />
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input - larger, professional */}
        <div className="pb-10 pt-4">
          <div className="relative flex items-end gap-3 bg-card border border-border/50 rounded-2xl px-5 py-4 focus-within:border-primary/40 focus-within:shadow-xl focus-within:shadow-primary/5 transition-all duration-200">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe your procurement needs..."
              disabled={isThinking || isTransitioning}
              rows={1}
              className="flex-1 bg-transparent text-base lg:text-lg text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none min-h-[32px] max-h-[140px]"
              style={{ height: "auto" }}
              onInput={(e) => {
                const target = e.target
                target.style.height = "auto"
                target.style.height = `${Math.min(target.scrollHeight, 140)}px`
              }}
            />
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!input.trim() || isThinking || isTransitioning}
              className="h-11 w-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 shrink-0 shadow-md"
            >
              <Send className="h-5 w-5" />
              <span className="sr-only">Send message</span>
            </Button>
          </div>
          <div className="flex items-center justify-center mt-3">
            <span className="text-xs text-muted-foreground/40 tracking-wide">
              Press Enter to send
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
