import { useState } from 'react';
export function PollStreamField({ value, onChange, slug, disabled = false }: { value: string; onChange: (value: string) => void; slug?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<Array<{ url: string; title: string }>>([]);
  const [message, setMessage] = useState('');
  async function detect() {
    if (!slug || busy) return;
    setBusy(true); setMessage(''); setItems([]);
    try {
      const response = await fetch(`/api/admin/polls/${encodeURIComponent(slug)}/stream-links`, { credentials: 'include', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Stream detection is unavailable.');
      setItems(data.items || []); setMessage(data.message || '');
      if (data.items?.length === 1) onChange(data.items[0].url);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Stream detection is unavailable.'); }
    finally { setBusy(false); }
  }
  return <div className="poll-stream-field">
    <label>Rumble stream link (optional)<input type="url" maxLength={2000} placeholder="https://rumble.com/v..." value={value} disabled={disabled || busy} onChange={event => onChange(event.target.value)} /></label>
    <div><button type="button" disabled={disabled || busy || !slug} onClick={() => void detect()}>{busy ? 'Detecting streams...' : 'Detect from votes'}</button>{value ? <button type="button" disabled={disabled || busy} onClick={() => onChange('')}>Clear link</button> : null}</div>
    {items.length > 1 ? <label>Detected streams<select value={items.some(item => item.url === value) ? value : ''} disabled={disabled || busy} onChange={event => onChange(event.target.value)}><option value="">Choose a stream</option>{items.map(item => <option key={item.url} value={item.url}>{item.title}</option>)}</select></label> : null}
    <small>{slug ? 'Enter a link yourself or detect it from recorded Rumble votes. Save to apply.' : 'Enter a link now, or save this Poll first to detect a stream from votes.'}</small>
    {message ? <p role="status">{message}</p> : null}
  </div>;
}
