/**
 * `webdiag scan` — the CLI adapter around the scan pipeline.
 *
 * It only translates: argv in, exit code and console lines out. Anything that
 * decides *what* the diagnostic says lives under `src/scan/`, so the pipeline
 * stays testable without a process.
 */
import { parseScanArgs, runScan, type ScanOptions } from '../scan/index.ts';
import { PROGRAM_NAME } from '../version.ts';
import type { Command } from './commands.ts';
import { EXIT, type ExitCode } from './exit-codes.ts';
import type { CliOutput } from './run.ts';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function runScanCommand(
  command: Command,
  argv: readonly string[],
  out: CliOutput,
  options: ScanOptions = {},
): Promise<ExitCode> {
  const parsed = parseScanArgs(argv);

  if (!parsed.ok) {
    out.stderr(`${PROGRAM_NAME}: ${parsed.error}`);
    out.stderr(`Usage: ${command.usage}`);
    return EXIT.USAGE;
  }

  const { request } = parsed;

  try {
    const result = await runScan(request, options);
    const failed = result.meta.tools.filter((tool) => tool.status === 'failed');

    out.stdout(`${PROGRAM_NAME}: scanned ${request.url} (${request.mode})`);

    for (const artifact of result.artifacts) {
      out.stdout(`  ${result.outDir}/${artifact}`);
    }

    for (const axis of result.summary.byAxis) {
      // An axis with no probe has no findings, and no findings scores 100.
      // Printing that would report a browser that never started as a perfect
      // result, so a failed axis gets no number.
      if (axis.probe.status === 'failed') {
        out.stdout(`  ${axis.axis.padEnd(5)}   -/${axis.maxScore} (probe no disponible)`);
        continue;
      }

      const note = axis.zeroed ? ' (anulado por hallazgo bloqueante)' : '';
      out.stdout(
        `  ${axis.axis.padEnd(5)} ${String(axis.score).padStart(3)}/${axis.maxScore}${note}`,
      );
    }

    for (const tool of failed) {
      out.stderr(
        `${PROGRAM_NAME}: probe for ${tool.axis} failed: ${tool.error ?? 'unknown error'}`,
      );
    }

    return EXIT.OK;
  } catch (cause) {
    out.stderr(`${PROGRAM_NAME}: scan failed: ${messageOf(cause)}`);
    return EXIT.FAILED;
  }
}
