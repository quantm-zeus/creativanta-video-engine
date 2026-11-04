#!/usr/bin/env node
/**
 * Creativanta Video Engine - Cost Reporting CLI Tool
 * Usage: node ops/cost/cost-cli.mjs --tenant <tenantId> --input <jobs.json> [--period daily|weekly] [--format json|markdown]
 */

import fs from 'node:fs';
import { generateDailyReport, generateWeeklyReport } from './cost-reporter.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    tenant: 'tenant_default',
    input: null,
    period: 'daily',
    format: 'markdown',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tenant' && args[i + 1]) options.tenant = args[++i];
    else if (args[i] === '--input' && args[i + 1]) options.input = args[++i];
    else if (args[i] === '--period' && args[i + 1]) options.period = args[++i];
    else if (args[i] === '--format' && args[i + 1]) options.format = args[++i];
  }
  return options;
}

function main() {
  const options = parseArgs();
  let jobs = [];

  if (options.input) {
    if (!fs.existsSync(options.input)) {
      console.error(`Input file not found: ${options.input}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(options.input, 'utf-8');
    jobs = JSON.parse(raw);
  } else {
    // Sample jobs for demonstration or validation
    jobs = [
      {
        jobId: 'job_sample_01',
        status: 'succeeded',
        jobKind: 'render',
        profile: 'mp4-720p-v1',
        wallSeconds: 45,
        cpuSecondsActual: 38,
        outputDurationSeconds: 15,
        outputBytes: 3145728, // ~3MB
        peakMemoryBytes: 450 * 1024 * 1024,
      },
      {
        jobId: 'job_sample_02',
        status: 'succeeded',
        jobKind: 'render',
        profile: 'mp4-720p-v1',
        wallSeconds: 90,
        cpuSecondsActual: 75,
        outputDurationSeconds: 30,
        outputBytes: 6291456, // ~6MB
        peakMemoryBytes: 520 * 1024 * 1024,
      },
    ];
  }

  const report =
    options.period === 'weekly'
      ? generateWeeklyReport(options.tenant, jobs)
      : generateDailyReport(options.tenant, jobs);

  if (options.format === 'json') {
    console.log(JSON.stringify(report.summary, null, 2));
  } else {
    console.log(report.markdown);
  }
}

if (process.argv[1] && process.argv[1].endsWith('cost-cli.mjs')) {
  main();
}
