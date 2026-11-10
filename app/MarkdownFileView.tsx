'use client';
import { useMemo, useRef, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '@/lib/api';
import {
  MARKDOWN_COMPONENTS, MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS, MessageLink,
} from './Message';
import { remarkFilePaths } from './messageLinks';
import { hastText } from './hastText';
import { markdownSlug, resolveDocPath, rootedPath } from './fileViews';
import { useMarkdownMargins } from './markdownMargins';

type MarkdownProps = ComponentProps<typeof ReactMarkdown>;
type Components = NonNullable<MarkdownProps['components']>;
type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/**
 * A Markdown file rendered as a document (§14.111) — the chat's renderer
 * (highlighting, mermaid, tables, file links) with a document's addressing:
 * relative links and images resolve from the FILE's folder, links to files
 * open explorer tabs, `#anchors` scroll inside the view. It renders the
 * pane's buffer, so unsaved edits show too.
 */
export default function MarkdownFileView({ vpsId, root, path, text }: {
  vpsId: string; root: string; path: string; text: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [margins] = useMarkdownMargins();
  const absPath = `${root.replace(/\/+$/, '')}/${path}`;
  const docDir = absPath.slice(0, absPath.lastIndexOf('/')) || '/';
  // Repeated headings number themselves in document order: one map per render.
  const slugs = useRef(new Map<string, number>());
  slugs.current = new Map();

  const remarkPlugins = useMemo<NonNullable<MarkdownProps['remarkPlugins']>>(() => [
    ...MARKDOWN_REMARK_PLUGINS,
    [remarkFilePaths, { accept: (href: string) => resolveDocPath(docDir, href) != null }],
  ], [docDir]);

  const components = useMemo<Components>(() => {
    const heading = (Tag: HeadingTag) => function Heading(
      { node, children, ...props }: ComponentProps<HeadingTag> & { node?: unknown; children?: ReactNode },
    ) {
      return <Tag {...props} data-slug={markdownSlug(hastText(node), slugs.current)}>{children}</Tag>;
    };
    return {
      ...MARKDOWN_COMPONENTS,
      h1: heading('h1'), h2: heading('h2'), h3: heading('h3'),
      h4: heading('h4'), h5: heading('h5'), h6: heading('h6'),
      a: ({ node: _node, href, ...props }) => {
        if (href?.startsWith('#')) {
          return <a {...props} href={href} onClick={(event) => {
            event.preventDefault();
            let slug = href.slice(1);
            try { slug = decodeURIComponent(slug); } catch { /* keep it raw */ }
            scroller.current?.querySelector(`[data-slug="${CSS.escape(slug)}"]`)
              ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }} />;
        }
        const abs = href ? resolveDocPath(docDir, href) : null;
        return <MessageLink {...props} href={abs ?? href} vpsId={vpsId} cwd={root} />;
      },
      img: ({ node: _node, src, alt, ...props }) => {
        const abs = typeof src === 'string' ? resolveDocPath(docDir, src) : null;
        let url = src;
        if (abs) {
          const at = rootedPath(root, abs.split('#', 1)[0]);
          url = api.fsFileUrl(vpsId, at.root, at.path, { inline: true });
        }
        // eslint-disable-next-line @next/next/no-img-element
        return <img {...props} src={url} alt={alt ?? ''} loading="lazy" />;
      },
    };
  }, [vpsId, root, docDir]);

  return (
    <div className="md-doc-scroll" ref={scroller}>
      <article className={`md-doc${margins ? ' margins' : ''}`}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={components}>
          {text}
        </ReactMarkdown>
      </article>
    </div>
  );
}
