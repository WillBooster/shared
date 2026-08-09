/** Whether a Dockerfile consumes wb's generated non-secret environment directly or through its helper. */
export function consumesDockerEnv(dockerfileText: string): boolean {
  return dockerfileText
    .split('\n')
    .some((line) => !/^\s*#/u.test(line) && (line.includes('.docker.env') || line.includes('apply-docker-env.sh')));
}
