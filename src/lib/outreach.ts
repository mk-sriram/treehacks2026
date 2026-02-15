// assembleOutreachContext — builds the flat context object
// that ElevenLabs dynamic_variables will consume for each vendor call.
//
// Reads from:
//   Postgres: Run (parsedSpec), Vendor (contact + metadata), competing Offers
//   Elasticsearch: past interactions with this vendor + run-level discovery data

import { prisma } from './db';
import { retrieveMemory } from './elastic';

/** Shape returned to ElevenLabs as dynamic_variables */
export interface OutreachContext {
  // Vendor info
  vendorName: string;
  vendorPhone: string;
  vendorUrl: string;
  vendorNotes: string;

  // What we're buying
  item: string;
  quantity: string;
  deadline: string;
  quality: string;

  // Competitive intelligence
  indicativePricing: string;
  competingOffers: string;

  // Memory (from ES)
  pastHistory: string;

  // For round 2 negotiation (empty on round 1)
  bestPrice: string;
  bestSupplier: string;
  targetPrice: string;

  // LLM-generated per-vendor negotiation strategy (round 2 only, empty on round 1)
  negotiationPlan: string;
}

/**
 * Assemble everything the voice agent needs before calling a vendor.
 *
 * @param runId   – the Run id (Prisma)
 * @param vendorId – the Vendor id (Prisma)
 * @returns a flat OutreachContext ready for ElevenLabs dynamic_variables
 */
export async function assembleOutreachContext(
  runId: string,
  vendorId: string,
): Promise<OutreachContext> {
  console.log(`[OUTREACH] Assembling context — runId=${runId}, vendorId=${vendorId}`);

  // ---- Postgres reads (parallel) ----
  const [run, vendor, competingOffers] = await Promise.all([
    prisma.run.findUniqueOrThrow({ where: { id: runId } }),

    prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } }),

    // All offers for this run from OTHER vendors (competitive intel)
    prisma.offer.findMany({
      where: {
        vendor: { runId },
        vendorId: { not: vendorId },
      },
      include: { vendor: { select: { name: true } } },
      orderBy: { unitPrice: 'asc' },
    }),
  ]);

  const spec = run.parsedSpec as {
    item: string;
    quantity: string;
    leadTime?: string;
    quality?: string;
    location?: string;
  };

  const meta = (vendor.metadata ?? {}) as Record<string, any>;

  // ---- Elasticsearch reads (parallel, non-fatal) ----
  let vendorHistory = '';
  let runDiscovery = '';

  try {
    const [vendorHitsRes, runHitsRes] = await Promise.allSettled([
      retrieveMemory(spec.item, { vendor_id: vendorId }),
      retrieveMemory(spec.item, { run_id: runId }),
    ]);

    if (vendorHitsRes.status === 'fulfilled') {
      const hits = vendorHitsRes.value.hits?.hits ?? [];
      if (hits.length > 0) {
        vendorHistory = hits
          .map((h: any) => (h._source?.text as string) ?? '')
          .filter(Boolean)
          .join(' | ');
      }
    } else {
      console.warn('[OUTREACH] ES vendor history lookup failed:', vendorHitsRes.reason);
    }

    if (runHitsRes.status === 'fulfilled') {
      const hits = runHitsRes.value.hits?.hits ?? [];
      if (hits.length > 0) {
        runDiscovery = hits
          .map((h: any) => (h._source?.text as string) ?? '')
          .filter(Boolean)
          .join(' | ');
      }
    } else {
      console.warn('[OUTREACH] ES run discovery lookup failed:', runHitsRes.reason);
    }
  } catch (err) {
    console.warn('[OUTREACH] ES reads failed (non-fatal):', err);
  }

  // ---- Build competing offers string ----
  let competingOffersStr = 'No competing quotes yet';
  if (competingOffers.length > 0) {
    competingOffersStr = competingOffers
      .map((o) => {
        const name = (o as any).vendor?.name ?? 'Unknown';
        const price = o.unitPrice != null ? `$${o.unitPrice}` : 'price TBD';
        const lead = o.leadTimeDays != null ? `${o.leadTimeDays}d lead` : '';
        return `${name} quoted ${price}${lead ? `, ${lead}` : ''}`;
      })
      .join('; ');
  }

  // ---- Find best existing offer for negotiation context ----
  let bestPrice = '';
  let bestSupplier = '';
  let targetPrice = '';

  if (competingOffers.length > 0) {
    const best = competingOffers.find((o) => o.unitPrice != null);
    if (best) {
      bestPrice = `$${best.unitPrice}`;
      bestSupplier = (best as any).vendor?.name ?? 'Unknown';
      // Target 10-15% below best for negotiation leverage
      targetPrice = best.unitPrice != null
        ? `$${(best.unitPrice * 0.875).toFixed(2)}`
        : '';
    }
  }

  const context: OutreachContext = {
    // Vendor info
    vendorName: vendor.name,
    vendorPhone: vendor.phone ?? '',
    vendorUrl: vendor.url ?? '',
    vendorNotes: meta.notes ?? meta.match ?? '',

    // What we're buying
    item: spec.item,
    quantity: spec.quantity,
    deadline: spec.leadTime ?? '',
    quality: spec.quality ?? '',

    // Competitive intelligence
    indicativePricing: meta.pricing ?? '',
    competingOffers: competingOffersStr,

    // Memory
    pastHistory: vendorHistory || 'No prior interactions with this vendor',

    // Negotiation (populated on round 2)
    bestPrice,
    bestSupplier,
    targetPrice,

    // LLM negotiation strategy (injected by startNegotiationRound, empty on round 1)
    negotiationPlan: '',
  };

  console.log(`[OUTREACH] Context assembled for ${vendor.name}:`, {
    item: context.item,
    quantity: context.quantity,
    indicativePricing: context.indicativePricing,
    competingOffers: context.competingOffers.slice(0, 100),
    pastHistory: context.pastHistory.slice(0, 100),
    bestPrice: context.bestPrice,
  });

  return context;
}
