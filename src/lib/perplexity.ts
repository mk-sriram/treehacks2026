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

  if (!res.ok) {
    const errText = await res.text();
    console.error('Perplexity API error:', res.status, errText);
    return { vendors: [], citations: [], rawContent: errText };
  }

  const data = await res.json();
  const rawContent = data.choices?.[0]?.message?.content ?? '';
  const citations: string[] = data.citations ?? [];

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
  } catch {
    // Try to extract JSON array from the content
    try {
      const match = rawContent.match(/\[[\s\S]*\]/);
      if (match) {
        vendors = JSON.parse(match[0]);
      }
    } catch {
      console.error('Failed to parse Perplexity response as JSON:', rawContent.slice(0, 200));
      vendors = [];
    }
  }

  return { vendors, citations, rawContent };
}

export async function runDiscoveryLoop(
  spec: { item: string; quantity: string; leadTime?: string; quality?: string; location?: string },
  onProgress?: (angle: string, vendors: VendorCandidate[], citations: string[]) => void
): Promise<VendorCandidate[]> {
  const allVendors: VendorCandidate[] = [];

  for (const angle of DISCOVERY_ANGLES) {
    const { vendors, citations } = await discoverVendors(spec, angle);

    // Attach source URLs from citations
    const vendorsWithSources = vendors.map((v, i) => ({
      ...v,
      sourceUrl: citations[i] ?? null,
    }));

    // Notify caller of progress (for SSE events)
    onProgress?.(angle, vendorsWithSources, citations);

    allVendors.push(...vendorsWithSources);
  }

  // Simple dedupe by name (case-insensitive)
  const seen = new Set<string>();
  return allVendors.filter((v) => {
    const key = v.name?.toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
