const DEMO_SUPPLIERS = [
  "Shenzhen HuaTech Components",
  "Dongguan PrecisionParts Co.",
  "Zhejiang MegaSupply Ltd.",
  "Guangzhou FastTrack Industrial",
  "Jiangsu QualityFirst Mfg.",
]

let activityCounter = 0

function createActivity(type, title, description, tool, parallelGroup) {
  activityCounter++
  return {
    id: `${Date.now()}-${activityCounter}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    title,
    description,
    timestamp: new Date(),
    status: "running",
    tool,
    parallelGroup,
  }
}

function createSubAction(label, tool) {
  return {
    id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    label,
    tool,
    status: "running",
    timestamp: new Date(),
  }
}

export function simulateWorkflow(rfq, callbacks) {
  const timeline = []
  let offset = 0

  const addStep = (delayMs, action) => {
    offset += delayMs
    timeline.push({ delay: offset, action })
  }

  const svc = (patch) => {
    callbacks.onServicesChange({
      perplexity: false,
      stagehand: false,
      elevenlabs: false,
      elasticsearch: false,
      gemini: false,
      visa: false,
      ...patch,
    })
  }

  // ===== STAGE 1: Finding Suppliers =====
  addStep(300, () => {
    callbacks.onStageChange("finding_suppliers")
    svc({ perplexity: true, elasticsearch: true, gemini: true })
  })

  const pGroup1 = "search-parallel-1"
  const searchA = createActivity("search", "Perplexity Sonar: Product Search", `Searching "${rfq.item}" specifications, pricing, and availability`, "perplexity-sonar", pGroup1)
  const searchB = createActivity("search", "Perplexity Sonar: Supplier DB", `Querying supplier databases for "${rfq.item}" manufacturers`, "perplexity-sonar", pGroup1)
  const searchC = createActivity("memory", "Elasticsearch: Past Deals", "Retrieving past negotiations and pricing history for similar items", "elasticsearch", pGroup1)

  addStep(400, () => {
    callbacks.onActivity(searchA)
    callbacks.onActivity(searchB)
    callbacks.onActivity(searchC)
  })

  addStep(1800, () => {
    callbacks.onUpdateActivity(searchC.id, {
      status: "done",
      description: "Found 3 past negotiations. Best tactic: volume commitment + payment acceleration (12% avg discount).",
    })
  })

  addStep(800, () => {
    callbacks.onUpdateActivity(searchA.id, {
      status: "done",
      description: `Found 23 potential suppliers for "${rfq.item}". Citations from ThomasNet, Alibaba, GlobalSources.`,
    })
  })

  addStep(600, () => {
    callbacks.onUpdateActivity(searchB.id, {
      status: "done",
      description: `5 shortlisted suppliers with reliability scores >85%. MOQ range: 1k-50k. Price range: $1.40-$3.20/unit.`,
    })
  })

  const analyzeActivity = createActivity("analyze", "Market Intelligence Analysis", "Analyzing pricing trends, MOQ ranges, and reliability scores across sources", "gemini")
  addStep(400, () => callbacks.onActivity(analyzeActivity))
  addStep(2000, () => {
    callbacks.onUpdateActivity(analyzeActivity.id, {
      status: "done",
      description: `Typical range $${(Math.random() * 2 + 1).toFixed(2)}-$${(Math.random() * 3 + 3).toFixed(2)}/unit. Top 5 suppliers ranked by composite score.`,
    })
  })

  // ===== STAGE 2: Calling for Quote (Multiple parallel calls) =====
  addStep(600, () => {
    callbacks.onStageChange("calling_for_quote")
    svc({ elevenlabs: true, gemini: true })
  })

  const call1Id = "call-1"
  const call2Id = "call-2"

  const callActivity1 = createActivity("call", `Voice Call: ${DEMO_SUPPLIERS[0]}`, `Dialing ${DEMO_SUPPLIERS[0]} via ElevenLabs + Decagon`, "elevenlabs-voice")
  const callActivity2 = createActivity("call", `Voice Call: ${DEMO_SUPPLIERS[3]}`, `Dialing ${DEMO_SUPPLIERS[3]} via ElevenLabs + Decagon`, "elevenlabs-voice")

  addStep(400, () => {
    callbacks.onActivity(callActivity1)
    callbacks.onActivity(callActivity2)
    callbacks.onCallsChange([
      { id: call1Id, active: true, supplier: DEMO_SUPPLIERS[0], duration: 0, status: "ringing" },
      { id: call2Id, active: true, supplier: DEMO_SUPPLIERS[3], duration: 0, status: "ringing" },
    ])
  })

  addStep(2000, () => {
    callbacks.onCallsChange([
      { id: call1Id, active: true, supplier: DEMO_SUPPLIERS[0], duration: 0, status: "connected" },
      { id: call2Id, active: true, supplier: DEMO_SUPPLIERS[3], duration: 0, status: "ringing" },
    ])
  })

  addStep(1200, () => {
    callbacks.onCallsChange([
      { id: call1Id, active: true, supplier: DEMO_SUPPLIERS[0], duration: 0, status: "connected" },
      { id: call2Id, active: true, supplier: DEMO_SUPPLIERS[3], duration: 0, status: "connected" },
    ])
  })

  addStep(4000, () => {
    callbacks.onUpdateActivity(callActivity1.id, {
      status: "done",
      description: `Call completed with ${DEMO_SUPPLIERS[0]}. Transcript captured. Quote extracted.`,
    })
    callbacks.onCallsChange([
      { id: call1Id, active: false, supplier: DEMO_SUPPLIERS[0], duration: 38, status: "ended" },
      { id: call2Id, active: true, supplier: DEMO_SUPPLIERS[3], duration: 0, status: "connected" },
    ])
    callbacks.onQuote({
      supplier: DEMO_SUPPLIERS[0],
      unitPrice: "$2.45",
      moq: "5,000 units",
      leadTime: "14 days",
      shipping: "$340 (sea freight)",
      terms: "Net 30",
      confidence: 92,
      source: "voice-call",
    })
  })

  // Call 3 starts while call 2 still going
  const call3Id = "call-3"
  const callActivity3 = createActivity("call", `Voice Call: ${DEMO_SUPPLIERS[4]}`, `Dialing ${DEMO_SUPPLIERS[4]} via ElevenLabs + Decagon`, "elevenlabs-voice")

  addStep(800, () => {
    callbacks.onActivity(callActivity3)
    callbacks.onCallsChange([
      { id: call1Id, active: false, supplier: DEMO_SUPPLIERS[0], duration: 38, status: "ended" },
      { id: call2Id, active: true, supplier: DEMO_SUPPLIERS[3], duration: 0, status: "connected" },
      { id: call3Id, active: true, supplier: DEMO_SUPPLIERS[4], duration: 0, status: "ringing" },
    ])
  })

  addStep(1500, () => {
    callbacks.onCallsChange([
      { id: call1Id, active: false, supplier: DEMO_SUPPLIERS[0], duration: 38, status: "ended" },
      { id: call2Id, active: true, supplier: DEMO_SUPPLIERS[3], duration: 0, status: "connected" },
      { id: call3Id, active: true, supplier: DEMO_SUPPLIERS[4], duration: 0, status: "connected" },
    ])
  })

  addStep(2000, () => {
    callbacks.onUpdateActivity(callActivity2.id, {
      status: "done",
      description: `Call completed with ${DEMO_SUPPLIERS[3]}. Quote: $2.10/unit, MOQ 8k.`,
    })
    callbacks.onCallsChange([
      { id: call1Id, active: false, supplier: DEMO_SUPPLIERS[0], duration: 38, status: "ended" },
      { id: call2Id, active: false, supplier: DEMO_SUPPLIERS[3], duration: 52, status: "ended" },
      { id: call3Id, active: true, supplier: DEMO_SUPPLIERS[4], duration: 0, status: "connected" },
    ])
    callbacks.onQuote({
      supplier: DEMO_SUPPLIERS[3],
      unitPrice: "$2.10",
      moq: "8,000 units",
      leadTime: "18 days",
      shipping: "$290 (sea freight)",
      terms: "Net 30",
      confidence: 85,
      source: "voice-call",
    })
  })

  addStep(3000, () => {
    callbacks.onUpdateActivity(callActivity3.id, {
      status: "done",
      description: `Call completed with ${DEMO_SUPPLIERS[4]}. Competitive pricing. Willing to negotiate.`,
    })
    callbacks.onCallsChange([
      { id: call1Id, active: false, supplier: DEMO_SUPPLIERS[0], duration: 38, status: "ended" },
      { id: call2Id, active: false, supplier: DEMO_SUPPLIERS[3], duration: 52, status: "ended" },
      { id: call3Id, active: false, supplier: DEMO_SUPPLIERS[4], duration: 44, status: "ended" },
    ])
    callbacks.onQuote({
      supplier: DEMO_SUPPLIERS[4],
      unitPrice: "$1.95",
      moq: "15,000 units",
      leadTime: "25 days",
      shipping: "$410 (sea freight)",
      terms: "50% upfront",
      confidence: 80,
      source: "voice-call",
    })
  })

  // ===== STAGE 3: Web Quoting (Parallel browsing) =====
  addStep(600, () => {
    callbacks.onStageChange("requesting_web_quote")
    svc({ stagehand: true, gemini: true })
    callbacks.onCallsChange([])
  })

  const webGroup = "web-parallel-1"
  const browse1 = createActivity("browse", `Stagehand: ${DEMO_SUPPLIERS[1]}`, `Navigating to ${DEMO_SUPPLIERS[1]} RFQ portal`, "browserbase-stagehand", webGroup)
  const browse2 = createActivity("browse", `Stagehand: ${DEMO_SUPPLIERS[2]}`, `Navigating to ${DEMO_SUPPLIERS[2]} catalog page`, "browserbase-stagehand", webGroup)

  addStep(400, () => {
    callbacks.onActivity(browse1)
    callbacks.onActivity(browse2)
  })

  addStep(2200, () => {
    callbacks.onUpdateActivity(browse1.id, {
      status: "done",
      description: `Observed 3 form fields, filled RFQ for ${rfq.quantity} units. Form submitted.`,
    })
    callbacks.onQuote({
      supplier: DEMO_SUPPLIERS[1],
      unitPrice: "$2.18",
      moq: "10,000 units",
      leadTime: "21 days",
      shipping: "$280 (sea freight)",
      terms: "Net 45",
      confidence: 88,
      source: "web-form",
    })
  })

  addStep(1000, () => {
    callbacks.onUpdateActivity(browse2.id, {
      status: "done",
      description: `Scraped pricing table from ${DEMO_SUPPLIERS[2]}. Action cached for future.`,
    })
    callbacks.onQuote({
      supplier: DEMO_SUPPLIERS[2],
      unitPrice: "$1.92",
      moq: "20,000 units",
      leadTime: "28 days",
      shipping: "$520 (air available)",
      terms: "50% upfront",
      confidence: 78,
      source: "web-scrape",
    })
  })

  // ===== STAGE 4: Negotiating (calls + mid-call data retrieval) =====
  addStep(600, () => {
    callbacks.onStageChange("negotiating")
    svc({ gemini: true, elasticsearch: true, elevenlabs: true })
  })

  const negGroup = "negotiate-parallel"
  const neg1 = createActivity("negotiate", "Preparing Negotiation Strategy", "Building anchoring strategy from market data and past outcomes", "gemini", negGroup)
  const neg2 = createActivity("memory", "Elasticsearch: Tactic Lookup", "Retrieving winning negotiation tactics for similar SKUs", "elasticsearch", negGroup)

  addStep(400, () => {
    callbacks.onActivity(neg1)
    callbacks.onActivity(neg2)
  })

  addStep(1400, () => {
    callbacks.onUpdateActivity(neg2.id, {
      status: "done",
      description: "Retrieved 5 past tactics. Best: volume commitment + payment acceleration (avg 12% discount).",
    })
  })

  addStep(600, () => {
    callbacks.onUpdateActivity(neg1.id, {
      status: "done",
      description: "Strategy locked: anchor at $1.65, cite competitor $1.95, offer volume commitment + 50% upfront.",
    })
  })

  // Negotiation call 1
  const negCall1Id = "neg-call-1"
  const negCallActivity1 = createActivity("call", `Negotiation Call: ${DEMO_SUPPLIERS[2]}`, `Calling ${DEMO_SUPPLIERS[2]} with anchoring strategy`, "elevenlabs-voice")

  addStep(400, () => {
    callbacks.onActivity(negCallActivity1)
    callbacks.onCallsChange([
      { id: negCall1Id, active: true, supplier: DEMO_SUPPLIERS[2], duration: 0, status: "ringing" },
    ])
  })

  addStep(1800, () => {
    callbacks.onCallsChange([
      { id: negCall1Id, active: true, supplier: DEMO_SUPPLIERS[2], duration: 0, status: "connected" },
    ])
  })

  const sub1 = createSubAction("Retrieving competitor pricing for leverage", "elasticsearch")
  addStep(2000, () => {
    svc({ gemini: true, elasticsearch: true, elevenlabs: true })
    callbacks.onCallsChange([
      {
        id: negCall1Id, active: true, supplier: DEMO_SUPPLIERS[2], duration: 0, status: "connected",
        subActions: [sub1],
      },
    ])
  })

  const sub1Done = { ...sub1, status: "done" }
  const sub2 = createSubAction("Looking up volume discount precedents", "elasticsearch")
  addStep(1500, () => {
    callbacks.onCallsChange([
      {
        id: negCall1Id, active: true, supplier: DEMO_SUPPLIERS[2], duration: 0, status: "connected",
        subActions: [sub1Done, sub2],
      },
    ])
  })

  const sub2Done = { ...sub2, status: "done" }
  const sub3 = createSubAction("Checking payment term flexibility from past deals", "elasticsearch")
  addStep(1200, () => {
    callbacks.onCallsChange([
      {
        id: negCall1Id, active: true, supplier: DEMO_SUPPLIERS[2], duration: 0, status: "connected",
        subActions: [sub1Done, sub2Done, sub3],
      },
    ])
  })

  const sub3Done = { ...sub3, status: "done" }

  // Negotiation call 2
  const negCall2Id = "neg-call-2"
  const negCallActivity2 = createActivity("call", `Negotiation Call: ${DEMO_SUPPLIERS[4]}`, `Calling ${DEMO_SUPPLIERS[4]} with competing offer`, "elevenlabs-voice")

  addStep(1000, () => {
    callbacks.onActivity(negCallActivity2)
    callbacks.onCallsChange([
      {
        id: negCall1Id, active: true, supplier: DEMO_SUPPLIERS[2], duration: 0, status: "connected",
        subActions: [sub1Done, sub2Done, sub3Done],
      },
      { id: negCall2Id, active: true, supplier: DEMO_SUPPLIERS[4], duration: 0, status: "ringing" },
    ])
  })

  addStep(1500, () => {
    callbacks.onCallsChange([
      {
        id: negCall1Id, active: true, supplier: DEMO_SUPPLIERS[2], duration: 0, status: "connected",
        subActions: [sub1Done, sub2Done, sub3Done],
      },
      { id: negCall2Id, active: true, supplier: DEMO_SUPPLIERS[4], duration: 0, status: "connected" },
    ])
  })

  const sub4 = createSubAction("Pulling shipping cost benchmarks", "elasticsearch")
  addStep(1200, () => {
    callbacks.onCallsChange([
      {
        id: negCall1Id, active: true, supplier: DEMO_SUPPLIERS[2], duration: 0, status: "connected",
        subActions: [sub1Done, sub2Done, sub3Done],
      },
      {
        id: negCall2Id, active: true, supplier: DEMO_SUPPLIERS[4], duration: 0, status: "connected",
        subActions: [sub4],
      },
    ])
  })

  const sub4Done = { ...sub4, status: "done" }

  // Call 1 ends
  addStep(2000, () => {
    callbacks.onUpdateActivity(negCallActivity1.id, {
      status: "done",
      description: `Negotiation with ${DEMO_SUPPLIERS[2]} complete. Secured $1.72/unit (10.4% reduction). Volume + 50% upfront + competitor anchor.`,
    })
    callbacks.onCallsChange([
      {
        id: negCall1Id, active: false, supplier: DEMO_SUPPLIERS[2], duration: 67, status: "ended",
        subActions: [sub1Done, sub2Done, sub3Done],
      },
      {
        id: negCall2Id, active: true, supplier: DEMO_SUPPLIERS[4], duration: 0, status: "connected",
        subActions: [sub4Done],
      },
    ])
  })

  const sub5 = createSubAction("Fetching quality cert requirements", "elasticsearch")
  addStep(1000, () => {
    callbacks.onCallsChange([
      {
        id: negCall1Id, active: false, supplier: DEMO_SUPPLIERS[2], duration: 67, status: "ended",
        subActions: [sub1Done, sub2Done, sub3Done],
      },
      {
        id: negCall2Id, active: true, supplier: DEMO_SUPPLIERS[4], duration: 0, status: "connected",
        subActions: [sub4Done, sub5],
      },
    ])
  })

  const sub5Done = { ...sub5, status: "done" }

  // Call 2 ends
  addStep(2500, () => {
    callbacks.onUpdateActivity(negCallActivity2.id, {
      status: "done",
      description: `Negotiation with ${DEMO_SUPPLIERS[4]} complete. Best offer: $1.80/unit with 20-day lead time. Quality certs included.`,
    })
    callbacks.onCallsChange([
      {
        id: negCall1Id, active: false, supplier: DEMO_SUPPLIERS[2], duration: 67, status: "ended",
        subActions: [sub1Done, sub2Done, sub3Done],
      },
      {
        id: negCall2Id, active: false, supplier: DEMO_SUPPLIERS[4], duration: 54, status: "ended",
        subActions: [sub4Done, sub5Done],
      },
    ])
  })

  // Store outcomes
  const negMemory = createActivity("negotiate", "Negotiation Outcomes Stored", "Writing final terms and tactic scores to memory", "gemini")
  addStep(400, () => callbacks.onActivity(negMemory))

  const memoryWrite = createActivity("memory", "Elasticsearch: Index Results", "Indexing negotiation outcomes, transcripts, and tactic effectiveness", "elasticsearch")
  addStep(300, () => callbacks.onActivity(memoryWrite))

  addStep(1200, () => {
    callbacks.onUpdateActivity(negMemory.id, {
      status: "done",
      description: `Best: ${DEMO_SUPPLIERS[2]} at $1.72/unit. Runner-up: ${DEMO_SUPPLIERS[4]} at $1.80/unit.`,
    })
    callbacks.onUpdateActivity(memoryWrite.id, {
      status: "done",
      description: "Indexed 2 negotiation outcomes, 2 call transcripts, and 5 retrieval artifacts.",
    })
  })

  // ===== STAGE 5: Payment =====
  addStep(600, () => {
    callbacks.onStageChange("paying_deposit")
    svc({ visa: true })
    callbacks.onCallsChange([])
  })

  const paymentActivity = createActivity(
    "payment",
    "Processing Deposit",
    `Initiating 50% deposit ($21,500) to ${DEMO_SUPPLIERS[2]} via Visa B2B + Coinbase USDC on Base`,
    "visa-b2b"
  )
  addStep(400, () => callbacks.onActivity(paymentActivity))

  addStep(2500, () => {
    callbacks.onUpdateActivity(paymentActivity.id, {
      status: "done",
      description: "Deposit confirmed. Visa TX: VIS-8429-TX. On-chain: 0x3f8a...c92d. Audit log written.",
    })
  })

  // ===== COMPLETE =====
  addStep(1000, () => {
    callbacks.onStageChange("complete")
    svc({})
    const systemDone = createActivity("system", "Workflow Complete", "All procurement steps finished. Summary generated.", "orchestrator")
    systemDone.status = "done"
    callbacks.onActivity(systemDone)
    callbacks.onSummary({
      suppliersFound: 23,
      quotesReceived: 5,
      bestPrice: "$1.72/unit",
      bestSupplier: DEMO_SUPPLIERS[2],
      avgLeadTime: "21 days",
      recommendation: `Proceed with ${DEMO_SUPPLIERS[2]} at $1.72/unit (25,000 units). 29.8% savings vs highest quote, 10.4% below initial offer after negotiation. 3 mid-call retrievals informed final terms.`,
      savings: "29.8%",
      nextSteps: [
        "Confirm production schedule with supplier",
        "Arrange quality inspection (pre-shipment)",
        "Set up remaining 50% payment milestone",
        "Schedule logistics for sea freight delivery",
      ],
    })
  })

  const timers = []
  for (const step of timeline) {
    timers.push(setTimeout(step.action, step.delay))
  }

  return () => {
    for (const timer of timers) clearTimeout(timer)
  }
}
