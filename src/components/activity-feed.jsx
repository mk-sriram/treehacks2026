"use client"

import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Search,
  Globe,
  Phone,
  FileText,
  Brain,
  Handshake,
  CreditCard,
  Database,
  Cpu,
  CheckCircle2,
  Loader2,
  AlertCircle,
  GitBranch,
} from "lucide-react"

const TYPE_CONFIG = {
  search: {
    icon: Search,
    color: "text-[hsl(199,89%,48%)]",
    badgeColor: "bg-[hsl(199,89%,48%)]/10 text-[hsl(199,89%,48%)] border-[hsl(199,89%,48%)]/20",
  },
  browse: {
    icon: Globe,
    color: "text-[hsl(262,52%,56%)]",
    badgeColor: "bg-[hsl(262,52%,56%)]/10 text-[hsl(262,52%,56%)] border-[hsl(262,52%,56%)]/20",
  },
  call: {
    icon: Phone,
    color: "text-[hsl(142,71%,45%)]",
    badgeColor: "bg-[hsl(142,71%,45%)]/10 text-[hsl(142,71%,45%)] border-[hsl(142,71%,45%)]/20",
  },
  extract: {
    icon: FileText,
    color: "text-[hsl(45,93%,47%)]",
    badgeColor: "bg-[hsl(45,93%,47%)]/10 text-[hsl(45,93%,47%)] border-[hsl(45,93%,47%)]/20",
  },
  analyze: {
    icon: Brain,
    color: "text-[hsl(199,89%,48%)]",
    badgeColor: "bg-[hsl(199,89%,48%)]/10 text-[hsl(199,89%,48%)] border-[hsl(199,89%,48%)]/20",
  },
  negotiate: {
    icon: Handshake,
    color: "text-[hsl(45,93%,47%)]",
    badgeColor: "bg-[hsl(45,93%,47%)]/10 text-[hsl(45,93%,47%)] border-[hsl(45,93%,47%)]/20",
  },
  payment: {
    icon: CreditCard,
    color: "text-[hsl(142,71%,45%)]",
    badgeColor: "bg-[hsl(142,71%,45%)]/10 text-[hsl(142,71%,45%)] border-[hsl(142,71%,45%)]/20",
  },
  memory: {
    icon: Database,
    color: "text-[hsl(262,52%,56%)]",
    badgeColor: "bg-[hsl(262,52%,56%)]/10 text-[hsl(262,52%,56%)] border-[hsl(262,52%,56%)]/20",
  },
  system: {
    icon: Cpu,
    color: "text-muted-foreground",
    badgeColor: "bg-muted text-muted-foreground border-border",
  },
}

function StatusIndicator({ status }) {
  if (status === "running") {
    return <Loader2 className="h-3 w-3 animate-spin text-primary" />
  }
  if (status === "done") {
    return <CheckCircle2 className="h-3 w-3 text-primary" />
  }
  return <AlertCircle className="h-3 w-3 text-destructive" />
}

function formatTime(date) {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

function ActivityRow({ activity }) {
  const config = TYPE_CONFIG[activity.type]
  const Icon = config.icon

  return (
    <div
      className={cn(
        "flex gap-3 p-3 rounded-lg border transition-all duration-500",
        activity.status === "running"
          ? "bg-card border-primary/20"
          : "bg-card/50 border-border/30"
      )}
    >
      <div
        className={cn(
          "flex items-center justify-center w-8 h-8 rounded-md shrink-0",
          config.color,
          activity.status === "running" ? "bg-card" : "bg-muted/50"
        )}
      >
        <Icon className="h-4 w-4" />
      </div>

      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">
            {activity.title}
          </span>
          <StatusIndicator status={activity.status} />
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {activity.description}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] font-mono text-muted-foreground/60">
            {formatTime(activity.timestamp)}
          </span>
          {activity.tool && (
            <Badge
              variant="outline"
              className={cn("text-[10px] px-1.5 py-0 h-4 font-mono", config.badgeColor)}
            >
              {activity.tool}
            </Badge>
          )}
        </div>
      </div>
    </div>
  )
}

