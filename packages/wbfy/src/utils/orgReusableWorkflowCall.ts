export function isSkippedReleaseCaller(repoAuthor: string | undefined, uses: string | undefined): boolean {
  if (repoAuthor !== 'WillBooster') return false;
  const call = parseOrgReusableWorkflowCall(uses);
  return call?.workflowName !== 'release' || call.ref !== 'main';
}

// GitHub treats owner/repository names case-insensitively, while workflow paths and refs are case-sensitive.
export function parseOrgReusableWorkflowCall(
  uses: string | undefined
): { workflowName: string; extension: string; ref: string } | undefined {
  const match = /^([^/]+)\/([^/]+)\/\.github\/workflows\/([^/@]+?)\.(ya?ml)@(.+)$/u.exec(uses ?? '');
  if (!match) return undefined;
  const owner = match[1]!.toLowerCase();
  if ((owner !== 'willbooster' && owner !== 'willboosterlab') || match[2]!.toLowerCase() !== 'reusable-workflows') {
    return undefined;
  }
  return { workflowName: match[3]!, extension: match[4]!, ref: match[5]! };
}
