'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Vps } from '@/lib/db/schema';
import type { AccountProfile } from '@/lib/accountProfiles';
import type { AgentKind } from '@/lib/types/api';
import { api } from '@/lib/api';
import { providerName } from '@/lib/providerText';
import { refreshAccountProfiles } from './accountProfileStore';
import AgentLogo from './AgentLogo';

export default function AccountProfileModal({ vps, provider, profile, onClose, onCreated }: {
  vps: Vps; provider: AgentKind; profile?: AccountProfile;
  onClose: () => void; onCreated: (profile: AccountProfile) => void;
}) {
  const [name, setName] = useState(profile?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  async function save() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (profile) {
        await api.renameAccountProfile(profile, name.trim());
        await refreshAccountProfiles(); onClose();
      } else {
        const response = await api.createAccountProfile(vps.id, provider, name.trim());
        await refreshAccountProfiles(); onCreated(response.profile);
      }
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return createPortal(<div className="app-modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <form className="app-modal account-profile-modal" role="dialog" aria-modal="true" aria-labelledby="account-profile-title"
      onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="fork-head"><h2 id="account-profile-title"><AgentLogo kind={provider} profileNumber={profile?.number} size={22} /> {profile ? 'Name account' : `Add ${providerName(provider)} account`}</h2>
        <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>×</button></div>
      <p className="fork-note">{vps.name} · {profile ? 'Give this account a name to recognize it.' : 'This account has its own login and history on this VPS. Settings, skills and plugins are shared with the first account.'}</p>
      <label className="nw-field"><span>Name <small>(optional)</small></span><input autoFocus value={name} maxLength={80}
        placeholder="e.g. Work" onChange={(e) => setName(e.target.value)} disabled={busy} /></label>
      {error && <p className="confirm-err" role="alert">{error}</p>}
      <div className="account-profile-actions"><button type="button" className="wiz-btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="wiz-btn primary" disabled={busy}>{busy ? 'Preparing…' : profile ? 'Save' : 'Continue to login'}</button></div>
    </form>
  </div>, document.body);
}
