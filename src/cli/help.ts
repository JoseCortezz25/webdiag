import { PROGRAM_NAME, VERSION } from '../version.ts';
import { COMMANDS } from './commands.ts';

const STATUS_TAG: Record<string, string> = {
  planned: '(not implemented yet)',
  available: '',
};

function commandLines(): string[] {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));

  return COMMANDS.map((command) => {
    const tag = STATUS_TAG[command.status] ?? '';
    const description = tag ? `${command.summary} ${tag}` : command.summary;
    return `  ${command.name.padEnd(width)}  ${description}`;
  });
}

export function renderHelp(): string {
  return [
    `${PROGRAM_NAME} ${VERSION} — automated technical diagnostics for websites`,
    '',
    'USAGE',
    `  ${PROGRAM_NAME} <command> [options]`,
    '',
    'COMMANDS',
    ...commandLines(),
    '',
    'OPTIONS',
    '  -h, --help     Show this help and exit',
    '  -v, --version  Show the version and exit',
    '',
    'EXAMPLES',
    ...COMMANDS.map((command) => `  ${command.usage}`),
    '',
    `Docs: https://github.com/JoseCortezz25/${PROGRAM_NAME}`,
  ].join('\n');
}

export function renderVersion(): string {
  return `${PROGRAM_NAME} ${VERSION}`;
}
