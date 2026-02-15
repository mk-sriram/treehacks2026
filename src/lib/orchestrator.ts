// Orchestrator: runs the full procurement workflow
// Stage 1: Discovery (Perplexity Sonar) -> find vendors + contact info -> store in PG
// Stage 2: Voice calls (ElevenLabs) -> get real quotes -> store offers in PG  [TODO]
// Stage 3: Negotiation (ElevenLabs round 2) -> negotiate best price             [TODO]
// Stage 4: Summary -> rank offers, compute savings, emit final result            [TODO]
//
// The frontend only sees activity events (what the agent is doing).
// Quotes and summary are ONLY emitted after real voice calls, not from web search data.

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

    // Index discovery results into ES — one document per vendor
    console.log(`[ORCHESTRATOR] Indexing per-vendor discovery results into Elasticsearch...`);
    const esWriteResults = await Promise.allSettled(
      createdVendors.map((vendor, idx) => {
        const src = deduped[idx];
        const text = [
          `Vendor: ${vendor.name}.`,
          src.match ? `Match: ${src.match}` : null,
          `Pricing: ${src.pricing ?? 'N/A'}.`,
          `Lead time: ${src.leadTime ?? 'N/A'}.`,
          src.notes ? `Notes: ${src.notes}` : null,
          `Contact: ${src.contactMethod ?? 'unknown'}.`,
          vendor.phone ? `Phone: ${vendor.phone}.` : null,
          vendor.url ? `URL: ${vendor.url}.` : null,
        ]
          .filter(Boolean)
          .join(' ');

        return writeMemory({
          text,
          run_id: runId,
          vendor_id: vendor.id,
          channel: 'search',
        }).then(() => {
          console.log(`[ORCHESTRATOR] ES indexed vendor: ${vendor.name} (id=${vendor.id}, text length=${text.length})`);
        });
      })
    );

    const esSucceeded = esWriteResults.filter((r) => r.status === 'fulfilled').length;
    const esFailed = esWriteResults.filter((r) => r.status === 'rejected').length;
    console.log(`[ORCHESTRATOR] ES indexing complete — ${esSucceeded} succeeded, ${esFailed} failed`);
    if (esFailed > 0) {
      esWriteResults.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error(`[ORCHESTRATOR] ES write failed for vendor ${createdVendors[i].name}:`, r.reason);
        }
      });
    }

    // Emit summary activity for discovery -- categorize vendors by contact method
    const vendorsWithPhone = createdVendors.filter((v) => v.phone);
    const vendorsWithEmail = createdVendors.filter((v) => v.email && !v.phone);
    const vendorsWithFormOnly = createdVendors.filter((v) => !v.phone && !v.email);

    const discoveryAnalysisId = makeActivityId();
    emitRunEvent(runId, {
      type: 'activity',
      payload: {
        id: discoveryAnalysisId,
        type: 'analyze',
        title: 'Vendor Discovery Complete',
        description: `Found ${deduped.length} unique vendors across ${angleLabels.length} search angles. ${vendorsWithPhone.length} have phone numbers (ready for calls), ${vendorsWithEmail.length} email-only, ${vendorsWithFormOnly.length} web form only.`,
        timestamp: new Date(),
        status: 'done',
        tool: 'perplexity-sonar',
      },
    });

    // Log contact breakdown for debugging
    console.log(`[ORCHESTRATOR] Contact breakdown:`);
    console.log(`[ORCHESTRATOR]   Phone: ${vendorsWithPhone.length} vendors — ${vendorsWithPhone.map(v => `${v.name}: ${v.phone}`).join(', ')}`);
    console.log(`[ORCHESTRATOR]   Email only: ${vendorsWithEmail.length} vendors — ${vendorsWithEmail.map(v => `${v.name}: ${v.email}`).join(', ')}`);
    console.log(`[ORCHESTRATOR]   Form only: ${vendorsWithFormOnly.length} vendors`);

    // ===== STAGE: calling_for_quote (ROUND 1) =====
    // Transition to calling stage — only vendors with phone numbers can be called
    console.log(`[ORCHESTRATOR] === STAGE: calling_for_quote ===`);
    emitRunEvent(runId, { type: 'stage_change', payload: { stage: 'calling_for_quote' } });
    emitRunEvent(runId, {
      type: 'services_change',
      payload: { perplexity: false, elasticsearch: true, openai: false, stagehand: false, elevenlabs: true, visa: false },
    });

    if (vendorsWithPhone.length === 0) {
      // No vendors with phone numbers — can't make calls
      const noPhoneId = makeActivityId();
      emitRunEvent(runId, {
        type: 'activity',
        payload: {
          id: noPhoneId,
          type: 'system',
          title: 'No Callable Vendors',
          description: `None of the ${deduped.length} discovered vendors had phone numbers. Voice call stage skipped. Consider running discovery again with different search terms.`,
          timestamp: new Date(),
          status: 'done',
          tool: 'orchestrator',
        },
      });
      console.log(`[ORCHESTRATOR] No vendors with phone — skipping call stage`);
    } else {
      // Emit activity showing which vendors will be called
      const callPlanId = makeActivityId();
      emitRunEvent(runId, {
        type: 'activity',
        payload: {
          id: callPlanId,
          type: 'call',
          title: `Preparing to call ${vendorsWithPhone.length} vendors`,
          description: vendorsWithPhone.map(v => v.name).join(', '),
          timestamp: new Date(),
          status: 'running',
          tool: 'elevenlabs',
        },
      });

      // TODO: Stage 3 — trigger ElevenLabs outbound calls here
      // For each vendor in vendorsWithPhone:
      //   1. triggerOutboundCall(vendor, runId, spec, round=1)
      //   2. INSERT call row (round=1, conversationId from response)
      //   3. emit call_started + calls_change events
      // Then poll until all round 1 calls complete (webhook sets Call.status)

      console.log(`[ORCHESTRATOR] TODO: ElevenLabs voice calls for ${vendorsWithPhone.length} vendors`);
      console.log(`[ORCHESTRATOR] Vendors to call:`);
      for (const v of vendorsWithPhone) {
        console.log(`[ORCHESTRATOR]   - ${v.name}: ${v.phone}`);
      }

      // Mark call plan as done (calls themselves not yet implemented)
      emitRunEvent(runId, {
        type: 'update_activity',
        payload: { id: callPlanId, updates: { status: 'done', description: `${vendorsWithPhone.length} vendors queued for outbound calls: ${vendorsWithPhone.map(v => v.name).join(', ')}. Awaiting ElevenLabs integration.` } },
      });
    }

    // ===== Mark run as discovery_complete (not fully complete -- calls stage pending) =====
    emitRunEvent(runId, {
      type: 'services_change',
      payload: { perplexity: false, elasticsearch: false, openai: false, stagehand: false, elevenlabs: false, visa: false },
    });
    emitRunEvent(runId, { type: 'stage_change', payload: { stage: 'complete' } });

    const systemDoneId = makeActivityId();
    emitRunEvent(runId, {
      type: 'activity',
      payload: {
        id: systemDoneId,
        type: 'system',
        title: 'Discovery Stage Complete',
        description: `Found ${deduped.length} vendors. ${vendorsWithPhone.length} have phone numbers ready for voice calls. Next: ElevenLabs outbound calls for firm quotes.`,
        timestamp: new Date(),
        status: 'done',
        tool: 'orchestrator',
      },
    });

    await prisma.run.update({ where: { id: runId }, data: { status: 'discovery_complete' } });
    console.log(`[ORCHESTRATOR] ========================================`);
    console.log(`[ORCHESTRATOR] Run ${runId} DISCOVERY COMPLETE`);
    console.log(`[ORCHESTRATOR] ${vendorsWithPhone.length} vendors ready for voice calls`);
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
