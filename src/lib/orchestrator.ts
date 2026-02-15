// Orchestrator: runs the full procurement workflow
// Stage 1: Discovery (Perplexity Sonar) -> find vendors + contact info -> store in PG
// Stage 2: Voice calls (ElevenLabs round 1) -> get real quotes -> store offers in PG  [DONE]
// Stage 3: Negotiation (ElevenLabs round 2) -> negotiate best price                   [TODO]
// Stage 4: Summary -> rank offers, compute savings, emit final result                 [TODO]
//
// The frontend sees activity events (what the agent is doing) and quote events (from voice calls).
// Round 2 negotiation is triggered separately after round 1 results are reviewed.

import { prisma } from './db';
import { emitRunEvent } from './events';
import { runDiscoveryLoop, type VendorCandidate } from './perplexity';
import { writeMemory } from './elastic';
import { triggerOutboundCall, buildDynamicVariables, resolveDialNumber } from './elevenlabs';
import { assembleOutreachContext } from './outreach';

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

            // ===== ROUND 1: Trigger outbound calls for initial quotes =====
            const agentIdQuote = process.env.ELEVENLABS_AGENT_ID_QUOTE;
            const agentIdNegotiate = process.env.ELEVENLABS_AGENT_ID_NEGOTIATE;
            const agentPhoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID;
            const MAX_CONCURRENT_CALLS = 3;

            if (!agentIdQuote || !agentPhoneNumberId) {
                console.error('[ORCHESTRATOR] Missing ELEVENLABS_AGENT_ID_QUOTE or ELEVENLABS_PHONE_NUMBER_ID — skipping calls');
                emitRunEvent(runId, {
                    type: 'update_activity',
                    payload: { id: callPlanId, updates: { status: 'error', description: 'ElevenLabs not configured — missing ELEVENLABS_AGENT_ID_QUOTE or ELEVENLABS_PHONE_NUMBER_ID env vars.' } },
                });
            } else {
                const callResults: Array<{ vendorName: string; callId: string; conversationId: string; success: boolean; error?: string }> = [];

                // Process vendors in batches of MAX_CONCURRENT_CALLS
                for (let batchStart = 0; batchStart < vendorsWithPhone.length; batchStart += MAX_CONCURRENT_CALLS) {
                    const batch = vendorsWithPhone.slice(batchStart, batchStart + MAX_CONCURRENT_CALLS);
                    console.log(`[ORCHESTRATOR] Call batch ${Math.floor(batchStart / MAX_CONCURRENT_CALLS) + 1}: ${batch.map(v => v.name).join(', ')}`);

                    const batchPromises = batch.map(async (vendor, i) => {
                        const callActivityId = makeActivityId();
                        emitRunEvent(runId, {
                            type: 'activity',
                            payload: {
                                id: callActivityId,
                                type: 'call',
                                title: `Calling ${vendor.name}`,
                                description: `Dialing ${vendor.phone} to request pricing quote...`,
                                timestamp: new Date(),
                                status: 'running',
                                tool: 'elevenlabs',
                            },
                        });

                        try {
                            // Assemble outreach context from PG + ES
                            console.log(`[ORCHESTRATOR] Assembling outreach context for ${vendor.name}...`);
                            const ctx = await assembleOutreachContext(runId, vendor.id);

                            // Resolve phone number (may be overridden for testing)
                            const vendorIndex = batchStart + i;
                            const { dialNumber, isOverridden } = resolveDialNumber(vendor.phone!, vendorIndex);
                            if (isOverridden) {
                                console.log(`[ORCHESTRATOR] ⚠️ TEST MODE: Calling ${dialNumber} instead of ${vendor.phone} for ${vendor.name}`);
                            }

                            // Build dynamic variables (injected into prompt {{var}} templates)
                            const dynamicVariables = buildDynamicVariables(ctx, runId, vendor.id, 1);

                            // Trigger outbound call
                            console.log(`[ORCHESTRATOR] Triggering call to ${vendor.name} at ${dialNumber}...`);
                            const callResponse = await triggerOutboundCall({
                                agentId: agentIdQuote!,
                                agentPhoneNumberId,
                                toNumber: dialNumber,
                                dynamicVariables,
                            });

                            // Create Call row in Postgres
                            const call = await prisma.call.create({
                                data: {
                                    vendorId: vendor.id,
                                    runId,
                                    round: 1,
                                    conversationId: callResponse.conversation_id,
                                    status: 'in-progress',
                                },
                            });

                            callResults.push({
                                vendorName: vendor.name,
                                callId: call.id,
                                conversationId: callResponse.conversation_id,
                                success: true,
                            });

                            console.log(`[ORCHESTRATOR] Call initiated — vendor=${vendor.name}, callId=${call.id}, conversationId=${callResponse.conversation_id}`);

                            emitRunEvent(runId, {
                                type: 'update_activity',
                                payload: {
                                    id: callActivityId,
                                    updates: {
                                        status: 'done',
                                        description: `Call placed to ${vendor.name}${isOverridden ? ' (test mode)' : ` at ${vendor.phone}`}. Waiting for transcript...`,
                                    },
                                },
                            });
                        } catch (err) {
                            console.error(`[ORCHESTRATOR] Failed to call ${vendor.name}:`, err);
                            callResults.push({
                                vendorName: vendor.name,
                                callId: '',
                                conversationId: '',
                                success: false,
                                error: (err as Error).message,
                            });

                            emitRunEvent(runId, {
                                type: 'update_activity',
                                payload: {
                                    id: callActivityId,
                                    updates: {
                                        status: 'error',
                                        description: `Failed to call ${vendor.name}: ${(err as Error).message.slice(0, 100)}`,
                                    },
                                },
                            });
                        }
                    });

                    // Wait for entire batch to finish before starting next batch
                    await Promise.allSettled(batchPromises);

                    // Brief delay between batches
                    if (batchStart + MAX_CONCURRENT_CALLS < vendorsWithPhone.length) {
                        console.log(`[ORCHESTRATOR] Batch complete, pausing before next batch...`);
                        await sleep(2000);
                    }
                }

                // Update call plan summary
                const successCount = callResults.filter(r => r.success).length;
                const failCount = callResults.filter(r => !r.success).length;
                emitRunEvent(runId, {
                    type: 'update_activity',
                    payload: {
                        id: callPlanId,
                        updates: {
                            status: failCount === callResults.length ? 'error' : 'done',
                            description: `${successCount}/${vendorsWithPhone.length} calls placed successfully${failCount > 0 ? `, ${failCount} failed` : ''}. Waiting for transcripts via webhook.`,
                        },
                    },
                });

                console.log(`[ORCHESTRATOR] All round 1 calls initiated — ${successCount} succeeded, ${failCount} failed`);

                // Orchestrator is DONE — webhook takes over from here.
                // The webhook handler will:
                //   1. Process each transcript as it arrives
                //   2. Check if all round 1 calls are done
                //   3. Auto-trigger round 2 negotiation (startNegotiationRound)
                //   4. Auto-trigger final summary (finalizeSummary)
                await prisma.run.update({ where: { id: runId }, data: { status: 'calling_round_1' } });
            }
        }

        console.log(`[ORCHESTRATOR] ========================================`);
        console.log(`[ORCHESTRATOR] Run ${runId} — calls fired, webhook takes over`);
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
        await prisma.run.update({ where: { id: runId }, data: { status: 'failed' } }).catch(() => { });
    }
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
