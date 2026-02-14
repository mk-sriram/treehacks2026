// Perplexity Sonar client for vendor discovery
// Uses sonar-pro with structured JSON output

const DISCOVERY_SYSTEM_PROMPT = `You are a procurement research assistant. Your task is to identify and compare vendors for a specific item and constraints the user will provide. Use up-to-date, high-quality sources, and only include vendors that clearly offer the requested item.

Your job:
- Find legitimate vendors that can supply this item under the given constraints (or as close as possible).
- Exclude obvious marketplaces or irrelevant results (e.g., blog posts, content farms) unless they point to real vendors.
- For each vendor, verify from their site or a reliable source that they actually sell the specified item or a very close equivalent.

Return ONLY a JSON array (no markdown, no explanation) where each element has these fields:
{
  "name": "Vendor Name",
  "url": "https://vendor-website.com",
  "phone": "+1234567890 or null",
  "email": "sales@vendor.com or null",
  "region": "Where they are located / serve",
  "match": "How they match the item and quality constraints",
  "pricing": "Indicative pricing for the requested quantity",
  "leadTime": "Shipping / lead time information",
  "notes": "Certifications, notable customers, risks, or limitations",
  "contactMethod": "Phone or Email or Web Form",
  "formUrl": "URL to contact form if applicable, or null"
}

Return 5-10 vendors. Return ONLY the JSON array, nothing else.`;

const DISCOVERY_ANGLES = [
  'Find top manufacturers and wholesale suppliers for',
  'Find specialty distributors and certified vendors for',
  'Find competitive budget-friendly suppliers with fast shipping for',
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
  spec: { item: string; quantity: string; leadTime?: string; quality?: string; location?: string },
  angle: string = ''
): Promise<DiscoveryResult> {
  const userMessage = [
    angle,
    spec.item,
    spec.quantity ? `Quantity: ${spec.quantity}` : '',
    spec.leadTime ? `Lead time: ${spec.leadTime}` : '',
    spec.quality ? `Quality/certs: ${spec.quality}` : '',
    spec.location ? `Delivery location: ${spec.location}` : '',
  ]
    .filter(Boolean)
    .join('. ');

  console.log(`[PERPLEXITY] discoverVendors() called — angle="${angle.slice(0, 50)}..."`);
  console.log(`[PERPLEXITY] User message: "${userMessage.slice(0, 120)}..."`);
  console.log(`[PERPLEXITY] API key present:`, !!process.env.PERPLEXITY_API_KEY);
  console.log(`[PERPLEXITY] API key prefix:`, process.env.PERPLEXITY_API_KEY?.slice(0, 8) + '...');

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: DISCOVERY_SYSTEM_PROMPT },
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
  spec: { item: string; quantity: string; leadTime?: string; quality?: string; location?: string },
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
