"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { RequirementsChat } from "@/components/requirements-chat"
import { RFQForm } from "@/components/rfq-form"
import { ActivityFeed } from "@/components/activity-feed"
import { PhoneCallPanel } from "@/components/phone-call-panel"
import { QuotesPanel } from "@/components/quotes-panel"
import { SummaryPanel } from "@/components/summary-panel"
// import { simulateWorkflow } from "@/lib/agent-store"
import { cn } from "@/lib/utils"
import {
  Search,
  Phone,
  Globe,
  Handshake,
  CreditCard,
  Play,
  RotateCcw,
  Zap,
  ArrowLeft,
} from "lucide-react"

const ACTION_BUTTONS = [
  { label: "Find suppliers", icon: Search, stage: "finding_suppliers" },
  { label: "Call for quote", icon: Phone, stage: "calling_for_quote" },
  { label: "Request web quote", icon: Globe, stage: "requesting_web_quote" },
  { label: "Negotiate", icon: Handshake, stage: "negotiating" },
  { label: "Pay deposit", icon: CreditCard, stage: "paying_deposit" },
]

const STAGE_INDEX = {
  finding_suppliers: 1,
  calling_for_quote: 2,
  requesting_web_quote: 3,
  negotiating: 4,
  paying_deposit: 5,
}

const DEFAULT_SERVICES = {
  perplexity: false,
  stagehand: false,
  elevenlabs: false,
  elasticsearch: false,
  openai: false,
  visa: false,
}

