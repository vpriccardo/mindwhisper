import { useCallback, useEffect, useMemo, useState } from "react";
import { CATEGORIES, getCategory } from "./modules/catalog.js";
import {
  cellKeyFromTraits,
  getCellWords,
  hasTree,
  traitsForWord,
  wordsInForce,
  pathForWord,
  letterInWord,
  wordsUnderNode,
  cap,
} from "./modules/helpers.js";
import {
  ChoiceButton,
  Prompt,
  Flash,
  Crumbs,
  ModeToggle,
  ThemeToggle,
  FooterBar,
  OutsDialog,
  ContextBar,
} from "./components/ui.jsx";
import { WordListPage } from "./components/WordListPage.jsx";

const THEME_KEY = "mw-theme";

function readTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readRoute() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return path === "/words" || path.startsWith("/words/") ? "words" : "coach";
}

function createState(mode, categoryId = null) {
  return {
    mode,
    categoryId,
    step: categoryId ? "force" : "category",
    force: null,
    traitValues: {},
    traitIndex: 0,
    node: null,
    history: [],
    secret: null,
    peek: false,
    pathLog: [],
    drillExpected: null,
  };
}

export default function App() {
  const [theme, setTheme] = useState(readTheme);
  const [route, setRoute] = useState(readRoute);
  const [state, setState] = useState(() => createState("live"));
  const [flash, setFlash] = useState(null);
  const [outsOpen, setOutsOpen] = useState(false);

  const mod = state.categoryId ? getCategory(state.categoryId) : null;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
    const meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#000000" : "#ffffff");
    document
      .querySelectorAll('meta[name="theme-color"][media]')
      .forEach((el) => {
        const dark = el.media.includes("dark");
        el.setAttribute("content", dark ? "#000000" : "#ffffff");
      });
  }, [theme]);

  useEffect(() => {
    const onNav = () => setRoute(readRoute());
    window.addEventListener("popstate", onNav);
    return () => window.removeEventListener("popstate", onNav);
  }, []);

  const showFlash = useCallback((message, kind) => {
    setFlash({ message, kind });
    window.clearTimeout(showFlash._t);
    showFlash._t = window.setTimeout(() => setFlash(null), 2200);
  }, []);

  const crumbSteps = useMemo(() => {
    if (!mod) return [{ id: "category", label: "Cat" }];
    return [
      { id: "force", label: mod.forceLabel },
      ...mod.traits.map((t) => ({ id: t.id, label: t.label })),
      { id: "leaf", label: "PA" },
      { id: "finish", label: "Reveal" },
    ];
  }, [mod]);

  const crumbValues = useMemo(() => {
    const values = { category: mod?.title };
    if (state.force) values.force = cap(state.force);
    for (const [k, v] of Object.entries(state.traitValues)) values[k] = v;
    return values;
  }, [mod, state.force, state.traitValues]);

  const currentKey = useMemo(() => {
    if (!mod || !state.force) return null;
    if (mod.traits.some((t) => !state.traitValues[t.id])) return null;
    return cellKeyFromTraits(state.force, mod.traits, state.traitValues);
  }, [mod, state.force, state.traitValues]);

  const remainingWords = useMemo(() => {
    if (!mod) return [];
    if (!currentKey) {
      if (state.force) return wordsInForce(mod, state.force);
      return [];
    }
    if (state.node) return wordsUnderNode(state.node);
    return getCellWords(mod, currentKey);
  }, [mod, currentKey, state.force, state.node]);

  function pushAnd(next) {
    setState((s) => ({
      ...next(s),
      history: [
        ...s.history,
        {
          step: s.step,
          force: s.force,
          traitValues: { ...s.traitValues },
          traitIndex: s.traitIndex,
          node: s.node,
          pathLog: [...s.pathLog],
        },
      ],
    }));
  }

  function chooseCategory(id) {
    pushAnd((s) => ({
      ...s,
      categoryId: id,
      step: "force",
      force: null,
      traitValues: {},
      traitIndex: 0,
      node: null,
      secret: null,
      peek: false,
      pathLog: [`cat:${id}`],
      drillExpected: null,
    }));
  }

  function chooseForce(force) {
    setState((s) => {
      const category = getCategory(s.categoryId);
      let secret = s.secret;
      let drillExpected = s.drillExpected;

      if (s.mode === "drill" && !secret) {
        const pool = wordsInForce(category, force);
        secret = pool[Math.floor(Math.random() * pool.length)];
        drillExpected = traitsForWord(category, secret);
      }

      if (s.mode === "drill" && drillExpected && drillExpected.force !== force) {
        showFlash(`Drill: la parola è in ${cap(drillExpected.force)}.`, "bad");
        return s;
      }

      return {
        ...s,
        history: [
          ...s.history,
          {
            step: s.step,
            force: s.force,
            traitValues: { ...s.traitValues },
            traitIndex: s.traitIndex,
            node: s.node,
            pathLog: [...s.pathLog],
          },
        ],
        force,
        secret,
        drillExpected,
        pathLog: [...s.pathLog, `force:${force}`],
        step: category.traits[0]?.id || "leaf",
        traitIndex: 0,
        traitValues: {},
        node: null,
      };
    });
  }

  function chooseTrait(traitId, value) {
    if (!mod) return;
    if (state.mode === "drill" && state.drillExpected) {
      const expected = state.drillExpected.traitValues[traitId];
      if (expected !== value) {
        showFlash(`Atteso ${expected} (parola: ${state.secret}).`, "bad");
        return;
      }
      showFlash("Ok.", "ok");
    }

    pushAnd((s) => {
      const category = getCategory(s.categoryId);
      const traitValues = { ...s.traitValues, [traitId]: value };
      const nextIndex = s.traitIndex + 1;
      const pathLog = [...s.pathLog, `${traitId}:${value}`];

      if (nextIndex < category.traits.length) {
        return {
          ...s,
          traitValues,
          traitIndex: nextIndex,
          step: category.traits[nextIndex].id,
          pathLog,
        };
      }

      const key = cellKeyFromTraits(s.force, category.traits, traitValues);
      pathLog.push(`cell:${key}`);
      const node = hasTree(category, key) ? category.trees[key] : null;
      return {
        ...s,
        traitValues,
        traitIndex: nextIndex,
        pathLog,
        node,
        step: "leaf",
      };
    });
  }

  function chooseLetter(answer) {
    const node = state.node;
    if (!node?.letter) return;

    if (state.mode === "drill" && state.secret) {
      const expected = letterInWord(state.secret, node.letter) ? "yes" : "no";
      if (answer !== expected) {
        showFlash(
          `Atteso ${expected === "yes" ? "Sì" : "No"} per «${node.letter}» (${state.secret}).`,
          "bad",
        );
        return;
      }
      showFlash("Ok.", "ok");
    }

    pushAnd((s) => {
      const next = answer === "yes" ? s.node.yes : s.node.no;
      const pathLog = [...s.pathLog, `${s.node.letter}:${answer}`];
      const done = Boolean(next?.reveal || next?.silentPass);
      return {
        ...s,
        node: next,
        pathLog,
        step: done ? "finish" : "leaf",
      };
    });
  }

  function finishPendingBank() {
    if (!mod || !currentKey) return;
    const words = getCellWords(mod, currentKey);
    pushAnd((s) => ({
      ...s,
      step: "finish",
      node: { reveal: words, pending: true },
    }));
  }

  function goBack() {
    setState((s) => {
      if (!s.history.length) return s;
      const history = [...s.history];
      const prev = history.pop();
      return {
        ...s,
        history,
        step: prev.step,
        force: prev.force,
        traitValues: prev.traitValues,
        traitIndex: prev.traitIndex,
        node: prev.node,
        pathLog: prev.pathLog,
        categoryId: prev.step === "category" ? null : s.categoryId,
      };
    });
  }

  function restart() {
    setFlash(null);
    setState((s) => createState(s.mode, s.categoryId));
  }

  function changeMode(mode) {
    setFlash(null);
    setState(createState(mode));
  }

  function openWords() {
    window.history.pushState({}, "", "/words");
    setRoute("words");
  }

  function openCoach() {
    window.history.pushState({}, "", "/");
    setRoute("coach");
  }

  // Auto-advance leaf → finish when node is already a reveal
  useEffect(() => {
    if (state.step !== "leaf" || !state.node) return;
    if (state.node.reveal || state.node.silentPass) {
      setState((s) => {
        if (s.step !== "leaf" || !(s.node?.reveal || s.node?.silentPass)) return s;
        return {
          ...s,
          history: [
            ...s.history,
            {
              step: s.step,
              force: s.force,
              traitValues: { ...s.traitValues },
              traitIndex: s.traitIndex,
              node: s.node,
              pathLog: [...s.pathLog],
            },
          ],
          step: "finish",
        };
      });
    }
  }, [state.step, state.node]);

  if (route === "words") {
    return (
      <WordListPage
        onBack={openCoach}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
      />
    );
  }

  return (
    <div className="app">
      <header className="top">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            restart();
          }}
        >
          Mindwhisper
        </a>
        <div className="top-actions">
          <a
            className="nav-link"
            href="/words"
            onClick={(e) => {
              e.preventDefault();
              openWords();
            }}
          >
            Parole
          </a>
          <ModeToggle mode={state.mode} onChange={changeMode} />
          <ThemeToggle
            theme={theme}
            onToggle={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          />
        </div>
      </header>

      <main className="shell">
        <Crumbs steps={crumbSteps} current={state.step} values={crumbValues} />

        <section className="stage" aria-live="polite">
          {state.step === "category" && (
            <>
              <Prompt eyebrow="Categoria" note="App di test — scegli il set.">
                Cosa stai forzando?
              </Prompt>
              <div className="actions">
                {CATEGORIES.map((c) => (
                  <ChoiceButton
                    key={c.id}
                    label={c.title}
                    hint={`${Object.keys(c.forceOptions).length} forze · ${c.traits.length} frame`}
                    onClick={() => chooseCategory(c.id)}
                  />
                ))}
              </div>
            </>
          )}

          {state.step === "force" && mod && (
            <>
              <Prompt eyebrow={mod.forceLabel}>{mod.forcePrompt}</Prompt>
              <div className={`actions${Object.keys(mod.forceOptions).length <= 2 ? " cols-2" : ""}`}>
                {Object.entries(mod.forceOptions).map(([id, label]) => (
                  <ChoiceButton key={id} label={label} onClick={() => chooseForce(id)} />
                ))}
              </div>
            </>
          )}

          {mod &&
            mod.traits.map((trait, i) =>
              state.step === trait.id ? (
                <div key={trait.id}>
                  <Prompt eyebrow={`Frame ${i + 1} — ${trait.label}`}>{trait.prompt}</Prompt>
                  <div className="actions cols-2">
                    {trait.values.map((v) => (
                      <ChoiceButton
                        key={v.id}
                        label={v.label}
                        hint={v.hint}
                        onClick={() => chooseTrait(trait.id, v.id)}
                      />
                    ))}
                  </div>
                </div>
              ) : null,
            )}

          {state.step === "leaf" && mod && currentKey && !hasTree(mod, currentKey) && (
            <>
              <Prompt eyebrow={`Foglia · ${currentKey}`}>Banca chiusa</Prompt>
              <p className="pending">
                Albero PA non ancora verificato. Usa outs se serve.
              </p>
              <div className="bank">
                {getCellWords(mod, currentKey).map((w) => (
                  <span key={w}>{w}</span>
                ))}
              </div>
              <div className="actions">
                <ChoiceButton label="Chiudi / outs" hint="Reveal della banca" onClick={finishPendingBank} />
              </div>
            </>
          )}

          {state.step === "leaf" && mod && state.node?.letter && (
            <>
              <Prompt eyebrow="Reverse PA">
                {mod.letterPrompt(state.node.letter)}
              </Prompt>
              <div className="actions cols-2">
                <ChoiceButton
                  big
                  label="Sì"
                  hint={`C’è ${state.node.letter}`}
                  onClick={() => chooseLetter("yes")}
                />
                <ChoiceButton
                  big
                  label="No"
                  hint={`Non c’è ${state.node.letter}`}
                  onClick={() => chooseLetter("no")}
                />
              </div>
            </>
          )}

          {state.step === "finish" && (
            <FinishView
              state={state}
              mod={mod}
              currentKey={currentKey}
              onAgain={() => setState((s) => createState(s.mode, s.categoryId))}
            />
          )}
        </section>

        <ContextBar
          mode={state.mode}
          secret={state.secret}
          peek={state.peek}
          onPeek={() => setState((s) => ({ ...s, peek: !s.peek }))}
          words={remainingWords}
          showBank={state.step === "leaf" || state.step === "finish"}
        />

        <Flash message={flash?.message} kind={flash?.kind} />
      </main>

      <FooterBar
        canBack={state.history.length > 0}
        onBack={goBack}
        onRestart={restart}
        onOuts={() => setOutsOpen(true)}
      />

      <OutsDialog
        open={outsOpen}
        outs={mod?.outs || []}
        forceLabel={state.force ? cap(state.force) : null}
        onClose={() => setOutsOpen(false)}
      />
    </div>
  );
}

