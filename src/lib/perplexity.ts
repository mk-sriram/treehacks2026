// Perplexity Sonar client for vendor discovery
// Uses sonar-pro to find suppliers with verified contact info (phone/email/form)
// Contact info is critical -- it feeds directly into ElevenLabs voice calls

function buildSystemPrompt(spec: {
  item: string;
  quantity: string;
  leadTime?: string;
  quality?: string;
  location?: string;
  budget?: string;
}) {
  return `You are a procurement research assistant. Your task is to identify and compare vendors for a specific item and constraints I will provide. Use up-to-date, high-quality sources, and only include vendors that clearly offer the requested item.

Here are the requirements:
Item: ${spec.item}
Quantity: ${spec.quantity || 'Not specified'}
Maximum total budget (including all fees and taxes if possible): ${spec.budget || 'Not specified'}
Delivery location: ${spec.location || 'Not specified'}
Latest acceptable delivery date (item must arrive by): ${spec.leadTime || 'Not specified'}
Quality / specification constraints: ${spec.quality || 'None specified'}
Other hard constraints (must-haves): None
Soft preferences (nice-to-haves): None

Your job:
Find legitimate vendors that can supply this item under these constraints (or as close as possible).
Exclude obvious marketplaces or irrelevant results (e.g., blog posts, content farms) unless they point to real vendors.
For each vendor, verify from their site or a reliable source that:
- They actually sell the specified item or a very close equivalent.
- They can ship to the delivery location or plausibly serve that region.

The Vendor Name, Website, and Preferred Contact Method are MOST IMPORTANT and must be accurate.
If phone is their preferred method of contact, indicate that and ENSURE the phone number is found and filled in.
Vice versa for email. If there is a form or some other contact method on the webpage itself, place the URL from which you can contact the vendor.

CRITICAL: We will be calling these vendors by phone. Finding accurate phone numbers is the highest priority. Check their website "Contact Us" page, footer, Google Business listing, or directory listings. A vendor without a phone number is much less useful to us.

Return ONLY a JSON array (no markdown, no prose, no explanation) with 3-5 vendors (focus on the BEST matches only). Each element must have these exact fields:
{
  "name": "Vendor Name",
  "url": "https://vendor-website.com",
  "phone": "+1234567890 or null if truly not found",
  "email": "sales@vendor.com or null",
  "region": "Where they are located / serves",
  "match": "How they match the item and quality constraints",
  "pricing": "Indicative pricing for the requested quantity (best available info)",
  "leadTime": "Shipping / lead time information, especially whether they can meet deadline",
  "notes": "Certifications, notable customers, risks, or limitations",
  "contactMethod": "Phone or Email or Web Form",
  "formUrl": "URL to contact/quote request form if applicable, or null"
}

Return ONLY the JSON array, nothing else.`;
}

const DISCOVERY_ANGLES = [
  'Find top manufacturers and wholesale suppliers with verified phone numbers for',
  'Find specialty distributors and certified vendors with direct contact info for',
  'Find competitive budget-friendly suppliers with sales phone lines for',
];

export interface VendorCandidate {
  name: string;
  url?: string | null;
  phone?: string | null;
  email?: string | null;
  region?: string | null;
  match?: string | null;
  pricing?: string | null;
  leadTime?: string | null;
  notes?: string | null;
  contactMethod?: string | null;
  formUrl?: string | null;
  sourceUrl?: string | null;
}

export interface DiscoveryResult {
  vendors: VendorCandidate[];
  citations: string[];
  rawContent: string;
}

export async function discoverVendors(
  spec: { item: string; quantity: string; leadTime?: string; quality?: string; location?: string; budget?: string },
  angle: string = ''
): Promise<DiscoveryResult> {
  // The system prompt has the full spec baked in; the user message is just the search angle
  const systemPrompt = buildSystemPrompt(spec);
  const userMessage = `${angle} ${spec.item}. Find vendors with verified phone numbers and direct contact information.`;

  console.log(`[PERPLEXITY] discoverVendors() called — angle="${angle.slice(0, 50)}..."`);
  console.log(`[PERPLEXITY] User message: "${userMessage.slice(0, 120)}..."`);
  console.log(`[PERPLEXITY] API key present:`, !!process.env.PERPLEXITY_API_KEY);

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });

  console.log(`[PERPLEXITY] Response status: ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const errText = await res.text();
    console.error('[PERPLEXITY] API error:', res.status, errText.slice(0, 300));
    return { vendors: [], citations: [], rawContent: errText };
  }

  const data = await res.json();
  const rawContent = data.choices?.[0]?.message?.content ?? '';
  const citations: string[] = data.citations ?? [];

  console.log(`[PERPLEXITY] Response received — content length=${rawContent.length}, citations=${citations.length}`);
  console.log(`[PERPLEXITY] Raw content preview: "${rawContent.slice(0, 200)}..."`);

  // Best-effort parse -- content might be JSON or text with JSON in it
  let vendors: VendorCandidate[] = [];
  try {
    // Strip markdown fences if present
    const cleaned = rawContent
      .replace(/```json?\n?/g, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    vendors = Array.isArray(parsed) ? parsed : [];
    console.log(`[PERPLEXITY] Parsed ${vendors.length} vendors from JSON`);
  } catch {
    // Try to extract JSON array from the content
    try {
      const match = rawContent.match(/\[[\s\S]*\]/);
      if (match) {
        vendors = JSON.parse(match[0]);
        console.log(`[PERPLEXITY] Parsed ${vendors.length} vendors from extracted JSON array`);
      }
    } catch {
      console.error('[PERPLEXITY] Failed to parse response as JSON:', rawContent.slice(0, 200));
      vendors = [];
    }
  }

  if (vendors.length > 0) {
    console.log(`[PERPLEXITY] Vendor names:`, vendors.map(v => v.name).join(', '));
  }

  return { vendors, citations, rawContent };
}

export async function runDiscoveryLoop(
  spec: { item: string; quantity: string; leadTime?: string; quality?: string; location?: string; budget?: string },
  onProgress?: (angle: string, vendors: VendorCandidate[], citations: string[]) => void
): Promise<VendorCandidate[]> {
  console.log(`[PERPLEXITY] runDiscoveryLoop() started — item="${spec.item}", quantity="${spec.quantity}"`);
  console.log(`[PERPLEXITY] Will run ${DISCOVERY_ANGLES.length} search angles`);
  const allVendors: VendorCandidate[] = [];

  for (let i = 0; i < DISCOVERY_ANGLES.length; i++) {
    const angle = DISCOVERY_ANGLES[i];
    console.log(`[PERPLEXITY] --- Angle ${i + 1}/${DISCOVERY_ANGLES.length}: "${angle.slice(0, 60)}..." ---`);
    const { vendors, citations } = await discoverVendors(spec, angle);

    // Attach source URLs from citations
    const vendorsWithSources = vendors.map((v, j) => ({
      ...v,
      sourceUrl: citations[j] ?? null,
    }));

    console.log(`[PERPLEXITY] Angle ${i + 1} result: ${vendorsWithSources.length} vendors, ${citations.length} citations`);

    // Notify caller of progress (for SSE events)
    onProgress?.(angle, vendorsWithSources, citations);

    allVendors.push(...vendorsWithSources);
  }

  // Simple dedupe by name (case-insensitive)
  const seen = new Set<string>();
  const deduped = allVendors.filter((v) => {
    const key = v.name?.toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[PERPLEXITY] runDiscoveryLoop() complete — ${allVendors.length} total -> ${deduped.length} after dedup`);
  return deduped;
}