export default function ProcurementAgent() {
  const [view, setView] = useState("chat")
  const [rfq, setRfq] = useState({
    item: "",
    quantity: "",
    leadTime: "",
    quality: "",
    location: "",
  })
  const [stage, setStage] = useState("idle")
  const [activities, setActivities] = useState([])
  const [quotes, setQuotes] = useState([])
  const [calls, setCalls] = useState([])
  const [summary, setSummary] = useState(null)
  const [activeServices, setActiveServices] = useState(DEFAULT_SERVICES)
  const [dashboardReady, setDashboardReady] = useState(false)
  const cleanupRef = useRef(null)

  const isRunning = stage !== "idle" && stage !== "complete" && stage !== "invoice_received"

  const handleChatComplete = useCallback((parsedRfq) => {
    setRfq(parsedRfq)
    setView("dashboard")
    setTimeout(() => {
      setDashboardReady(true)
    }, 600)
  }, [])

  const handleStart = useCallback(async () => {
    setActivities([])
    setQuotes([])
    setCalls([])
    setSummary(null)
    setActiveServices(DEFAULT_SERVICES)

    cleanupRef.current?.()

    try {
      // Create a real run via the backend
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rfq),
      })
      const { runId } = await response.json()

      // Connect to SSE stream
      const eventSource = new EventSource(`/api/run/${runId}/events`)

      eventSource.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data)
          switch (event.type) {
            case 'stage_change':
              setStage(event.payload.stage)
              break
            case 'activity':
              setActivities((prev) => [...prev, event.payload])
              break
            case 'update_activity':
              setActivities((prev) =>
                prev.map((a) =>
                  a.id === event.payload.id
                    ? { ...a, ...event.payload.updates }
                    : a
                )
              )
              break
            case 'quote':
              setQuotes((prev) => [...prev, event.payload])
              break
            case 'calls_change':
              setCalls(event.payload)
              break
            case 'summary':
              setSummary(event.payload)
              break
            case 'services_change':
              setActiveServices(event.payload)
              break
            case 'email_sent':
              // Confirmation email was sent to winning vendor
              console.log('Email sent to vendor:', event.payload.vendorName, event.payload.vendorEmail)
              break
            case 'invoice_received':
              // Vendor replied with an invoice
              console.log('Invoice received from:', event.payload.vendorName)
              break
          }
        } catch (err) {
          console.error('Error parsing SSE event:', err, e.data)
        }
      }

      eventSource.onerror = (err) => {
        console.error('SSE error:', err)
        // Don't close immediately -- SSE auto-reconnects
      }

      cleanupRef.current = () => {
        console.log('Cleaning up EventSource')
        eventSource.close()
      }
    } catch (err) {
      console.error('Failed to start run:', err)
      setStage("idle")
    }
  }, [rfq])

  const hasAutoStarted = useRef(false)
  
  // Use useEffect for side effects, not render body
  useEffect(() => {
    if (dashboardReady && !hasAutoStarted.current && stage === "idle") {
      hasAutoStarted.current = true
      handleStart()
    }
  }, [dashboardReady, stage, handleStart])

  const handleReset = useCallback(() => {
    cleanupRef.current?.()
    setStage("idle")
    setActivities([])
    setQuotes([])
    setCalls([])
    setSummary(null)
    setActiveServices(DEFAULT_SERVICES)
    setEverActive(DEFAULT_SERVICES)
    hasAutoStarted.current = false
    setDashboardReady(false)
  }, [])

  const handleBackToChat = useCallback(() => {
    handleReset()
    setView("chat")
    setRfq({ item: "", quantity: "", leadTime: "", quality: "", location: "" })
  }, [handleReset])

  const currentIndex =
    stage === "complete" ? 6 : stage === "idle" ? 0 : STAGE_INDEX[stage] ?? 0

  // Track which services have ever been active for the "connected" indicator
  const [everActive, setEverActive] = useState(DEFAULT_SERVICES)
  const prevServicesRef = useRef(activeServices)
  if (prevServicesRef.current !== activeServices) {
    prevServicesRef.current = activeServices
    const merged = { ...everActive }
    let changed = false
    for (const key of Object.keys(activeServices)) {
      if (activeServices[key] && !merged[key]) {
        merged[key] = true
        changed = true
      }
    }
    if (changed) {
      setEverActive(merged)
    }
  }

  if (view === "chat") {
    return <RequirementsChat onComplete={handleChatComplete} />
  }

  return (
    <div className={cn(
      "min-h-screen bg-background flex flex-col transition-all duration-500",
      !dashboardReady && "opacity-0 translate-y-4",
      dashboardReady && "opacity-100 translate-y-0"
    )}>
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-[1600px] mx-auto px-4 lg:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={handleBackToChat}
              className="flex items-center justify-center w-8 h-8 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Back to chat"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/20">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-foreground leading-tight">
                Procurement Agent
              </span>
              <span className="text-[10px] text-muted-foreground leading-tight font-mono truncate max-w-[300px]">
                {rfq.item}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Badge
              variant="outline"
              className={
                isRunning
                  ? "bg-primary/10 text-primary border-primary/30 text-[10px]"
                  : stage === "complete"
                  ? "bg-primary/10 text-primary border-primary/30 text-[10px]"
                  : "text-muted-foreground text-[10px]"
              }
            >
              {isRunning && (
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse mr-1.5" />
              )}
              {stage === "idle"
                ? "Ready"
                : stage === "complete"
                ? "Complete"
                : "Agent Running"}
            </Badge>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-[1600px] mx-auto w-full px-4 lg:px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr_320px] gap-6 h-[calc(100vh-110px)]">
          {/* Left Panel */}
          <div className="flex flex-col gap-4 overflow-y-auto">
            <div className="rounded-lg border border-border/50 bg-card p-4">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                Request for Quote
              </h2>
              <RFQForm rfq={rfq} onChange={setRfq} disabled={isRunning} />
            </div>

            <div className="rounded-lg border border-border/50 bg-card p-4">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                Agent Actions
              </h2>
              <div className="flex flex-col gap-2">
                {ACTION_BUTTONS.map((btn) => {
                  const Icon = btn.icon
                  const isActiveAction = btn.stage === stage
                  const btnIndex = STAGE_INDEX[btn.stage]
                  const isDone = currentIndex > btnIndex

                  return (
                    <Button
                      key={btn.stage}
                      variant="outline"
                      size="sm"
                      disabled
                      className={
                        isActiveAction
                          ? "justify-start gap-2 border-primary/30 bg-primary/10 text-primary opacity-100 h-9"
                          : isDone
                          ? "justify-start gap-2 border-primary/20 bg-primary/5 text-primary/70 opacity-100 h-9"
                          : "justify-start gap-2 text-muted-foreground h-9"
                      }
                    >
                      <Icon className="h-4 w-4" />
                      {btn.label}
                      {isActiveAction && (
                        <span className="ml-auto flex gap-1">
                          <span className="w-1 h-1 rounded-full bg-primary animate-pulse" />
                          <span className="w-1 h-1 rounded-full bg-primary animate-pulse [animation-delay:200ms]" />
                          <span className="w-1 h-1 rounded-full bg-primary animate-pulse [animation-delay:400ms]" />
                        </span>
                      )}
                      {isDone && !isActiveAction && (
                        <span className="ml-auto text-[10px] text-primary/60">
                          Done
                        </span>
                      )}
                    </Button>
                  )
                })}
              </div>

              <Separator className="my-3" />

              <div className="flex gap-2">
                {stage === "idle" ? (
                  <Button
                    onClick={handleStart}
                    className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 h-9"
                    disabled={!rfq.item}
                  >
                    <Play className="h-4 w-4 mr-2" />
                    Run Agent
                  </Button>
                ) : (
                  <Button
                    onClick={handleReset}
                    variant="outline"
                    className="flex-1 h-9"
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Reset
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Center Panel */}
          <div className="flex flex-col gap-4 min-h-0">
            {calls.length > 0 && <PhoneCallPanel calls={calls} />}
            {summary && <SummaryPanel summary={summary} />}

            <div className="flex-1 rounded-lg border border-border/50 bg-card p-4 min-h-0 flex flex-col">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Agent Activity
                </h2>
                {activities.length > 0 && (
                  <span className="text-[10px] font-mono text-muted-foreground/60">
                    {activities.length} actions
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-0">
                <ActivityFeed activities={activities} />
              </div>
            </div>
          </div>

          {/* Right Panel */}
          <div className="flex flex-col gap-4 overflow-y-auto">
            {quotes.length > 0 && (
              <div className="rounded-lg border border-border/50 bg-card p-4">
                <QuotesPanel quotes={quotes} />
              </div>
            )}

            {quotes.length === 0 && stage !== "idle" && (
              <div className="rounded-lg border border-border/50 bg-card p-4 flex items-center justify-center min-h-[200px]">
                <div className="text-center text-muted-foreground/50">
                  <p className="text-sm">Awaiting quotes...</p>
                  <p className="text-xs mt-1">
                    Quotes will appear here as they arrive
                  </p>
                </div>
              </div>
            )}

            {/* Connected Services */}
            <div className="rounded-lg border border-border/50 bg-card p-4">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                Connected Services
              </h2>
              <div className="flex flex-col gap-0.5">
                <ServiceItem
                  label="Perplexity Sonar"
                  description="Market intelligence & citations"
                  active={activeServices.perplexity}
                  wasActive={everActive.perplexity}
                />
                <ServiceItem
                  label="Browserbase Stagehand"
                  description="Web actions, form fill, extract"
                  active={activeServices.stagehand}
                  wasActive={everActive.stagehand}
                />
                <ServiceItem
                  label="ElevenLabs + Decagon"
                  description="Real-time voice agent"
                  active={activeServices.elevenlabs}
                  wasActive={everActive.elevenlabs}
                />
                <ServiceItem
                  label="Elasticsearch"
                  description="Hybrid memory retrieval (RRF)"
                  active={activeServices.elasticsearch}
                  wasActive={everActive.elasticsearch}
                />
                <ServiceItem
                  label="OpenAI GPT-4o-mini"
                  description="Extraction & negotiation strategy"
                  active={activeServices.openai}
                  wasActive={everActive.openai}
                />
                <ServiceItem
                  label="Visa B2B + Coinbase"
                  description="Payment rails & agent wallet"
                  active={activeServices.visa}
                  wasActive={everActive.visa}
                />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

function ServiceItem({ label, description, active, wasActive }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 py-2 px-2 rounded-md transition-all duration-500",
        active && "bg-primary/[0.07]",
      )}
    >
      <div className="relative shrink-0">
        <span
          className={cn(
            "block w-2 h-2 rounded-full transition-all duration-500",
            active
              ? "bg-primary"
              : wasActive
              ? "bg-primary/40"
              : "bg-muted-foreground/20"
          )}
        />
        {active && (
          <span className="absolute inset-0 w-2 h-2 rounded-full bg-primary animate-ping opacity-50" />
        )}
      </div>

      <div className="flex flex-col min-w-0 flex-1">
        <span
          className={cn(
            "text-xs font-medium transition-colors duration-500",
            active
              ? "text-primary"
              : wasActive
              ? "text-foreground/70"
              : "text-foreground/40"
          )}
        >
          {label}
        </span>
        <span className="text-[10px] text-muted-foreground/50 truncate">
          {description}
        </span>
      </div>

      {wasActive && !active && (
        <span className="text-[9px] font-mono text-primary/40 shrink-0">
          used
        </span>
      )}
      {active && (
        <span className="flex gap-0.5 shrink-0">
          <span className="w-1 h-1 rounded-full bg-primary animate-pulse" />
          <span className="w-1 h-1 rounded-full bg-primary animate-pulse [animation-delay:150ms]" />
          <span className="w-1 h-1 rounded-full bg-primary animate-pulse [animation-delay:300ms]" />
        </span>
      )}
    </div>
  )
}
