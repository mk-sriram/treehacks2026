"use client"

import { useEffect, useState, useRef, useMemo } from "react"
import { cn } from "@/lib/utils"
import { Phone, PhoneOff, Mic, Database, CheckCircle2, Loader2 } from "lucide-react"

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
}

function AudioLine({ active }) {
  const canvasRef = useRef(null)
  const frameRef = useRef(0)
  const phaseRef = useRef(Math.random() * Math.PI * 2)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)

    let animId

    const draw = () => {
      ctx.clearRect(0, 0, w, h)

      if (!active) {
        ctx.beginPath()
        ctx.strokeStyle = "hsl(215 15% 16%)"
        ctx.lineWidth = 1
        ctx.setLineDash([4, 4])
        ctx.moveTo(0, h / 2)
        ctx.lineTo(w, h / 2)
        ctx.stroke()
        ctx.setLineDash([])
        return
      }

      const greenHsl = "142, 71%, 45%"
      const time = frameRef.current * 0.035 + phaseRef.current

      // Main wave
      ctx.beginPath()
      ctx.strokeStyle = `hsla(${greenHsl}, 0.7)`
      ctx.lineWidth = 1.5
      for (let x = 0; x < w; x++) {
        const edgeFade = Math.min(x / 30, (w - x) / 30, 1)
        const noise = Math.sin(x * 0.08 + time * 3) * 0.25
        const y = h / 2 + Math.sin(x * 0.025 + time) * (h * 0.3) * edgeFade * (0.7 + noise)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // Secondary harmonic
      ctx.beginPath()
      ctx.strokeStyle = `hsla(${greenHsl}, 0.3)`
      ctx.lineWidth = 1
      for (let x = 0; x < w; x++) {
        const edgeFade = Math.min(x / 30, (w - x) / 30, 1)
        const y = h / 2 + Math.sin(x * 0.045 + time * 1.4 + 1.2) * (h * 0.2) * edgeFade
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // Glow
      ctx.beginPath()
      ctx.strokeStyle = `hsla(${greenHsl}, 0.08)`
      ctx.lineWidth = 6
      for (let x = 0; x < w; x++) {
        const edgeFade = Math.min(x / 30, (w - x) / 30, 1)
        const y = h / 2 + Math.sin(x * 0.025 + time) * (h * 0.3) * edgeFade
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()

      frameRef.current++
      animId = requestAnimationFrame(draw)
    }

    draw()
    if (active) animId = requestAnimationFrame(draw)

    return () => {
      if (animId) cancelAnimationFrame(animId)
    }
  }, [active])

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-7"
      style={{ imageRendering: "auto" }}
    />
  )
}

function SubActionRow({ action }) {
  return (
    <div className="flex items-center gap-2 py-1 animate-in fade-in slide-in-from-left-2 duration-300">
      <Database className="h-3 w-3 text-[hsl(262,52%,56%)] shrink-0" />
      <span className="text-[10px] text-muted-foreground flex-1 truncate">
        {action.label}
      </span>
      <span className="text-[9px] font-mono text-muted-foreground/40 shrink-0">
        {action.tool}
      </span>
      {action.status === "running" ? (
        <Loader2 className="h-2.5 w-2.5 animate-spin text-[hsl(262,52%,56%)] shrink-0" />
      ) : (
        <CheckCircle2 className="h-2.5 w-2.5 text-primary shrink-0" />
      )}
    </div>
  )
}

