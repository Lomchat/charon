'use client';
import { useState } from 'react';
import LabFrame from './LabFrame';
import NewSessionWizard from './NewSessionWizard';
import AddButtons from './AddButtons';
import { HistoryButton, AgentBar } from './VpsActions';
import { SessionCard, ShellCard } from './cards';
import { MOCK_SESSIONS, MOCK_SHELLS, MOCK_VPS, bucketByFolder, vpsNeedsAttention } from './mock';

type ModalTarget = { kind: 'agent' | 'shell'; vpsId?: string } | null;

// The approved V1 folder tree, factored out so the three separation
// explorations share identical markup/logic and differ ONLY by `sepClass`
// (a class on the <aside> that each vN.css styles).
export default function FolderTreeLab({
  variant, blurb, sepClass,
}: {
  variant: string;
  blurb: string;
  sepClass: string;
}) {
  const [modal, setModal] = useState<ModalTarget>(null);
  const [foldedFolders, setFoldedFolders] = useState<Set<string>>(new Set());
  const [foldedVps, setFoldedVps] = useState<Set<string>>(new Set());
  const tog = (set: React.Dispatch<React.SetStateAction<Set<string>>>) => (id: string) =>
    set((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const togFolder = tog(setFoldedFolders);
  const togVps = tog(setFoldedVps);

  const groups = MOCK_VPS
    .map((v) => ({
      vps: v,
      sessions: MOCK_SESSIONS.filter((s) => s.vpsId === v.id),
      shells: MOCK_SHELLS.filter((s) => s.vpsId === v.id),
    }))
    .filter((g) => g.sessions.length + g.shells.length > 0 || vpsNeedsAttention(g.vps));
  const buckets = bucketByFolder(groups);

  return (
    <>
      <LabFrame
        variant={variant}
        blurb={blurb}
        aside={
          <aside className={`claude-sidebar dl-side ${sepClass}`}>
            <div className="dl-top">
              <span className="dl-top-title">SESSIONS</span>
              <AddButtons size="md" full
                onAgent={() => setModal({ kind: 'agent' })}
                onShell={() => setModal({ kind: 'shell' })} />
            </div>

            {buckets.map(({ folder, groups }) => {
              const fFolded = foldedFolders.has(folder.id);
              return (
                <section key={folder.id} className="dl-folder">
                  <div className="dl-folder-head" onClick={() => togFolder(folder.id)} role="button">
                    <span className="dl-tcaret">{fFolded ? '▸' : '▾'}</span>
                    <span className="dl-folder-glyph">▤</span>
                    <span className="dl-folder-name">{folder.name}</span>
                    <span className="dl-vps-count">{groups.length}</span>
                  </div>
                  {!fFolded && (
                    <div className="dl-folder-body">
                      {groups.map(({ vps, sessions, shells }) => {
                        const vFolded = foldedVps.has(vps.id);
                        return (
                          <section key={vps.id} className="dl-vps-block">
                            <div className="dl-group-head">
                              <button className="dl-tcaret btn" onClick={() => togVps(vps.id)}>
                                {vFolded ? '▸' : '▾'}
                              </button>
                              <span className={`dl-vps-dot agent-${vps.agentStatus}`} />
                              <span className="dl-vps-id">
                                <span className="dl-vps-name">{vps.name}</span>
                                <span className="dl-vps-ip">{vps.ip}</span>
                              </span>
                              <HistoryButton />
                              <AddButtons size="sm" iconOnly
                                onAgent={() => setModal({ kind: 'agent', vpsId: vps.id })}
                                onShell={() => setModal({ kind: 'shell', vpsId: vps.id })} />
                            </div>
                            {!vFolded && (
                              <div className="dl-vps-body">
                                <AgentBar vps={vps} />
                                {sessions.map((s) => <SessionCard key={s.id} s={s} />)}
                                {shells.map((s) => <ShellCard key={s.id} s={s} />)}
                              </div>
                            )}
                          </section>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </aside>
        }
      />
      {modal && (
        <NewSessionWizard kind={modal.kind} initialVpsId={modal.vpsId} onClose={() => setModal(null)} />
      )}
    </>
  );
}
