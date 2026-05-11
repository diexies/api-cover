import { useEffect, useMemo, useRef, useState } from 'react';
import { type GitCommit, type GitCommitDetail, getGitCommit, getGitLog } from '../api';

interface GitTimelineProps {
  /** Forward an AI prompt + mode hint to the agent panel. Used by the "sync with
   *  AI" button on a commit's detail panel. Optional so the timeline can render
   *  in shells that don't host the agent. */
  onSendPrompt?: (text: string, mode?: string | null) => void;
}

/**
 * Horizontal commit timeline rendered under "available commands" on home.
 * Each node is one commit. Color split: traced (commit dated <= last scenario
 * update) vs untraced (dated after) — the visual goal is "from which commit
 * onwards we haven't produced scenarios". Click a node to expand a detail
 * panel showing files changed + per-file unified diff. The detail panel
 * exposes a "sync with AI" button that hands the agent a structured prompt
 * to author / refresh scenarios for the commit.
 */
export function GitTimeline({ onSendPrompt }: GitTimelineProps = {}) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<GitCommit | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Track whether we've already fired the on-load auto-open so a user who
  // manually closes the panel doesn't get it re-opened on every render.
  const didAutoOpen = useRef(false);

  useEffect(() => {
    let alive = true;
    getGitLog(100)
      .then((r) => {
        if (!alive) return;
        setCommits(r.commits);
        // Auto-open the most recent commit so the page lands with a populated
        // detail view instead of a bare timeline.
        if (!didAutoOpen.current && r.commits.length > 0) {
          didAutoOpen.current = true;
          setSelected(r.commits[0]);
        }
      })
      .catch(() => { if (alive) setCommits([]); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!selected) { setDetail(null); setDetailError(null); return; }
    let alive = true;
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    getGitCommit(selected.sha)
      .then((d) => {
        if (!alive) return;
        if (d) setDetail(d);
        else setDetailError('Commit not found.');
      })
      .catch((e: Error) => { if (alive) setDetailError(e.message); })
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [selected]);

  // Group consecutive commits by year-month so the track reads as a calendar
  // ledger ("May 26 · Apr 26 · Mar 26"). Newest month first since ordering
  // is newest-leftmost. Hook MUST sit before any early-return below — React
  // requires the same hook order on every render.
  const monthGroups = useMemo(() => {
    const groups: { key: string; label: string; commits: GitCommit[] }[] = [];
    for (const c of commits ?? []) {
      const d = new Date(c.date);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const last = groups[groups.length - 1];
      if (!last || last.key !== key) {
        groups.push({
          key,
          label: d.toLocaleString('en', { month: 'short', year: '2-digit' }),
          commits: [c],
        });
      } else {
        last.commits.push(c);
      }
    }
    return groups;
  }, [commits]);

  if (commits === null) return null;
  if (commits.length === 0) return null;

  const ordered = commits;
  const firstTracedIdx = ordered.findIndex((c) => c.traced);

  return (
    <section className="git-timeline" aria-label="commit history">
      <div className="git-timeline-track" role="list">
        {monthGroups.map((g) => (
          <div key={g.key} className="git-timeline-group" role="presentation">
            <div className="git-timeline-group-label">{g.label}</div>
            <div className="git-timeline-group-row">
              <span className="git-timeline-line" aria-hidden="true" />
              {g.commits.map((c) => {
                const idx = ordered.indexOf(c);
                const isFrontier = idx === firstTracedIdx;
                const isSelected = selected?.sha === c.sha;
                return (
                  <button
                    key={c.sha}
                    type="button"
                    role="listitem"
                    className={`git-timeline-node${c.traced ? ' is-traced' : ' is-untraced'}${isFrontier ? ' is-frontier' : ''}${hovered === c.sha ? ' is-hovered' : ''}${isSelected ? ' is-selected' : ''}`}
                    title={`${c.shortSha} · ${c.subject} · ${c.author}`}
                    onMouseEnter={() => setHovered(c.sha)}
                    onMouseLeave={() => setHovered((h) => (h === c.sha ? null : h))}
                    onFocus={() => setHovered(c.sha)}
                    onBlur={() => setHovered((h) => (h === c.sha ? null : h))}
                    onClick={() => setSelected(isSelected ? null : c)}
                    aria-pressed={isSelected}
                  >
                    <span className="git-timeline-node-dot" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="git-timeline-meta" aria-live="polite">
        <div className="git-timeline-meta-left">
          {hovered ? (() => {
            const c = ordered.find((x) => x.sha === hovered);
            if (!c) return null;
            return (
              <>
                <code className="git-timeline-sha">{c.shortSha}</code>
                <span className="git-timeline-subject">{c.subject}</span>
                <span className="git-timeline-author muted small">{c.author} · {formatRelative(c.date)}</span>
                <span className={`git-timeline-tag is-${c.traced ? 'traced' : 'untraced'}`}>
                  {c.traced ? 'covered by scenarios' : 'no scenario yet'}
                </span>
              </>
            );
          })() : (
            firstTracedIdx > 0 ? (
              <span className="muted small">
                {firstTracedIdx} commit{firstTracedIdx === 1 ? '' : 's'} since last scenario refresh — click any node for diff.
              </span>
            ) : firstTracedIdx === -1 ? (
              <span className="muted small">No scenarios yet — every commit is uncovered. Click any node for diff.</span>
            ) : (
              <span className="muted small">All visible commits are reflected in current scenarios. Click any node for diff.</span>
            )
          )}
        </div>
        {onSendPrompt && selected && detail && (
          <button
            type="button"
            className="git-timeline-sync"
            onClick={() => onSendPrompt(buildSyncPrompt(selected, detail), 'scenario')}
            title={`Send commit ${selected.shortSha} to the AI agent to author or refresh scenarios`}
          >
            <span aria-hidden="true">✦</span> sync <code>{selected.shortSha}</code> with AI
          </button>
        )}
      </div>

      {selected && (
        <CommitDetailPanel
          commit={selected}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function CommitDetailPanel({
  commit,
  detail,
  loading,
  error,
  onClose,
}: {
  commit: GitCommit;
  detail: GitCommitDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  // Detail panel renders collapsed by default. User clicks the SHA row to
  // expand the body + diff. Re-collapses on the same click. Selecting a
  // different commit from the timeline resets to collapsed.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); setOpenFile(null); }, [commit.sha]);

  const totalAdds = detail?.files.reduce((s, f) => s + f.additions, 0) ?? 0;
  const totalDels = detail?.files.reduce((s, f) => s + f.deletions, 0) ?? 0;

  return (
    <div className={`git-detail${expanded ? ' is-expanded' : ''}`} role="region" aria-label="commit detail">
      <div className="git-detail-head">
        <button
          type="button"
          className="git-detail-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'collapse commit message' : 'expand commit message'}
          title={expanded ? 'hide commit message' : 'show commit message'}
        >
          <span className="git-detail-caret" aria-hidden="true">{expanded ? '▴' : '▾'}</span>
          <code className="git-timeline-sha">{commit.shortSha}</code>
          <span className="git-detail-subject">{commit.subject}</span>
          <span className="git-detail-author muted small">{commit.author} · {formatRelative(commit.date)}</span>
        </button>
        {detail && (
          <span className="git-detail-stats" aria-label="diff stats">
            <span className="git-detail-files">{detail.files.length} file{detail.files.length === 1 ? '' : 's'}</span>
            <span className="git-detail-adds">+{totalAdds}</span>
            <span className="git-detail-dels">−{totalDels}</span>
          </span>
        )}
        <button
          type="button"
          className="git-detail-close"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label="close"
        >×</button>
      </div>

      {expanded && detail && detail.body && (
        <pre className="git-detail-body">{detail.body}</pre>
      )}

      {loading && <div className="git-detail-status muted small">Loading diff…</div>}
      {error && <div className="git-detail-status git-detail-error">{error}</div>}

      {detail && detail.files.length > 0 && (
        <ul className="git-detail-files-list">
          {detail.files.map((f) => (
            <li key={f.path} className={`git-detail-file${openFile === f.path ? ' is-open' : ''}`}>
              <button
                type="button"
                className="git-detail-file-row"
                onClick={() => setOpenFile((cur) => cur === f.path ? null : f.path)}
                aria-expanded={openFile === f.path}
              >
                <span className={`git-detail-file-status status-${f.status.toLowerCase()}`} title={statusLabel(f.status)}>
                  {f.status}
                </span>
                <span className="git-detail-file-path">{f.path}</span>
                <span className="git-detail-file-numstat">
                  <span className="git-detail-adds">+{f.additions}</span>
                  <span className="git-detail-dels">−{f.deletions}</span>
                </span>
                <span className="git-detail-file-caret" aria-hidden="true">{openFile === f.path ? '▾' : '▸'}</span>
              </button>
              {openFile === f.path && f.patch && (
                <DiffView patch={f.patch} />
              )}
              {openFile === f.path && !f.patch && (
                <div className="git-detail-status muted small">No patch (binary or empty).</div>
              )}
            </li>
          ))}
        </ul>
      )}

      {detail && detail.files.length === 0 && !loading && (
        <div className="git-detail-status muted small">No file changes.</div>
      )}
    </div>
  );
}

function DiffView({ patch }: { patch: string }) {
  // Strip the leading `diff --git`, `index`, `---`, `+++` housekeeping so the
  // viewer focuses on hunks. Keep `@@` separators for readability.
  const lines = patch.split('\n');
  return (
    <pre className="git-detail-diff" aria-label="unified diff">
      {lines.map((line, i) => {
        if (
          line.startsWith('diff --git') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ') ||
          line.startsWith('new file mode') ||
          line.startsWith('deleted file mode') ||
          line.startsWith('similarity index') ||
          line.startsWith('rename from') ||
          line.startsWith('rename to')
        ) return null;
        const tone =
          line.startsWith('@@') ? 'hunk' :
          line.startsWith('+')  ? 'add'  :
          line.startsWith('-')  ? 'del'  : 'ctx';
        return (
          <span key={i} className={`diff-line is-${tone}`}>{line}{'\n'}</span>
        );
      })}
    </pre>
  );
}

/**
 * Build a structured prompt that hands the agent enough context to (a) decide
 * which scenarios are missing for the new endpoints introduced by this commit
 * and (b) refresh existing scenarios whose endpoints changed shape. We send
 * subject, body, file list with numstat, and a truncated diff so the agent
 * can reason without re-reading the repo. Patch is capped per-file at 1.5 KB
 * so a multi-MB commit still fits in a single user turn.
 */
function buildSyncPrompt(c: GitCommit, d: GitCommitDetail): string {
  const lines: string[] = [];
  lines.push(`Analyze commit ${c.shortSha} ("${d.subject}") and update test scenarios.`);
  lines.push('');
  lines.push('Goal:');
  lines.push('- For new endpoints / behaviours introduced here: author new scenarios.');
  lines.push('- For modified endpoints: update existing scenarios so they reflect the new shape.');
  lines.push('- Skip files that are pure refactors with no behaviour change.');
  lines.push('');
  lines.push(`commit: ${d.sha}`);
  lines.push(`author: ${d.author} · ${d.date}`);
  if (d.body) {
    lines.push('message body:');
    lines.push(d.body.split('\n').map((l) => '  ' + l).join('\n'));
  }
  lines.push('');
  lines.push(`files (${d.files.length}):`);
  for (const f of d.files) {
    lines.push(`- [${f.status}] ${f.path} (+${f.additions} −${f.deletions})`);
  }
  lines.push('');
  lines.push('diff (truncated per file):');
  const PER_FILE_BUDGET = 1500;
  for (const f of d.files) {
    if (!f.patch) continue;
    const truncated = f.patch.length > PER_FILE_BUDGET
      ? f.patch.slice(0, PER_FILE_BUDGET) + '\n… (truncated)'
      : f.patch;
    lines.push(`### ${f.path}`);
    lines.push('```diff');
    lines.push(truncated);
    lines.push('```');
  }
  return lines.join('\n');
}

function statusLabel(s: string): string {
  switch (s.toUpperCase()) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'type changed';
    default:  return s;
  }
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
