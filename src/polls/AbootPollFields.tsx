export function AbootPollFields({ title, options, onTitle, onTrigger, locked = false }: { title: string; options: Array<{ label: string; trigger: string }>; onTitle: (value: string) => void; onTrigger: (index: number, value: string) => void; locked?: boolean }) {
  return <><label>Poll title<input required maxLength={140} value={title} onChange={e => onTitle(e.target.value)} /></label>{options.map((option, i) => <label key={i}>Trigger for {option.label}<input required maxLength={64} disabled={locked} value={option.trigger} onChange={e => onTrigger(i, e.target.value)} /></label>)}</>;
}