function ParallelGroup({ activities }) {
  const allDone = activities.every((a) => a.status === "done")
  const someRunning = activities.some((a) => a.status === "running")

  return (
    <div className={cn(
      "relative rounded-lg border p-3 transition-all duration-500",
      someRunning
        ? "border-primary/20 bg-primary/[0.02]"
        : allDone
        ? "border-border/30 bg-card/30"
        : "border-border/50 bg-card/50"
    )}>
      <div className="flex items-center gap-2 mb-2">
        <GitBranch className={cn(
          "h-3 w-3",
          someRunning ? "text-primary" : "text-muted-foreground/40"
        )} />
        <span className={cn(
          "text-[10px] font-mono uppercase tracking-wider",
          someRunning ? "text-primary" : "text-muted-foreground/40"
        )}>
          {activities.length} parallel tasks
        </span>
        {someRunning && (
          <span className="flex gap-0.5 ml-auto">
            <span className="w-1 h-1 rounded-full bg-primary animate-pulse" />
            <span className="w-1 h-1 rounded-full bg-primary animate-pulse [animation-delay:150ms]" />
            <span className="w-1 h-1 rounded-full bg-primary animate-pulse [animation-delay:300ms]" />
          </span>
        )}
      </div>

      <div className="relative flex flex-col gap-2 pl-3">
        <div className={cn(
          "absolute left-[5px] top-2 bottom-2 w-[1.5px] rounded-full",
          someRunning ? "bg-primary/30" : "bg-border/50"
        )} />

        {activities.map((activity) => {
          const config = TYPE_CONFIG[activity.type]
          const Icon = config.icon

          return (
            <div
              key={activity.id}
              className={cn(
                "flex gap-3 p-2.5 rounded-md transition-all duration-500 relative",
                activity.status === "running"
                  ? "bg-card/80"
                  : "bg-transparent"
              )}
            >
              <div className={cn(
                "absolute -left-[5.5px] top-4 w-2 h-2 rounded-full border-2",
                activity.status === "running"
                  ? "bg-primary border-primary/50"
                  : activity.status === "done"
                  ? "bg-primary/60 border-primary/30"
                  : "bg-muted border-border"
              )} />

              <div className={cn(
                "flex items-center justify-center w-7 h-7 rounded-md shrink-0",
                config.color,
                activity.status === "running" ? "bg-card" : "bg-muted/30"
              )}>
                <Icon className="h-3.5 w-3.5" />
              </div>

              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground truncate">
                    {activity.title}
                  </span>
                  <StatusIndicator status={activity.status} />
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {activity.description}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[9px] font-mono text-muted-foreground/50">
                    {formatTime(activity.timestamp)}
                  </span>
                  {activity.tool && (
                    <Badge
                      variant="outline"
                      className={cn("text-[9px] px-1 py-0 h-3.5 font-mono", config.badgeColor)}
                    >
                      {activity.tool}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ActivityFeed({ activities }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [activities])

  if (activities.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground/50 text-sm">
        Agent actions will appear here
      </div>
    )
  }

  const groups = []
  const parallelMap = new Map()

  for (const activity of activities) {
    if (activity.parallelGroup) {
      if (!parallelMap.has(activity.parallelGroup)) {
        parallelMap.set(activity.parallelGroup, [])
      }
      parallelMap.get(activity.parallelGroup).push(activity)
    }
  }

  const addedGroups = new Set()
  for (const activity of activities) {
    if (activity.parallelGroup) {
      if (!addedGroups.has(activity.parallelGroup)) {
        addedGroups.add(activity.parallelGroup)
        groups.push({
          type: "parallel",
          items: parallelMap.get(activity.parallelGroup),
          groupId: activity.parallelGroup,
        })
      }
    } else {
      groups.push({ type: "single", item: activity })
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-2 pr-4">
        {groups.map((group) => {
          if (group.type === "parallel") {
            return <ParallelGroup key={group.groupId} activities={group.items} />
          }
          return <ActivityRow key={group.item.id} activity={group.item} />
        })}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}
