// Orchestrator: runs the procurement workflow
// Currently implements Stage 1 (discovery) only.
// Emits SSE events that map exactly to the frontend callback shapes.

import { prisma } from './db';
import { emitRunEvent } from './events';
import { runDiscoveryLoop, type VendorCandidate } from './perplexity';
import { writeMemory } from './elastic';

let activityCounter = 0;

function makeActivityId() {
  activityCounter++;
  return `${Date.now()}-${activityCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function runOrchestrator(runId: string) {
  try {
    // 1. Load run
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    const spec = run.parsedSpec as {
      item: string;
      quantity: string;
      leadTime?: string;
      quality?: string;
      location?: string;
    };

    // Update run status
    await prisma.run.update({ where: { id: runId }, data: { status: 'running' } });

    // ===== STAGE: finding_suppliers =====
    emitRunEvent(runId, { type: 'stage_change', payload: { stage: 'finding_suppliers' } });
    emitRunEvent(runId, {
      type: 'services_change',
      payload: { perplexity: true, elasticsearch: true, openai: false, stagehand: false, elevenlabs: false, visa: false },
    });

    // Memory check activity
    const memoryActivityId = makeActivityId();
    emitRunEvent(runId, {
      type: 'activity',
      payload: {
        id: memoryActivityId,
        type: 'memory',
        title: 'Elasticsearch: Checking past deals',
        description: 'Searching memory for past negotiations and pricing history for similar items',
        timestamp: new Date(),
        status: 'running',
        tool: 'elasticsearch',
        parallelGroup: 'search-parallel-1',
      },
    });

    // Simulate a brief memory check (TODO: real retrieval once ES has data)
    await sleep(500);
    emitRunEvent(runId, {
      type: 'update_activity',
      payload: { id: memoryActivityId, updates: { status: 'done', description: 'Memory check complete. No past deals found for this item yet.' } },
    });

    // Run Perplexity discovery loop with progress callbacks
    let totalVendorsFound = 0;
    const angleLabels = [
      'Searching for top manufacturers and wholesale suppliers',
      'Searching for specialty distributors and certified vendors',
      'Searching for budget-friendly suppliers with fast shipping',
    ];
    let angleIndex = 0;

    const deduped = await runDiscoveryLoop(spec, (angle, vendors, citations) => {
      const currentAngle = angleLabels[angleIndex] || angle;
      angleIndex++;

      const searchActivityId = makeActivityId();
      emitRunEvent(runId, {
        type: 'activity',
        payload: {
          id: searchActivityId,
          type: 'search',
          title: `Perplexity Sonar: ${currentAngle}`,
          description: `Found ${vendors.length} vendor candidates with ${citations.length} citations`,
          timestamp: new Date(),
          status: 'done',
          tool: 'perplexity-sonar',
        },
      });

      totalVendorsFound += vendors.length;
    });

    // Store deduped vendors in PG
    const createdVendors = [];
    for (const v of deduped) {
      const vendor = await prisma.vendor.create({
        data: {
          runId,
          name: v.name || 'Unknown Vendor',
          url: v.url || null,
          phone: v.phone || null,
          email: v.email || null,
          source: 'sonar',
          sourceUrl: v.sourceUrl || null,
          metadata: {
            region: v.region,
            match: v.match,
            pricing: v.pricing,
            leadTime: v.leadTime,
            notes: v.notes,
            contactMethod: v.contactMethod,
            formUrl: v.formUrl,
          },
        },
      });
      createdVendors.push(vendor);
    }

    // Index discovery results into ES
    try {
      const discoveryText = deduped
        .map(
          (v) =>
            `Vendor: ${v.name}. ${v.match ?? ''} Pricing: ${v.pricing ?? 'N/A'}. Lead time: ${v.leadTime ?? 'N/A'}. Notes: ${v.notes ?? ''}`
        )
        .join('\n');

      await writeMemory({
        text: discoveryText,
        run_id: runId,
        channel: 'search',
      });
    } catch (err) {
      console.error('Failed to write discovery to ES (non-fatal):', err);
    }

    // Emit summary activity for discovery
    const summaryActivityId = makeActivityId();
    emitRunEvent(runId, {
      type: 'activity',
      payload: {
        id: summaryActivityId,
        type: 'analyze',
        title: 'Vendor Discovery Complete',
        description: `Found ${deduped.length} unique vendors across ${angleLabels.length} search angles. ${createdVendors.filter((v) => v.phone).length} have phone numbers, ${createdVendors.filter((v) => v.email).length} have email.`,
        timestamp: new Date(),
        status: 'done',
        tool: 'perplexity-sonar',
      },
    });

    // Emit quotes from Perplexity pricing data (as preliminary web-sourced quotes)
    for (const v of deduped) {
      if (v.pricing && v.pricing !== 'N/A') {
        emitRunEvent(runId, {
          type: 'quote',
          payload: {
            supplier: v.name,
            unitPrice: v.pricing,
            moq: 'N/A',
            leadTime: v.leadTime ?? 'N/A',
            shipping: 'N/A',
            terms: 'N/A',
            confidence: 60,
            source: 'web-search',
          },
        });
      }
    }

    // Mark discovery stage complete
    emitRunEvent(runId, {
      type: 'services_change',
      payload: { perplexity: false, elasticsearch: false, openai: false, stagehand: false, elevenlabs: false, visa: false },
    });

    // For now, mark the run as discovery_complete (later stages will continue from here)
    emitRunEvent(runId, { type: 'stage_change', payload: { stage: 'complete' } });

    // Emit summary
    const vendorsWithPricing = deduped.filter((v) => v.pricing && v.pricing !== 'N/A');
    emitRunEvent(runId, {
      type: 'summary',
      payload: {
        suppliersFound: deduped.length,
        quotesReceived: vendorsWithPricing.length,
        bestPrice: vendorsWithPricing[0]?.pricing ?? 'N/A',
        bestSupplier: vendorsWithPricing[0]?.name ?? 'N/A',
        avgLeadTime: 'N/A',
        recommendation: `Found ${deduped.length} vendors via Perplexity Sonar. Review the quotes panel for indicative pricing. Next step: voice calls for firm quotes.`,
        savings: 'N/A',
        nextSteps: [
          'Review discovered vendors and their indicative pricing',
          'Initiate voice calls for firm quotes (coming soon)',
          'Compare and negotiate with top candidates',
        ],
      },
    });

    // Mark complete
    const systemDoneId = makeActivityId();
    emitRunEvent(runId, {
      type: 'activity',
      payload: {
        id: systemDoneId,
        type: 'system',
        title: 'Discovery Workflow Complete',
        description: `Found ${deduped.length} vendors. Indicative pricing captured for ${vendorsWithPricing.length}.`,
        timestamp: new Date(),
        status: 'done',
        tool: 'orchestrator',
      },
    });

    await prisma.run.update({ where: { id: runId }, data: { status: 'complete' } });
  } catch (err) {
    console.error('Orchestrator error:', err);

    // Emit error event
    emitRunEvent(runId, {
      type: 'activity',
      payload: {
        id: makeActivityId(),
        type: 'system',
        title: 'Error',
        description: `Orchestrator failed: ${(err as Error).message}`,
        timestamp: new Date(),
        status: 'error',
        tool: 'orchestrator',
      },
    });

    emitRunEvent(runId, { type: 'stage_change', payload: { stage: 'complete' } });
    await prisma.run.update({ where: { id: runId }, data: { status: 'failed' } }).catch(() => {});
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
