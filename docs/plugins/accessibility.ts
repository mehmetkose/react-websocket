interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const hasClass = (node: HastNode | undefined, name: string) => {
  const className = node?.properties?.className ?? node?.properties?.class;
  const classes = Array.isArray(className)
    ? className
    : typeof className === 'string'
      ? className.split(' ')
      : [];
  return classes.includes(name);
};

/**
 * Fixes markup that Rspress generates from Markdown and that misleads assistive technology and AI
 * agents. Runs after Rspress's own rehype plugins.
 *
 * - Heading anchors: Rspress puts a "#" link inside every heading, with aria-hidden so it isn't
 *   read as part of the heading, but leaves it in the tab order, so keyboard users land on a link
 *   that assistive technology can't see. It's taken out of the tab order. It stays a mouse
 *   affordance, and the "On this page" outline links to every heading.
 * - Task lists: each `- [ ]` item starts with a disabled checkbox that has no label. In the docs
 *   they're decoration nobody can tick, so they're hidden and the item's text is read on its own.
 */
export function rehypeAccessibility() {
  return (tree: HastNode) => {
    const visit = (node: HastNode, parent?: HastNode) => {
      if (node.tagName === 'a' && hasClass(node, 'rp-header-anchor')) {
        node.properties = { ...node.properties, tabIndex: -1 };
      }
      if (
        node.tagName === 'input' &&
        node.properties?.type === 'checkbox' &&
        hasClass(parent, 'task-list-item')
      ) {
        node.properties = { ...node.properties, ariaHidden: 'true' };
      }
      node.children?.forEach(child => visit(child, node));
    };
    visit(tree);
  };
}
