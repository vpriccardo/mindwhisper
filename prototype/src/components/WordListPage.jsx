import { groupWordsByCategory } from "../modules/helpers.js";
import { CATEGORIES } from "../modules/catalog.js";
import { ThemeToggle } from "./ui.jsx";

export function WordListPage({ onBack, theme, onToggleTheme }) {
  const groups = groupWordsByCategory(CATEGORIES);

  return (
    <div className="app">
      <header className="top">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
        >
          Mindwhisper
        </a>
        <div className="top-actions">
          <button type="button" className="nav-link" onClick={onBack}>
            Coach
          </button>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </header>

      <main className="words-page">
        <h1>Parole per categoria</h1>
        <p className="lead">Lista di prova per il performer — cosa è disponibile in ogni cella.</p>

        {groups.map((cat) => (
          <section key={cat.id} className="cat-block">
            <h2>{cat.title}</h2>
            {cat.groups.map((g) => (
              <div key={g.key} className="group">
                <h3>{g.label}</h3>
                <div className="bank">
                  {g.words.map((w) => (
                    <span key={w}>{w}</span>
                  ))}
                </div>
              </div>
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
