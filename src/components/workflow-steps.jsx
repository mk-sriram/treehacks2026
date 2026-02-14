"use client"

import { cn } from "@/lib/utils"
import { STAGE_CONFIG } from "@/lib/agent-types"
import {
  Search,
  Phone,
  Globe,
  Handshake,
  CreditCard,
  CheckCircle2,
} from "lucide-react"

const STAGE_ICONS = {
  finding_suppliers: Search,
  calling_for_quote: Phone,
  requesting_web_quote: Globe,
  negotiating: Handshake,
  paying_deposit: CreditCard,
  complete: CheckCircle2,
}

const ORDERED_STAGES = [
  "finding_suppliers",
  "calling_for_quote",
  "requesting_web_quote",
  "negotiating",
  "paying_deposit",
]

export function WorkflowSteps({ currentStage }) {
  const currentIndex = STAGE_CONFIG[currentStage]?.index ?? 0

  return (
    <div className="flex flex-col gap-1">
      {ORDERED_STAGES.map((stage) => {
        const config = STAGE_CONFIG[stage]
        const Icon = STAGE_ICONS[stage] ?? Search
        const stageIndex = config.index
        const isActive = stage === currentStage
        const isDone = currentIndex > stageIndex
        const isPending = currentIndex < stageIndex

        return (
          <div
            key={stage}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 rounded-md transition-all duration-300",
              isActive && "bg-primary/10 border border-primary/30",
              isDone && "opacity-70",
              isPending && "opacity-30"
            )}
          >
            <div
              className={cn(
                "flex items-center justify-center w-8 h-8 rounded-full shrink-0 transition-all duration-300",
                isActive && "bg-primary/20 text-primary",
                isDone && "bg-primary/10 text-primary",
                isPending && "bg-muted text-muted-foreground"
              )}
            >
              {isDone ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <Icon className="h-4 w-4" />
              )}
            </div>
            <div className="flex flex-col min-w-0">
              <span
                className={cn(
                  "text-sm font-medium leading-tight",
                  isActive && "text-primary",
                  isDone && "text-foreground",
                  isPending && "text-muted-foreground"
                )}
              >
                {config.label}
              </span>
              {isActive && (
                <span className="text-xs text-muted-foreground mt-0.5 truncate">
                  {config.description}
                </span>
              )}
            </div>
            {isActive && (
              <div className="ml-auto flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse [animation-delay:200ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse [animation-delay:400ms]" />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
