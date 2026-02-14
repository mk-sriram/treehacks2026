"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Phone, Globe, FileSearch } from "lucide-react"

const SOURCE_ICONS = {
  "voice-call": Phone,
  "web-form": Globe,
  "web-scrape": FileSearch,
}

const SOURCE_LABELS = {
  "voice-call": "Voice Call",
  "web-form": "Web Form",
  "web-scrape": "Web Scrape",
}

export function QuotesPanel({ quotes }) {
  if (quotes.length === 0) return null

  const bestQuote = quotes.reduce((min, q) => {
    const minVal = parseFloat(min.unitPrice.replace(/[^0-9.]/g, ""))
    const qVal = parseFloat(q.unitPrice.replace(/[^0-9.]/g, ""))
    return qVal < minVal ? q : min
  }, quotes[0])

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground px-1">
        Quotes Received ({quotes.length})
      </h3>
      <div className="flex flex-col gap-2">
        {quotes.map((quote, i) => {
          const isBest = quote === bestQuote
          const SourceIcon = SOURCE_ICONS[quote.source] ?? Globe

          return (
            <div
              key={i}
              className={cn(
                "rounded-lg border p-3 transition-all",
                isBest
                  ? "bg-primary/5 border-primary/30"
                  : "bg-card/50 border-border/50"
              )}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">
                    {quote.supplier}
                  </span>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <SourceIcon className="h-3 w-3 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground">
                      {SOURCE_LABELS[quote.source] ?? quote.source}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isBest && (
                    <Badge className="bg-primary/20 text-primary border-primary/30 text-[10px] px-1.5 py-0 h-4">
                      Best
                    </Badge>
                  )}
                  <span
                    className={cn(
                      "text-lg font-semibold tabular-nums",
                      isBest ? "text-primary" : "text-foreground"
                    )}
                  >
                    {quote.unitPrice}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">MOQ</span>
                  <span className="text-foreground font-mono">{quote.moq}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Lead Time</span>
                  <span className="text-foreground font-mono">{quote.leadTime}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Shipping</span>
                  <span className="text-foreground font-mono">{quote.shipping}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Terms</span>
                  <span className="text-foreground font-mono">{quote.terms}</span>
                </div>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-700"
                    style={{ width: `${quote.confidence}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-muted-foreground">
                  {quote.confidence}% conf
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