function FinishView({ state, mod, currentKey, onAgain }) {
  const node = state.node;
  const raw = node?.reveal || node?.silentPass || (currentKey ? getCellWords(mod, currentKey) : []);
  const words =
    mod?.id === "carte-gioco-it" && state.force
      ? raw.map((w) => `${w} di ${state.force}`)
      : raw;
  const silent = Boolean(node?.silentPass);
  const pending = Boolean(node?.pending);

  let eyebrow = "Reveal";
  let prompt = "Binario finale";
  if (pending) {
    eyebrow = "Banca · tree pending";
    prompt = "Shortlist:";
  } else if (silent) {
    eyebrow = "Silent / pass";
    prompt = "Due restano — Trinity.";
  } else if (words.length === 1) {
    prompt = "Reveal:";
  }

  const drillSummary =
    state.mode === "drill" && state.secret
      ? (() => {
          const hit = raw.map((w) => w.toLowerCase()).includes(state.secret.toLowerCase());
          const tree = mod?.trees?.[currentKey];
          const ideal = tree ? pathForWord(tree, state.secret) : null;
          const idealStr = ideal
            ? ideal.map((p) => `${p.letter}:${p.answer === "yes" ? "Sì" : "No"}`).join(" → ")
            : "—";
          return { hit, idealStr };
        })()
      : null;

  return (
    <>
      <Prompt eyebrow={eyebrow}>{prompt}</Prompt>
      {pending ? (
        <div className="bank">
          {words.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
      ) : (
        <p className="reveal-word">
          {silent || words.length > 1 ? words.join(silent ? " · " : " / ") : words[0]}
        </p>
      )}

      {drillSummary && (
        <p className="summary">
          Drill: <strong>{state.secret}</strong> — {drillSummary.hit ? "in target ✓" : "fuori target"}
          <br />
          Path: <code>{state.pathLog.join(" · ")}</code>
          <br />
          Ideale PA: <code>{drillSummary.idealStr}</code>
        </p>
      )}

      <div className="actions">
        <ChoiceButton
          label="Nuova prova"
          hint={state.mode === "drill" ? "Stessa categoria" : "Ricomincia dalla forza"}
          onClick={onAgain}
        />
      </div>
    </>
  );
}
