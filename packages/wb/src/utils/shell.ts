export function buildShellCommand(args: string[]): string {
  return args.map((arg) => shellEscapeArgument(arg)).join(' ');
}

export function buildShellEnvironmentAssignment(name: string, value: string): string {
  return `${name}=${shellEscapeArgument(value)}`;
}

export function shellEscapeArgument(arg: string): string {
  return /^[\w./:=,@%+-]+$/u.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`;
}
