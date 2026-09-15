export function ChoiceButton({ label, hint, onClick, big }) {
  return (
    <button type="button" className={`choice${big ? " big-letter" : ""}`} onClick={onClick}>
      <span className="label">{label}</span>
      {hint ? <span className="hint">{hint}</span> : null}
    </button>
  );
}

export function Prompt({ eyebrow, children, note }) {
  return (
    <>
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <p className="prompt">{children}</p>
      {note ? <p className="note">{note}</p> : null}
    </>
  );
}

export function Flash({ message, kind }) {
  if (!message) return null;
  return <p className={`flash is-${kind}`}>{message}</p>;
}

export function Crumbs({ steps, current, values }) {
  const idx = steps.findIndex((s) => s.id === current);
  return (
    <nav className="crumbs" aria-label="Progresso">
      {steps.map((s, i) => {
        let cls = "crumb";
        if (i < idx) cls += " is-done";
        if (i === idx) cls += " is-now";
        const value = values[s.id];
        const text = value ? `${s.label} · ${value}` : s.label;
        return (
          <span key={s.id} className={cls}>
            {text}
          </span>
        );
      })}
    </nav>
  );
}

export function ModeToggle({ mode, onChange }) {
  return (
    <div className="seg" role="group" aria-label="Modalità">
      <button
        type="button"
        className={`seg-btn${mode === "live" ? " is-active" : ""}`}
        onClick={() => onChange("live")}
      >
        Live
      </button>
      <button
        type="button"
        className={`seg-btn${mode === "drill" ? " is-active" : ""}`}
        onClick={() => onChange("drill")}
      >
        Drill
      </button>
    </div>
  );
}

export function ThemeToggle({ theme, onToggle }) {
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={onToggle}
      aria-label={theme === "light" ? "Tema scuro" : "Tema chiaro"}
      title={theme === "light" ? "Nero" : "Bianco"}
    >
      {theme === "light" ? "●" : "○"}
    </button>
  );
}

export function FooterBar({ canBack, onBack, onRestart, onOuts }) {
  return (
    <footer className="bar">
      <button type="button" className="btn" onClick={onBack} disabled={!canBack}>
        Indietro
      </button>
      <button type="button" className="btn" onClick={onRestart}>
        Ricomincia
      </button>
      <button type="button" className="btn" onClick={onOuts}>
        Outs
      </button>
    </footer>
  );
}

export function OutsDialog({ open, outs, forceLabel, onClose }) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="outs-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="outs-title">Outs</h2>
        {outs.map((o) => (
          <article key={o.id} className="out-card">
            <h3>{o.title}</h3>
            <p>{o.script.replace("[force]", forceLabel || "…")}</p>
          </article>
        ))}
        <button type="button" className="btn primary" onClick={onClose} style={{ width: "100%" }}>
          Chiudi
        </button>
      </div>
    </div>
  );
}

export function ContextBar({ mode, secret, peek, onPeek, words, showBank }) {
  if (mode === "drill") {
    if (!secret) {
      return (
        <aside className="context">Scegli la forza — poi estraggo una parola per il drill.</aside>
      );
    }
    return (
      <aside className="context">
        Parola segreta:{" "}
        <button type="button" className="secret-btn" onClick={onPeek}>
          {peek ? secret : "••••••••"}
        </button>
      </aside>
    );
  }

  if (!words.length) return null;

  return (
    <aside className="context">
      Candidati: <strong>{words.length}</strong>
      {showBank ? (
        <div className="bank" style={{ marginTop: "0.55rem" }}>
          {words.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
