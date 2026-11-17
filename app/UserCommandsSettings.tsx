// Settings › commands: the user's own `/` commands (§14.121) — a name, what
// it is for, and the prompt it expands to. Each one saves on its own.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { UserCommand } from '@/lib/types/api';
import { IconPencil, IconPlusSquare, IconTrash } from './icons';
import { setUserCommands, useUserCommands } from './userCommandsStore';
import { SESSION_PROVIDERS } from '@/lib/sessionCapabilities';
import { providerName } from '@/lib/providerText';

const NAMES = SESSION_PROVIDERS.map(providerName);
const ANY_PROVIDER = NAMES.length > 1 ? `${NAMES.slice(0, -1).join(', ')} or ${NAMES.at(-1)}` : NAMES.join('');

type Form = { id: string | null; name: string; description: string; prompt: string };

const EXAMPLE = 'Review $ARGUMENTS for security issues: injection, auth, secrets in code. List findings by severity with file:line.';

export default function UserCommandsSettings() {
  const commands = useUserCommands();
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listUserCommands()
      .then((r) => setUserCommands(r.commands))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoaded(true));
  }, []);

  async function act(label: string, run: () => Promise<{ commands: UserCommand[] }>) {
    setBusy(label); setError(null);
    try {
      setUserCommands((await run()).commands);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally { setBusy(null); }
  }

  async function save() {
    if (!form) return;
    const input = { name: form.name, description: form.description, prompt: form.prompt };
    const ok = await act('save', () => (form.id ? api.updateUserCommand(form.id, input) : api.createUserCommand(input)));
    if (ok) setForm(null);
  }

  const editor = form && (
    <div className="uc-form" role="group" aria-label={form.id ? `Edit /${form.name}` : 'New command'}>
      <label className="uc-name">name
        <span className="uc-name-field"><span aria-hidden>/</span>
          <input value={form.name} autoFocus={!form.id} spellCheck={false} autoCapitalize="off" autoCorrect="off"
            placeholder="security-check" maxLength={40}
            onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/^\//, '') })} />
        </span>
      </label>
      <label>what it does <span className="set-meta">(shown in the menu)</span>
        <input value={form.description} maxLength={200} placeholder="Security review of a file or folder"
          onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </label>
      <label>prompt
        <textarea value={form.prompt} rows={6} placeholder={EXAMPLE}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
      </label>
      <p className="set-meta"><code>$ARGUMENTS</code> takes what you type after the name; without it, that text is added at the end.</p>
      <div className="uc-form-actions">
        <button type="button" className="endpoint-btn" onClick={() => { setForm(null); setError(null); }} disabled={!!busy}>Cancel</button>
        <button type="button" className="endpoint-btn is-primary" onClick={() => void save()}
          disabled={!!busy || !form.name.trim() || !form.prompt.trim()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );

  return (
    <section className="uc-settings" aria-label="Your commands">
      <div className="endpoint-settings-head">
        <div>
          <h3>Your commands <span className="endpoint-count">{commands.length}</span></h3>
          <p className="set-hint">Prompts you call by typing <code>/name</code> in any session — {ANY_PROVIDER}, on every server and device.</p>
        </div>
        <button type="button" className="endpoint-btn is-primary" disabled={!!busy || !!form}
          onClick={() => { setError(null); setForm({ id: null, name: '', description: '', prompt: '' }); }}>
          <IconPlusSquare />Add command
        </button>
      </div>
      {error && <p className="uc-error" role="alert">{error}</p>}
      {form && !form.id && editor}
      {!loaded ? <p className="set-meta" role="status">Loading…</p>
        : !commands.length && !form ? (
          <div className="uc-empty">
            <strong>No command yet</strong>
            <p>Save a prompt you type often, then call it with <code>/its-name</code> and what changes each time.</p>
          </div>
        ) : (
          <div className="uc-list">
            {commands.map((c) => (form?.id === c.id ? <div key={c.id}>{editor}</div> : (
              <article className="uc-card" key={c.id} aria-label={`/${c.name}`} aria-busy={busy === c.id}>
                <div className="uc-card-text">
                  <strong>/{c.name}</strong>
                  {c.description && <span>{c.description}</span>}
                  <p>{c.prompt}</p>
                </div>
                <div className="uc-card-actions">
                  <button type="button" className="endpoint-btn is-icon" aria-label={`Edit /${c.name}`} title="Edit"
                    disabled={!!busy || !!form}
                    onClick={() => { setError(null); setForm({ id: c.id, name: c.name, description: c.description, prompt: c.prompt }); }}>
                    <IconPencil />
                  </button>
                  <button type="button" className="endpoint-btn is-icon is-danger" aria-label={`Delete /${c.name}`} title="Delete"
                    disabled={!!busy || !!form}
                    onClick={() => void act(c.id, () => api.deleteUserCommand(c.id))}>
                    <IconTrash />
                  </button>
                </div>
              </article>
            )))}
          </div>
        )}
    </section>
  );
}
