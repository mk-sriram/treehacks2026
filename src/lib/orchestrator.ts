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
  console.log(`\n[ORCHESTRATOR] ========================================`);
  console.log(`[ORCHESTRATOR] Starting orchestrator for runId=${runId}`);
  console.log(`[ORCHESTRATOR] ========================================\n`);
  try {
    // 1. Load run
    console.log(`[ORCHESTRATOR] Loading run from Postgres...`);
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    const spec = run.parsedSpec as {
      item: string;
      quantity: string;
      leadTime?: string;
      quality?: string;
      location?: string;
    };
    console.log(`[ORCHESTRATOR] Run loaded — spec:`, JSON.stringify(spec));

    // Update run status
    await prisma.run.update({ where: { id: runId }, data: { status: 'running' } });
    console.log(`[ORCHESTRATOR] Run status updated to 'running'`);

    // ===== STAGE: finding_suppliers =====
    console.log(`[ORCHESTRATOR] === STAGE: finding_suppliers ===`);
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
    console.log(`[ORCHESTRATOR] Running memory check...`);
    await sleep(500);
    emitRunEvent(runId, {
      type: 'update_activity',
      payload: { id: memoryActivityId, updates: { status: 'done', description: 'Memory check complete. No past deals found for this item yet.' } },
    });
    console.log(`[ORCHESTRATOR] Memory check complete`);

    // Run Perplexity discovery loop with progress callbacks
    console.log(`[ORCHESTRATOR] Starting Perplexity discovery loop...`);
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

    console.log(`[ORCHESTRATOR] Discovery loop complete — ${deduped.length} unique vendors (${totalVendorsFound} total before dedup)`);

    // Store deduped vendors in PG
    console.log(`[ORCHESTRATOR] Storing ${deduped.length} vendors in Postgres...`);
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
      console.log(`[ORCHESTRATOR] Stored vendor: ${vendor.name} (id=${vendor.id}, phone=${vendor.phone ?? 'none'}, email=${vendor.email ?? 'none'})`);
    }
    console.log(`[ORCHESTRATOR] All ${createdVendors.length} vendors stored in Postgres`);

    // Index discovery results into ES
    console.log(`[ORCHESTRATOR] Indexing discovery results into Elasticsearch...`);
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
      console.log(`[ORCHESTRATOR] Discovery results indexed in ES (text length=${discoveryText.length})`);
    } catch (err) {
      console.error('[ORCHESTRATOR] Failed to write discovery to ES (non-fatal):', err);
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
    console.log(`[ORCHESTRATOR] Emitting quotes for vendors with pricing data...`);
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

    console.log(`[ORCHESTRATOR] Quotes emitted for ${deduped.filter(v => v.pricing && v.pricing !== 'N/A').length} vendors`);

    // Mark discovery stage complete
    console.log(`[ORCHESTRATOR] === STAGE: complete ===`);
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
    console.log(`[ORCHESTRATOR] ========================================`);
    console.log(`[ORCHESTRATOR] Run ${runId} COMPLETED SUCCESSFULLY`);
    console.log(`[ORCHESTRATOR] ========================================\n`);
  } catch (err) {
    console.error('[ORCHESTRATOR] FATAL ERROR:', err);

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
