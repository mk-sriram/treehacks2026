"use client"

import { Badge } from "@/components/ui/badge"
import {
  CheckCircle2,
  TrendingDown,
  Building2,
  Clock,
  ArrowRight,
} from "lucide-react"

export function SummaryPanel({ summary }) {
  if (!summary) return null

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/5 shadow-sm p-5">
      <div className="flex items-center gap-2 mb-4">
        <CheckCircle2 className="h-5 w-5 text-primary" />
        <h3 className="text-base font-semibold text-foreground">
          Procurement Summary
        </h3>
        <Badge className="bg-primary/20 text-primary border-primary/30 text-xs ml-auto">
          Complete
        </Badge>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <div className="flex flex-col gap-1 bg-card/70 rounded-lg p-3 border border-border/40">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Suppliers Found
          </span>
          <span className="text-xl font-semibold text-foreground tabular-nums">
            {summary.suppliersFound}
          </span>
        </div>
        <div className="flex flex-col gap-1 bg-card/70 rounded-lg p-3 border border-border/40">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Quotes Received
          </span>
          <span className="text-xl font-semibold text-foreground tabular-nums">
            {summary.quotesReceived}
          </span>
        </div>
        <div className="flex flex-col gap-1 bg-card/70 rounded-lg p-3 border border-border/40">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <TrendingDown className="h-3 w-3" />
            Best Price
          </span>
          <span className="text-xl font-semibold text-primary tabular-nums">
            {summary.bestPrice}
          </span>
        </div>
        <div className="flex flex-col gap-1 bg-card/70 rounded-lg p-3 border border-border/40">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <TrendingDown className="h-3 w-3" />
            Savings
          </span>
          <span className="text-xl font-semibold text-primary tabular-nums">
            {summary.savings}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3 mb-4">
        <div className="flex items-start gap-2">
          <Building2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">
              Recommended Supplier
            </span>
            <span className="text-sm font-medium text-foreground">
              {summary.bestSupplier}
            </span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Clock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">
              Average Lead Time
            </span>
            <span className="text-sm font-medium text-foreground">
              {summary.avgLeadTime}
            </span>
          </div>
        </div>
      </div>

      <div className="bg-card/70 rounded-lg border border-border/40 p-3 mb-4">
        <span className="text-xs text-muted-foreground block mb-1">
          Recommendation
        </span>
        <p className="text-sm text-foreground leading-relaxed">
          {summary.recommendation}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground uppercase tracking-wider">
          Next Steps
        </span>
        {summary.nextSteps.map((step, i) => (
          <div
            key={i}
            className="flex items-center gap-2 text-sm text-foreground/80"
          >
            <ArrowRight className="h-3 w-3 text-primary shrink-0" />
            {step}
          </div>
        ))}
      </div>
    </div>
  )
}
