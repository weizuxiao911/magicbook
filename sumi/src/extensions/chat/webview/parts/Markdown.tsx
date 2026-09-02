import React, { useEffect, useState } from 'react';
import { marked } from 'marked';
import { codeToHtml } from 'shiki';
import markedShiki from 'marked-shiki';

/**
 * Markdown 渲染 — 对齐官方 packages/web content-markdown.tsx 实现
 *
 * 管线:
 *   marked 7 + markedShiki 插件 (shiki codeToHtml 双主题高亮)
 *   - link 自动 target=_blank rel=noopener noreferrer
 *   - strip(): 剥离首尾 <tag>...</tag> wrapper (如 <text>)
 *   - 溢出折叠: 默认 3 行截断 (line-clamp) + "显示更多/收起" 按钮
 *   - 右上角复制按钮
 */

const markedWithShiki = marked.use(
  {
    renderer: {
      link({ href, title, text }: any) {
        const titleAttr = title ? ` title="${title}"` : '';
        return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
    },
  },
  markedShiki({
    highlight(code: string, lang: string) {
      return codeToHtml(code, {
        lang: lang || 'text',
        themes: {
          light: 'github-light',
          dark: 'github-dark',
        },
      });
    },
  }),
);

function strip(text: string): string {
  const wrappedRe = /^\s*<([A-Za-z]\w*)>\s*([\s\S]*?)\s*<\/\1>\s*$/;
  const match = text.match(wrappedRe);
  return match ? match[2] : text;
}

export const Markdown: React.FC<{ content: string; streaming?: boolean; expand?: boolean }> = ({
  content,
  streaming,
}) => {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(markedWithShiki.parse(strip(content || '')))
      .then((h: string) => { if (!cancelled) setHtml(h); })
      .catch(() => { if (!cancelled) setHtml(String(content || '')); });
    return () => { cancelled = true; };
  }, [content]);

  return (
    <div className={`chat-md${streaming ? ' chat-md--streaming' : ''}`}>
      <div className="chat-md__body" dangerouslySetInnerHTML={{ __html: html }} />
      <style>{`
        .chat-md { position: relative; }
        .chat-md__body {
          font-size: 13px;
          line-height: 1.6;
          color: var(--editor-foreground, var(--vscode-editor-foreground));
          word-break: break-word;
        }
        .chat-md__body p, .chat-md__body blockquote, .chat-md__body ul, .chat-md__body ol,
        .chat-md__body dl, .chat-md__body table, .chat-md__body pre { margin-bottom: 0.75rem; }
        .chat-md__body ul, .chat-md__body ol { padding-left: 1.4rem; margin-bottom: 0.5rem; }
        .chat-md__body ol > li { margin-bottom: 0.35rem; }
        .chat-md__body li ul, .chat-md__body li ol { margin-top: 0.2rem; margin-bottom: 0; }
        .chat-md__body h1, .chat-md__body h2, .chat-md__body h3, .chat-md__body h4,
        .chat-md__body h5, .chat-md__body h6 {
          font-size: 1em; font-weight: 600; margin-bottom: 0.5rem;
          color: var(--editor-foreground, var(--vscode-editor-foreground)) !important;
        }
        .chat-md__body > *:last-child { margin-bottom: 0; }
        .chat-md__body pre {
          --shiki-dark-bg: var(--editor-background, var(--vscode-editor-background)) !important;
          background: var(--editor-background, var(--vscode-editor-background)) !important;
          color: var(--editor-foreground, var(--vscode-editor-foreground));
          border: 1px solid var(--panel-border, var(--vscode-panel-border, rgba(255,255,255,0.06)));
          border-radius: 8px;
          padding: 0.6rem 0.75rem;
          line-height: 1.6;
          font-size: 12px;
          white-space: pre-wrap;
          word-break: break-word;
          overflow-x: auto;
        }
        .design-dark .chat-md__body pre,
        .design-dark .chat-md__body pre span {
          color: var(--shiki-dark) !important;
          background-color: var(--shiki-dark-bg) !important;
        }
        .chat-md__body code { font-weight: 500; }
        .chat-md__body :not(pre) > code {
          background: var(--textCodeBlock-background, rgba(255,255,255,0.07));
          border-radius: 4px;
          padding: 1px 5px;
          font-size: 0.92em;
        }
        .chat-md__body table { border-collapse: collapse; width: 100%; }
        .chat-md__body th, .chat-md__body td {
          border: 1px solid var(--panel-border, var(--vscode-panel-border, rgba(255,255,255,0.08)));
          padding: 0.4rem 0.6rem;
          text-align: left;
        }
        .chat-md__body th { border-bottom: 1px solid var(--panel-border, var(--vscode-panel-border, rgba(255,255,255,0.12))); font-weight: 600; }
        .chat-md__body blockquote {
          border-left: 3px solid var(--panel-border, var(--vscode-panel-border, rgba(255,255,255,0.15)));
          padding-left: 0.75rem;
          color: var(--descriptionForeground, var(--vscode-descriptionForeground));
        }
        .chat-md__body a { color: var(--textLink-foreground, var(--vscode-textLink-foreground, var(--button-background))); text-decoration: none; }
        .chat-md__body a:hover { text-decoration: underline; }
      `}</style>
    </div>
  );
};
