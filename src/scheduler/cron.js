// wires the pipeline stages to cron cadences

const cron = require('node-cron');
const { runPythonWorker } = require('../utils/pythonBridge');
const { transition, claimBatch, markFailed, updateFields } = require('../pipeline/stateMachine');

const BATCH_SIZE = 25;

async function runStage(fromStatus, worker, buildFields) {
  const batch = await claimBatch(fromStatus, BATCH_SIZE);
  console.log(`[cron] ${fromStatus}: claimed ${batch.length} prospect(s)`);

  for (const prospect of batch) {
    try {
      const result = await runPythonWorker(worker, prospect);
      const { toStatus, fields } = buildFields(result);
      await transition(prospect.id, toStatus, fields);
    } catch (err) {
      console.error(`[cron] ${fromStatus} failed for ${prospect.id}:`, err.message);
      await markFailed(prospect.id, err.message).catch((e) =>
        console.error('[cron] markFailed itself failed:', e.message)
      );
    }
  }
}

function enrichStage() {
  return runStage('new', 'news_parser.py', (result) => ({
    toStatus: 'enriched',
    fields: {
      trigger_event: result.trigger_event,
      company_domain: result.company_domain,
      company_industry: result.company_industry,
    },
  }));
}

function draftStage() {
  return runStage('enriched', 'llm_enrich.py', (result) => ({
    toStatus: 'drafted',
    fields: {
      icebreaker_hook: result.icebreaker_hook,
      hypothesized_bottleneck: result.hypothesized_bottleneck,
      proposed_solution: result.proposed_solution,
      subject_line_1: result.subject_line_1,
      subject_line_2: result.subject_line_2,
      subject_line_3: result.subject_line_3,
      email_body: result.email_body,
    },
  }));
}

async function verifyStage() {
  // verification doesn't advance the pipeline stage. it only records deliverability so the approval step can filter on it.
  const batch = await claimBatch('drafted', BATCH_SIZE);
  console.log(`[cron] verify: claimed ${batch.length} prospect(s)`);

  for (const prospect of batch) {
    try {
      const result = await runPythonWorker('domain_verify.py', prospect);
      await updateFields(prospect.id, {
        verification_status: result.verification_status,
        mx_record_found: result.mx_record_found,
        verification_checked_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[cron] verify failed for ${prospect.id}:`, err.message);
      // verification failure shouldn't fail the whole prospect
    }
  }
}

function start() {
  cron.schedule(process.env.CRON_ENRICH || '*/10 * * * *', () => {
    enrichStage().catch((err) => console.error('[cron] enrichStage crashed:', err));
  });

  cron.schedule(process.env.CRON_DRAFT || '*/15 * * * *', () => {
    draftStage().catch((err) => console.error('[cron] draftStage crashed:', err));
  });

  cron.schedule(process.env.CRON_VERIFY || '*/5 * * * *', () => {
    verifyStage().catch((err) => console.error('[cron] verifyStage crashed:', err));
  });

  console.log('[cron] Scheduler started.');
}

module.exports = { start, enrichStage, draftStage, verifyStage };
