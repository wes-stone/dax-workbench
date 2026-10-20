import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { ElementContent } from "hast";
import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import { useResearchPresentation } from "./artifact-embeds";
import { markdownArtifactId, markdownUrl } from "./markdown-policy";
import { formatResearchDecimal, remarkResearchNumbers } from "./research-numbers";
import { remarkReadableParagraphs } from "./documentation-model";
import { remarkResearchTables } from "./research-tables";
import { remarkDocumentationTables } from "./documentation-tables";
import "./research-presentation.css";
export { ResearchPresentationProvider, type ResearchPresentation } from "./artifact-embeds";

export function NumericValue({ value }: { value: string }) {
  const { numbers } = useResearchPresentation();
  const formatted = numbers === "readable" ? formatResearchDecimal(value) : null;
  if (formatted === null) return <>{value}</>;
  return <span className="research-number" tabIndex={0} role="note"
    title={`Exact value: ${value}`} aria-label={`${formatted}. Exact value: ${value}`}>{formatted}</span>;
}

function MarkdownImage({ src, alt = "", managed = false }: { src?: string; alt?: string; managed?: boolean }) {
  const { renderArtifact } = useResearchPresentation();
  const rendered = managed && src && markdownArtifactId(src) && renderArtifact ? renderArtifact(src, alt) : null;
  return rendered ?? <span className="markdown-image-alt" title="Images are not loaded in research previews.">[Image{alt ? `: ${alt}` : " omitted"}]</span>;
}

function remarkManagedArtifacts() {
  return (tree: Root) => {
    function walk(node: Nodes): void {
      if (!("children" in node)) return;
      for (const child of node.children) {
        // Block renderers are safe directly in a paragraph replaced by our div,
        // not inside phrasing-only wrappers, links, headings or table cells.
        if (node.type === "paragraph" && (child.type === "image" || child.type === "imageReference")) {
          child.data = { ...child.data, hProperties: { ...child.data?.hProperties, "data-managed-artifact": true } };
        }
        walk(child);
      }
    }
    walk(tree);
  };
}

function isManagedImage(node: ElementContent): boolean {
  return node.type === "element" && node.tagName === "img" && node.properties["data-managed-artifact"] === true
    && typeof node.properties.src === "string" && markdownArtifactId(node.properties.src) !== null;
}

const plugins = [remarkGfm, remarkManagedArtifacts];
const readablePlugins = [remarkGfm, remarkManagedArtifacts, remarkResearchNumbers];
const spacedPlugins = [remarkGfm, remarkManagedArtifacts, remarkDocumentationTables, remarkResearchTables, remarkReadableParagraphs];
const spacedReadablePlugins = [remarkGfm, remarkManagedArtifacts, remarkDocumentationTables, remarkResearchTables, remarkReadableParagraphs, remarkResearchNumbers];
const elements = ["a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "img", "input", "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul"];
const components: Components = {
  a: ({ href, title, children }) => href
    ? <a href={href} title={title} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a>
    : <span title="Link unavailable: only explicit web and email destinations are supported.">{children}</span>,
  img: ({ src, alt, node }) => <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt}
    managed={node?.properties["data-managed-artifact"] === true}/>,
  p: ({ node, children, className }) => node?.children.some(isManagedImage)
    ? <div className="research-embed-paragraph">{children}</div>
    : <p className={className}>{children}</p>,
  span: ({ node, children }) => {
    const exact = node?.properties["data-research-number"];
    return typeof exact === "string" ? <NumericValue value={exact}/> : <span>{children}</span>;
  },
  input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} disabled readOnly aria-label={checked ? "Completed task" : "Incomplete task"}/>,
  table: ({ children, node }) => {
    const movements = node?.properties["data-research-table"] === "movement-watchlist";
    const documented = node?.properties["data-documentation-table"];
    const metadata = documented === "filters" || documented === "scope";
    const caption = documented === "filters" ? "Filters" : "Scope";
    return <div className={`markdown-table-scroll${movements ? " research-movement-table" : ""}${metadata ? ` documentation-${documented}-table` : ""}`} role="region"
      aria-label={movements ? "Reported movements" : metadata ? `Documented ${documented}` : "Markdown table"} tabIndex={0}>
      <table>{movements && <caption>Reported movements</caption>}
        {metadata && <caption>{caption}<span>As documented · not query-verified</span></caption>}{children}</table>
      {movements && <p className="research-table-note">Layout only; values and changes are as recorded. “Not supplied” means no before/after value was given. “Blank” is the source label, not zero.</p>}
    </div>;
  },
};

export const MarkdownPreview = memo(function MarkdownPreview({ text, readableParagraphs = false }: { text: string; readableParagraphs?: boolean }) {
  const { numbers } = useResearchPresentation();
  const selectedPlugins = readableParagraphs ? numbers === "readable" ? spacedReadablePlugins : spacedPlugins : numbers === "readable" ? readablePlugins : plugins;
  return <div className="library-documentation library-markdown">
    <ReactMarkdown remarkPlugins={selectedPlugins} components={components} allowedElements={elements}
      urlTransform={(url, key, node) => key === "src" && node.tagName === "img" && markdownArtifactId(url) ? url : markdownUrl(url)}>{text}</ReactMarkdown>
  </div>;
});
