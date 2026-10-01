import * as jsYaml from 'js-yaml';
import { isMap, isNode, isScalar, isSeq, Pair, parseDocument } from 'yaml';
import type { Node, YAMLMap } from 'yaml';

/**
 * Serializes `value` as the YAML text that replaces `oldContent`. The nodes of `oldContent` that `value` keeps keep
 * their comments and formatting as written (e.g. a bare `workflow_dispatch:`); new and changed values are written as
 * `js-yaml` dumps them, which is also the whole output when `oldContent` is absent or not a parsable mapping.
 */
export function dumpYamlOver(oldContent: string | undefined, value: object): string {
  const document = parseDocument(oldContent ?? '');
  if (document.errors.length > 0 || !isMap(document.contents)) return dumpYaml(value);

  // updateNode updates a mapping in place when the value is an object.
  updateNode(document.contents, value);
  // Folding at a line width would split long values that `js-yaml` writes on one line.
  return document.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

function dumpYaml(value: unknown): string {
  return jsYaml.dump(value, { lineWidth: -1 });
}

function updateNode(node: unknown, value: unknown): Node {
  if (isMap(node) && isPlainObject(value)) {
    moveLeadingCommentToFirstKey(node);
    // js-yaml omits undefined properties.
    node.items = Object.entries(value)
      .filter(([, itemValue]) => itemValue !== undefined)
      .map(([key, itemValue]) => {
        const pair = node.items.find((item) => isScalar(item.key) && item.key.value === key);
        if (!pair) return new Pair(createNode(key), createNode(itemValue));
        pair.value = updateNode(pair.value, itemValue);
        return pair;
      });
    return node;
  }
  if (isSeq(node) && Array.isArray(value)) {
    node.items = value.map((itemValue, index) => updateNode(node.items[index], itemValue));
    return node;
  }
  if (isScalar(node) && node.value === value) return node;

  const newNode = createNode(value);
  if (isNode(node)) {
    newNode.commentBefore = node.commentBefore;
    newNode.comment = node.comment;
    newNode.spaceBefore = node.spaceBefore;
  }
  return newNode;
}

/**
 * `yaml` attaches the comment above the first entry of a nested mapping to the mapping, where it would stay when that
 * entry is removed.
 */
function moveLeadingCommentToFirstKey(node: YAMLMap): void {
  const target = node.items[0]?.key;
  if (!node.commentBefore || !isNode(target)) return;
  target.commentBefore = target.commentBefore ? `${node.commentBefore}\n${target.commentBefore}` : node.commentBefore;
  node.commentBefore = undefined;
}

function createNode(value: unknown): Node {
  const contents = parseDocument(dumpYaml(value)).contents;
  if (!isNode(contents)) throw new Error(`js-yaml dumped no YAML node for ${JSON.stringify(value)}.`);
  return contents;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
