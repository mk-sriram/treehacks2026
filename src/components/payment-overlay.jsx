"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

/**
 * Venmo-style full-screen payment confirmation overlay.
 * Shows an animated checkmark, amount, wallet, tx hash, then auto-dismisses.
 *
 * Props:
 *   payment: { amount, token, chain, wallet_address, tx_hash, invoice_id, vendor_name } | null
 *   onDismiss: () => void
 */
export function PaymentOverlay({ payment, onDismiss }) {
  const [phase, setPhase] = useState("enter") // enter → show → exit

  // Lock background scroll while overlay is visible
  useEffect(() => {
    if (!payment) return
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = ""
    }
  }, [payment])

  useEffect(() => {
    if (!payment) return

    // enter → show after 100ms (let mount happen)
    const t1 = setTimeout(() => setPhase("show"), 100)
    // auto-dismiss after 5s
    const t2 = setTimeout(() => {
      setPhase("exit")
      setTimeout(onDismiss, 600)
    }, 5000)

    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [payment, onDismiss])

  if (!payment) return null

  const walletShort = payment.wallet_address
    ? `${payment.wallet_address.slice(0, 6)}...${payment.wallet_address.slice(-4)}`
    : "..."
  const txShort = payment.tx_hash
    ? `${payment.tx_hash.slice(0, 10)}...${payment.tx_hash.slice(-4)}`
    : "..."

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center transition-all duration-500 overflow-hidden overscroll-contain",
        phase === "enter" && "opacity-0",
        phase === "show" && "opacity-100",
        phase === "exit" && "opacity-0 scale-95"
      )}
      onClick={() => {
        setPhase("exit")
        setTimeout(onDismiss, 600)
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Card */}
      <div
        className={cn(
          "relative z-10 flex flex-col items-center gap-6 rounded-2xl border border-border/30 bg-card p-10 shadow-2xl shadow-primary/10 transition-all duration-700",
          "w-[380px] max-w-[90vw]",
          phase === "enter" && "translate-y-8 scale-95",
          phase === "show" && "translate-y-0 scale-100",
          phase === "exit" && "translate-y-4 scale-95"
        )}
      >
        {/* Animated checkmark circle */}
        <div className="relative flex items-center justify-center">
          {/* Outer pulse rings */}
          <span className="absolute w-24 h-24 rounded-full bg-primary/20 payment-ring-1" />
          <span className="absolute w-24 h-24 rounded-full bg-primary/10 payment-ring-2" />

          {/* Primary circle */}
          <div
            className={cn(
              "relative flex items-center justify-center w-20 h-20 rounded-full bg-primary transition-all duration-700",
              phase === "enter" && "scale-0",
              phase === "show" && "scale-100",
              phase === "exit" && "scale-90"
            )}
          >
            {/* SVG checkmark with draw-in animation */}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="w-10 h-10 text-primary-foreground"
            >
              <path
                d="M5 13l4 4L19 7"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={cn(
                  "payment-checkmark",
                  phase === "show" && "payment-checkmark-draw"
                )}
              />
            </svg>
          </div>
        </div>

        {/* Title */}
        <div className="text-center">
          <h2 className="text-xl font-semibold text-foreground">
            Payment Sent
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {payment.vendor_name}
          </p>
        </div>

        {/* Amount */}
        <div className="text-center">
          <span className="text-4xl font-bold text-primary tabular-nums">
            ${payment.amount?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <div className="flex items-center justify-center gap-2 mt-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 border border-primary/20 px-3 py-1 text-xs font-medium text-primary">
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              {payment.token} on {payment.chain}
            </span>
          </div>
        </div>

        {/* Details */}
        <div className="w-full rounded-lg bg-muted/50 border border-border/30 divide-y divide-border/30">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-xs text-muted-foreground">To wallet</span>
            <span className="text-xs font-mono text-foreground/80">
              {walletShort}
            </span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-xs text-muted-foreground">TX hash</span>
            <span className="text-xs font-mono text-foreground/80">
              {txShort}
            </span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-xs text-muted-foreground">Invoice</span>
            <span className="text-xs font-mono text-foreground/80">
              {payment.invoice_id}
            </span>
          </div>
        </div>

        {/* Tap to dismiss hint */}
        <p className="text-[10px] text-muted-foreground/40">
          Tap anywhere to dismiss
        </p>
      </div>
    </div>
  )
}
