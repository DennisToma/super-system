import { useState } from 'react';
import { File, FileText, FolderOpen, Info, RefreshCw, Search } from 'lucide-react';
import type { AgentFile } from '@super-system/core';
import { useWorkspace } from '../context';
import { usePaged } from '../hooks';
import { segment } from '../api';
import { Badge, Button, CapabilityNotice, dateTime, EmptyState, ErrorNotice, Loading, LoadMore, PageHeader, SearchField } from '../ui';

const sizeLabel = (bytes?: number) => bytes === undefined ? '—' : bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
export function Files() {
  const { agent, connection, preferences } = useWorkspace();
  const [search, setSearch] = useState('');
  const supported = connection.capabilities.files.state === 'supported';
  const files = usePaged<AgentFile>(agent && supported ? `/agents/${segment(agent.id)}/files` : null);
  const filtered = files.items.filter(file => `${file.name} ${file.source} ${file.path || ''}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="page files-page"><PageHeader eyebrow="Knowledge within reach" title="A place for the details." description="The documents and sources available to your agent." actions={supported && <Button busy={files.loading} onClick={files.refresh}><RefreshCw size={15} />Refresh files</Button>} />
    {!supported ? <section className="panel"><CapabilityNotice capability={connection.capabilities.files} icon={FolderOpen} title="Files begin with a connection" /></section> : !agent ? <EmptyState icon={FolderOpen} title="Choose an agent"><p>Select an agent to see its attached files.</p></EmptyState> : <section className="panel file-panel"><div className="section-heading"><div><h2>Attached files <span className="count-label">{files.items.length}{files.nextCursor ? '+' : ''}</span></h2><p>Files reported by your connected server.</p></div><SearchField value={search} onChange={setSearch} placeholder="Search loaded files…" /></div>{files.error && <ErrorNotice message={files.error} retry={files.refresh} />}{files.loading && !files.data ? <Loading label="Loading files…" /> : filtered.length ? <div className="table-scroll"><table className="file-table"><thead><tr><th>File name</th><th>Source</th><th>Context</th><th>Size</th><th>Added</th></tr></thead><tbody>{filtered.map(file => <tr key={file.id}><td><div className="file-name"><span className="file-icon"><FileText size={19} strokeWidth={1.5} /></span><div><strong>{file.name}</strong>{file.path && <span className="mono">{file.path}</span>}</div></div></td><td>{file.source || 'Not reported'}</td><td>{file.openInContext === true ? <Badge tone="good">In context</Badge> : file.openInContext === false ? <Badge>Attached</Badge> : <span className="muted">Not reported</span>}</td><td className="mono">{sizeLabel(file.size)}</td><td>{file.createdAt ? dateTime(file.createdAt, preferences.timezone) : '—'}</td></tr>)}</tbody></table></div> : <EmptyState icon={search ? Search : File} title={search ? 'No matching files' : 'No files attached yet'}><p>{search ? 'Search looks at files loaded so far. Load more files to search further.' : 'Sources attached to this agent in Letta will appear here.'}</p></EmptyState>}<LoadMore available={Boolean(files.nextCursor)} loading={files.moreLoading} onClick={files.loadMore} />{files.moreError && <ErrorNotice message={files.moreError} retry={files.loadMore} />}</section>}
    <div className="info-strip"><Info size={17} /><p>These are files available on your agent’s server. Your Mac’s files are not shared automatically. Manage attachments through your Letta server’s supported upload workflow.</p></div>
  </div>;
}