function SingleCallRow({ call }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (call.status === "connected") {
      setElapsed(0)
      const interval = setInterval(() => setElapsed((e) => e + 1), 1000)
      return () => clearInterval(interval)
    }
    if (call.status !== "ended") setElapsed(0)
  }, [call.status])

  const isRinging = call.status === "ringing"
  const isConnected = call.status === "connected"
  const isEnded = call.status === "ended"
  const hasSubActions = call.subActions && call.subActions.length > 0

  return (
    <div
      className={cn(
        "rounded-lg border p-3 transition-all duration-500",
        isConnected
          ? "bg-primary/[0.04] border-primary/20"
          : isEnded
          ? "bg-muted/20 border-border/20"
          : "bg-card border-border/50"
      )}
    >
      <div className="flex items-center gap-3 mb-2">
        <div className="relative">
          <div
            className={cn(
              "flex items-center justify-center w-7 h-7 rounded-full",
              isConnected
                ? "bg-primary/15 text-primary"
                : isEnded
                ? "bg-muted text-muted-foreground/40"
                : "bg-muted text-muted-foreground"
            )}
          >
            {isEnded ? (
              <PhoneOff className="h-3.5 w-3.5" />
            ) : (
              <Phone className={cn("h-3.5 w-3.5", isRinging && "animate-pulse")} />
            )}
          </div>
          {isConnected && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary animate-pulse" />
          )}
        </div>

        <div className="flex flex-col min-w-0 flex-1">
          <span className={cn(
            "text-xs font-medium truncate",
            isEnded ? "text-muted-foreground/50" : "text-foreground"
          )}>
            {call.supplier}
          </span>
          <div className="flex items-center gap-2">
            <span className={cn(
              "text-[10px]",
              isConnected ? "text-primary" : "text-muted-foreground/50"
            )}>
              {isRinging ? "Ringing..." : isConnected ? "Connected" : "Ended"}
            </span>
            {(isConnected || isEnded) && (
              <span className="text-[10px] font-mono text-muted-foreground/40">
                {formatDuration(isEnded ? call.duration : elapsed)}
              </span>
            )}
          </div>
        </div>

        {isConnected && (
          <div className="flex items-center gap-1 text-primary">
            <Mic className="h-3 w-3" />
            <span className="text-[9px] font-mono uppercase tracking-wider">Live</span>
          </div>
        )}
      </div>

      <AudioLine active={isConnected} />

      {hasSubActions && (
        <div className={cn(
          "mt-2 border-t pt-2 flex flex-col gap-0.5",
          isConnected ? "border-primary/10" : "border-border/20"
        )}>
          <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground/40 mb-0.5">
            Mid-call retrievals
          </span>
          {call.subActions.map((action) => (
            <SubActionRow key={action.id} action={action} />
          ))}
        </div>
      )}

      {isConnected && !hasSubActions && (
        <div className="mt-2 flex items-center gap-2 text-[9px] text-muted-foreground/40 font-mono">
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          ElevenLabs STT &middot; Voice Agent
        </div>
      )}
    </div>
  )
}

export function PhoneCallPanel({ calls }) {
  const [manualExpand, setManualExpand] = useState(null) // null = auto, true/false = manual
  const prevActiveCountRef = useRef(0)

  const activeCalls = useMemo(() => calls.filter((c) => c.status !== "ended"), [calls])
  const endedCalls = useMemo(() => calls.filter((c) => c.status === "ended"), [calls])
  const allEnded = activeCalls.length === 0 && endedCalls.length > 0

  // Auto-expand when new active calls appear (e.g. round 2 starts)
  useEffect(() => {
    if (activeCalls.length > 0 && prevActiveCountRef.current === 0) {
      setManualExpand(null) // revert to auto behavior → expands
    }
    prevActiveCountRef.current = activeCalls.length
  }, [activeCalls.length])

  if (calls.length === 0) return null

  // Auto-collapse when all calls end, auto-expand when calls are active
  const isExpanded = manualExpand !== null ? manualExpand : !allEnded

  // Collapsed: compact single-line summary
  if (!isExpanded) {
    return (
      <button
        onClick={() => setManualExpand(true)}
        className="w-full rounded-lg border border-border/50 bg-card px-4 py-2.5 flex items-center justify-between hover:bg-muted/30 transition-colors group"
      >
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-muted text-muted-foreground/40">
            <PhoneOff className="h-3 w-3" />
          </div>
          <span className="text-xs text-muted-foreground">
            {calls.length} call{calls.length !== 1 ? "s" : ""} completed
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground/40 group-hover:text-muted-foreground transition-colors">
          Show
        </span>
      </button>
    )
  }

  return (
    <div className="rounded-lg border border-border/50 bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Voice Calls
        </h2>
        <div className="flex items-center gap-3">
          {activeCalls.length > 0 && (
            <span className="flex items-center gap-1.5 text-[10px] font-mono text-primary">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              {activeCalls.length} active
            </span>
          )}
          {endedCalls.length > 0 && (
            <span className="text-[10px] font-mono text-muted-foreground/40">
              {endedCalls.length} completed
            </span>
          )}
          <button
            onClick={() => setManualExpand(false)}
            className="text-[10px] text-muted-foreground/40 hover:text-muted-foreground transition-colors ml-1"
          >
            Minimize
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {activeCalls.map((call) => (
          <SingleCallRow key={call.id} call={call} />
        ))}
        {endedCalls.map((call) => (
          <SingleCallRow key={call.id} call={call} />
        ))}
      </div>
    </div>
  )
}
