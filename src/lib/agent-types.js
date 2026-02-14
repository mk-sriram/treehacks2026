export const STAGE_CONFIG = {
  idle: { label: "Ready", description: "Configure your RFQ to begin", index: 0 },
  finding_suppliers: { label: "Finding Suppliers", description: "Searching market intelligence sources", index: 1 },
  calling_for_quote: { label: "Calling for Quote", description: "Initiating voice calls to suppliers", index: 2 },
  requesting_web_quote: { label: "Web Quoting", description: "Submitting RFQ forms on supplier sites", index: 3 },
  negotiating: { label: "Negotiating", description: "Running negotiation tactics", index: 4 },
  paying_deposit: { label: "Payment", description: "Processing deposit via secure rails", index: 5 },
  complete: { label: "Complete", description: "Procurement workflow finished", index: 6 },
}
