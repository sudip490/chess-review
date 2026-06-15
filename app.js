/* ============================================================
   Chess Analysis + Play vs a Legend
   - Play vs Legend  -> the legend's REAL games (Lichess database)
   - Analysis        -> modern deep Stockfish (Lichess cloud eval)
   - Local Stockfish -> offline / off-book fallback only
   ============================================================ */

const STOCKFISH_URL = "https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js";
const EXPLORER = "https://explorer.lichess.ovh";
const CLOUD = "https://lichess.org/api/cloud-eval";

/* Each legend plays from a real game database.
   - source "player": that player's own games on Lichess (their real moves).
   - source "masters": the historical masters database (top GMs / champions). */
const LEGENDS = [
  { name: "Magnus Carlsen",   source: "player",  handle: "DrNykterstein", skill: 20, note: "World Champion 2013–2023 — plays his real online games." },
  { name: "Hikaru Nakamura",  source: "player",  handle: "Hikaru",        skill: 20, note: "Super-GM & streamer — his real blitz/rapid repertoire." },
  { name: "Alireza Firouzja", source: "player",  handle: "alireza2003",   skill: 20, note: "Youngest 2800 — sharp, fearless modern play." },
  { name: "Daniel Naroditsky",source: "player",  handle: "RebeccaHarris", skill: 19, note: "GM speed-chess maestro & teacher." },
  { name: "World Champions",  source: "masters", handle: null,            skill: 20, note: "Most-played move from the historical masters database — Fischer, Kasparov, Carlsen & more." },
];

const game = new Chess();
let board = null;
let engine = null;
let engineReady = false;
let enginePrimed = false;      // local engine compiled & warmed up (fallback only)
let analyzing = false;
let watchdog = null;
let lastInfo = { depth: 0, scoreText: "—", scoreCp: 0, pvUci: [] };

// play state
let mode = "analyze";          // "analyze" | "play"
let myColor = "w";
let engineTask = null;         // null | "analyze" | "play" | "warmup"
let currentLegend = LEGENDS[0];
let currentSkill = 20;
let playGen = 0;               // cancels stale async database lookups

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const els = {
  bestMove: $("best-move"), eval: $("eval"), evalFill: $("eval-fill"),
  depth: $("depth"), status: $("status"), pv: $("pv"),
  fenInput: $("fen-input"), analyzeBtn: $("btn-analyze"), stopBtn: $("btn-stop"),
  turnSelect: $("turn-select"), timeSelect: $("time-select"),
  playStatus: $("play-status"), playLog: $("play-log"),
};

/* ---------- Network helpers ---------- */
// Plain single-object JSON (used for the cloud-eval API).
async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { clearTimeout(t); return null; }
}

// The Lichess opening explorer STREAMS NDJSON — it sends progressively-refined
// results while it indexes (the full stream can take minutes). The very first
// line already carries a usable answer, so we read incrementally and return as
// soon as we see a result that has moves, then abort the rest. This turns a
// ~160s wait into ~1-2s.
async function fetchExplorer(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok || !r.body) { clearTimeout(t); return null; }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", last = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();                       // keep the partial last line
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        try {
          const obj = JSON.parse(s);
          last = obj;
          if (obj && Array.isArray(obj.moves) && obj.moves.length) {
            clearTimeout(t);
            try { ctrl.abort(); } catch (e) {}  // stop the long stream early
            return obj;
          }
        } catch (e) { /* partial/invalid line, keep going */ }
      }
    }
    clearTimeout(t);
    if (buf.trim()) { try { last = JSON.parse(buf.trim()); } catch (e) {} }
    return last;
  } catch (e) { clearTimeout(t); return null; }
}

/* ============================================================
   Local Stockfish (fallback only)
   ============================================================ */
async function initEngine() {
  try {
    const res = await fetch(STOCKFISH_URL);
    const code = await res.text();
    const blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    engine = new Worker(blobUrl);
    engine.onmessage = onEngineMessage;
    send("uci");
    send("isready");
  } catch (err) { console.error("Engine load failed", err); }
}

function send(cmd) { if (engine) engine.postMessage(cmd); }
function setSkill(level) {
  if (level !== currentSkill) { send("setoption name Skill Level value " + level); currentSkill = level; }
}

function onEngineMessage(e) {
  let line = "";
  if (typeof e.data === "string") line = e.data;
  else if (e.data && typeof e.data.data === "string") line = e.data.data;
  else return;

  if (line === "uciok") return;
  if (line === "readyok") {
    engineReady = true;
    if (!enginePrimed && !engineTask) warmUp();
    return;
  }
  if (line.startsWith("info")) parseInfo(line);
  else if (line.startsWith("bestmove")) handleBestMove(line);
}

function warmUp() {
  engineTask = "warmup";
  setSkill(20);
  send("ucinewgame"); send("position startpos"); send("go movetime 1");
}

function armWatchdog(ms) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (engineTask === "play") setPlayStatus("Engine is slow on this device — still working…");
  }, ms);
}

function parseInfo(line) {
  if (engineTask !== "analyze") return;       // only local analysis updates the panel
  if (!line.includes(" pv ")) return;

  const depthMatch = line.match(/ depth (\d+)/);
  const cpMatch = line.match(/score cp (-?\d+)/);
  const mateMatch = line.match(/score mate (-?\d+)/);
  const pvMatch = line.match(/ pv (.+)$/);

  const depth = depthMatch ? parseInt(depthMatch[1], 10) : lastInfo.depth;
  const stm = game.turn();
  let scoreText, scoreCp;
  if (mateMatch) {
    let m = parseInt(mateMatch[1], 10); if (stm === "b") m = -m;
    scoreText = "#" + (m < 0 ? "-" : "") + Math.abs(m); scoreCp = m > 0 ? 10000 : -10000;
  } else if (cpMatch) {
    let cp = parseInt(cpMatch[1], 10); if (stm === "b") cp = -cp;
    scoreCp = cp; scoreText = (cp >= 0 ? "+" : "") + (cp / 100).toFixed(2);
  } else return;

  const pvUci = pvMatch ? pvMatch[1].trim().split(/\s+/) : [];
  lastInfo = { depth, scoreText, scoreCp, pvUci };
  renderEval(lastInfo, "");
}

function handleBestMove(line) {
  clearTimeout(watchdog);
  const uci = line.split(" ")[1];

  if (engineTask === "warmup") {
    engineTask = null; enginePrimed = true; return;
  }

  if (engineTask === "play") {                 // off-book engine fallback move
    engineTask = null;
    if (uci && uci !== "(none)") {
      const mv = game.move(uciToMove(uci));
      if (mv) { board.position(game.fen()); highlightMove(mv.from, mv.to);
                logPlay(currentLegend.name + " (engine)", mv.san); syncFen(); }
    }
    if (!checkGameEnd()) { setPlayStatus("Your move."); autoEvalBar(); }
    return;
  }

  // local analysis finished
  finishAnalyze("Done · local engine (offline)");
}

/* ============================================================
   Shared rendering
   ============================================================ */
function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || "q" };
}

// Vertical win/loss bar next to the board. scoreCp is from White's view.
function updateEvalBar(scoreCp, mateText) {
  const fill = $("eval-bar-v-fill");
  const label = $("eval-bar-v-label");
  if (!fill || !label) return;
  const whitePct = 100 / (1 + Math.exp(-scoreCp / 400));   // white fills from bottom
  fill.style.height = whitePct.toFixed(1) + "%";
  let txt;
  if (mateText) txt = mateText.replace("#", "M");
  else if (Math.abs(scoreCp) >= 10000) txt = scoreCp > 0 ? "M" : "-M";
  else txt = (scoreCp >= 0 ? "+" : "") + (scoreCp / 100).toFixed(1);
  label.textContent = txt;
  if (whitePct >= 16) {            // label sits on the white (bottom) side
    label.style.bottom = "3px"; label.style.top = "auto";
    label.style.color = "#1a1a1a"; label.style.textShadow = "0 0 2px rgba(255,255,255,.6)";
  } else {                         // black is winning big — put it on top in light text
    label.style.top = "3px"; label.style.bottom = "auto";
    label.style.color = "#f0f0f0"; label.style.textShadow = "0 0 2px rgba(0,0,0,.6)";
  }
}

// Live bar update while playing — quick cloud eval, no engine needed.
async function autoEvalBar() {
  const fen = game.fen();
  const data = await fetchJson(cloudEvalUrl(fen, 1), 3500);
  if (game.fen() !== fen) return;            // position already changed
  if (data && data.pvs && data.pvs[0]) {
    const pv = data.pvs[0];
    if (pv.mate !== undefined && pv.mate !== null)
      updateEvalBar(pv.mate > 0 ? 10000 : -10000, "#" + Math.abs(pv.mate));
    else updateEvalBar(pv.cp, null);
  }
}

function renderEval(info, sourceLabel) {
  els.depth.textContent = (info.depth || "—") + (sourceLabel ? " (" + sourceLabel + ")" : "");
  els.eval.textContent = info.scoreText;
  els.eval.style.color = info.scoreCp >= 0 ? "var(--good)" : "var(--bad)";
  els.evalFill.style.width = (100 / (1 + Math.exp(-info.scoreCp / 400))).toFixed(1) + "%";
  updateEvalBar(info.scoreCp, (info.scoreText && info.scoreText.charAt(0) === "#") ? info.scoreText : null);

  if (info.pvUci && info.pvUci.length) {
    const tmp = new Chess(game.fen());
    const sans = [];
    for (const u of info.pvUci) { const m = tmp.move(uciToMove(u)); if (!m) break; sans.push(m.san); }
    els.pv.textContent = sans.join("  ") || "—";
    els.bestMove.textContent = sans[0] || info.pvUci[0];
    const f = info.pvUci[0];
    if (f) highlightMove(f.slice(0, 2), f.slice(2, 4));
  }
}

/* ============================================================
   Analysis: Lichess cloud Stockfish (-> local engine fallback)
   ============================================================ */
function cloudEvalUrl(fen, multiPv) {
  return `${CLOUD}?fen=${encodeURIComponent(fen)}&multiPv=${multiPv || 1}`;
}

async function analyze() {
  if (analyzing || engineTask) return;
  analyzing = true;
  els.analyzeBtn.disabled = true;
  els.stopBtn.disabled = false;
  els.bestMove.textContent = "…";
  setStatus("Analyzing — Lichess cloud Stockfish…");

  const data = await fetchJson(cloudEvalUrl(game.fen(), 1), 5000);
  if (data && Array.isArray(data.pvs) && data.pvs.length) {
    const pv = data.pvs[0];
    let scoreText, scoreCp;
    if (pv.mate !== undefined && pv.mate !== null) {       // mate is White-POV
      const m = pv.mate;
      scoreText = "#" + (m < 0 ? "-" : "") + Math.abs(m); scoreCp = m > 0 ? 10000 : -10000;
    } else {
      scoreCp = pv.cp;                                      // cp is White-POV already
      scoreText = (scoreCp >= 0 ? "+" : "") + (scoreCp / 100).toFixed(2);
    }
    const pvUci = (pv.moves || "").split(/\s+/).filter(Boolean);
    renderEval({ depth: data.depth, scoreText, scoreCp, pvUci }, "cloud");
    finishAnalyze("Done · Lichess cloud Stockfish (depth " + data.depth + ")");
    return;
  }
  // not cached in the cloud -> use the local engine
  localAnalyze();
}

function localAnalyze() {
  if (!enginePrimed) { setStatus("Loading local engine…"); setTimeout(localAnalyze, 300); return; }
  setStatus("Analyzing — local engine…");
  engineTask = "analyze";
  setSkill(20);
  send("position fen " + game.fen());
  send("go movetime " + parseInt(els.timeSelect.value, 10));
}

function finishAnalyze(statusMsg) {
  analyzing = false;
  engineTask = null;
  els.analyzeBtn.disabled = false;
  els.stopBtn.disabled = true;
  if (statusMsg) setStatus(statusMsg);
}

function stopAnalysis() { if (analyzing && engineTask === "analyze") send("stop"); }
function setStatus(s) { els.status.textContent = s; }

/* ============================================================
   Play vs a Legend (real game database)
   ============================================================ */
function explorerUrl(src, fen, color) {
  const f = encodeURIComponent(fen);
  if (src.type === "player") {
    const c = color === "w" ? "white" : "black";
    return `${EXPLORER}/player?player=${encodeURIComponent(src.handle)}&color=${c}&fen=${f}&recentGames=0&moves=12`;
  }
  if (src.type === "lichess") {
    return `${EXPLORER}/lichess?fen=${f}&moves=12&topGames=0&recentGames=0` +
           `&speeds=blitz,rapid,classical&ratings=2200,2500`;
  }
  return `${EXPLORER}/masters?fen=${f}&moves=12&topGames=0`;
}

// Order of databases to try so real human moves last as long as possible:
//   their own games -> masters DB -> top-rated Lichess players -> (engine).
function sourceChain(legend) {
  const chain = [];
  if (legend.source === "player") chain.push({ type: "player", handle: legend.handle, tag: "" });
  chain.push({ type: "masters", tag: "masters DB" });
  chain.push({ type: "lichess", tag: "top players" });
  return chain;
}

// Try each database in turn; return the first one that has moves (+ its label).
async function queryBestMove(fen, color, legend) {
  for (const src of sourceChain(legend)) {
    const timeout = src.type === "player" ? 10000 : 5000;  // player streams; others are quick
    const data = await fetchExplorer(explorerUrl(src, fen, color), timeout);
    if (data && Array.isArray(data.moves) && data.moves.length) {
      return { moves: data.moves, tag: src.tag };
    }
  }
  return null;
}

function gamesCount(m) { return (m.white || 0) + (m.draws || 0) + (m.black || 0); }

// Weighted-random among the legend's most-played moves -> varied but realistic.
function pickDbMove(moves) {
  const top = moves.slice(0, 3);
  const total = top.reduce((s, m) => s + gamesCount(m), 0);
  if (total <= 0) return top[0];
  let r = Math.random() * total;
  for (const m of top) { r -= gamesCount(m); if (r <= 0) return m; }
  return top[0];
}

function newGame() {
  playGen++;
  mode = "play";
  engineTask = null;
  currentLegend = LEGENDS[parseInt($("legend-select").value, 10)] || LEGENDS[0];
  myColor = $("color-select").value;
  game.reset();
  board.orientation(myColor === "w" ? "white" : "black");
  board.position("start");
  els.playLog.innerHTML = "";
  clearHighlights();
  syncFen();
  els.bestMove.textContent = "—"; els.pv.textContent = "—";
  els.eval.textContent = "—"; els.depth.textContent = "—";
  updateEvalBar(0, null);

  if (game.turn() !== myColor) requestLegendMove();
  else setPlayStatus(`Your move — ${currentLegend.name} is waiting.`);
}

async function requestLegendMove() {
  const myGen = playGen;
  const legendColor = (myColor === "w") ? "b" : "w";
  engineTask = "play";                          // block the user from moving
  setPlayStatus(`${currentLegend.name} is checking their games… (a few seconds)`);

  let result = null;
  try { result = await queryBestMove(game.fen(), legendColor, currentLegend); } catch (e) { result = null; }
  if (myGen !== playGen) return;                // a new game started meanwhile

  if (result && result.moves.length) {
    const chosen = pickDbMove(result.moves);
    const n = gamesCount(chosen);
    const mv = game.move(uciToMove(chosen.uci));
    engineTask = null;
    if (mv) {
      board.position(game.fen()); highlightMove(mv.from, mv.to);
      const tag = result.tag ? ` (${result.tag})` : "";
      logPlay(currentLegend.name + tag, `${mv.san}  ·  ${n} game${n === 1 ? "" : "s"}`);
      syncFen();
    }
    if (!checkGameEnd()) { setPlayStatus("Your move — answered from a real games database."); autoEvalBar(); }
  } else {
    setPlayStatus(`No database games here — engine plays on…`);
    engineFallbackMove();
  }
}

function engineFallbackMove(tries) {
  tries = tries || 0;
  if (!enginePrimed) {
    if (tries > 12) { playRandomMove(); return; }   // never stall (~3.6s cap)
    setPlayStatus(`${currentLegend.name} is choosing a move…`);
    setTimeout(() => engineFallbackMove(tries + 1), 300);
    return;
  }
  engineTask = "play";
  setSkill(currentLegend.skill || 20);
  send("position fen " + game.fen());
  send("go movetime 1000");
  armWatchdog(5000);
}

// Absolute last resort so the game can always continue.
function playRandomMove() {
  engineTask = null;
  const moves = game.moves({ verbose: true });
  if (!moves.length) { checkGameEnd(); return; }
  const m = moves[Math.floor(Math.random() * moves.length)];
  game.move(m);
  board.position(game.fen()); highlightMove(m.from, m.to);
  logPlay(currentLegend.name + " (fallback)", m.san); syncFen();
  if (!checkGameEnd()) { setPlayStatus("Your move."); autoEvalBar(); }
}

async function hint() {
  if (mode !== "play") { setPlayStatus("Start a game first."); return; }
  if (engineTask || game.turn() !== myColor) return;
  setPlayStatus(`Checking ${currentLegend.name}'s database…`);

  const result = await queryBestMove(game.fen(), myColor, currentLegend);
  if (result && result.moves.length) {
    const top = result.moves[0];
    const tmp = new Chess(game.fen());
    const mv = tmp.move(uciToMove(top.uci));
    const tag = result.tag ? ` (${result.tag})` : "";
    setPlayStatus(`💡 ${currentLegend.name}${tag} played ${mv ? mv.san : top.uci} here (${gamesCount(top)} games).`);
    if (top.uci) highlightMove(top.uci.slice(0, 2), top.uci.slice(2, 4));
    return;
  }
  const data = await fetchJson(cloudEvalUrl(game.fen(), 1), 4000);
  if (data && data.pvs && data.pvs[0]) {
    const u = (data.pvs[0].moves || "").split(/\s+/)[0];
    const tmp = new Chess(game.fen());
    const mv = u ? tmp.move(uciToMove(u)) : null;
    setPlayStatus(`💡 No game on record — engine suggests ${mv ? mv.san : u}.`);
    if (u) highlightMove(u.slice(0, 2), u.slice(2, 4));
  } else {
    setPlayStatus("No database move or cloud eval here — press Analyze.");
  }
}

function logPlay(who, san) {
  const div = document.createElement("div");
  div.innerHTML = `<span class="who">${who}:</span> ${san}`;
  els.playLog.appendChild(div);
  els.playLog.scrollTop = els.playLog.scrollHeight;
}

function checkGameEnd() {
  if (!game.game_over()) return false;
  let msg;
  if (game.in_checkmate())
    msg = game.turn() === myColor ? `Checkmate — ${currentLegend.name} wins. 🏆` : "Checkmate — you win! 🎉";
  else if (game.in_stalemate()) msg = "Stalemate — draw.";
  else if (game.in_draw()) msg = "Draw.";
  else msg = "Game over.";
  setPlayStatus(msg);
  return true;
}

function setPlayStatus(s) { els.playStatus.textContent = s; }

/* ============================================================
   Board
   ============================================================ */
function onDragStart(source, piece) {
  if (game.game_over()) return false;
  if (mode === "play") {
    if (engineTask) return false;               // legend/engine is thinking
    if (piece[0] !== myColor) return false;
    if (game.turn() !== myColor) return false;
    return;
  }
  if ((game.turn() === "w" && piece.search(/^b/) !== -1) ||
      (game.turn() === "b" && piece.search(/^w/) !== -1)) return false;
}

function onDrop(source, target) {
  const move = game.move({ from: source, to: target, promotion: "q" });
  if (move === null) return "snapback";
  if (mode === "play") afterMyMove(move);
  else afterPositionChange();
}

function afterMyMove(move) {
  logPlay("You", move.san);
  syncFen();
  if (checkGameEnd()) return;
  autoEvalBar();                 // refresh the win/loss bar with your move
  requestLegendMove();
}

function onSnapEnd() {
  board.position(game.fen());
  if (mode === "play") {
    const hist = game.history({ verbose: true });
    const last = hist[hist.length - 1];
    if (last) highlightMove(last.from, last.to);
  }
}

function highlightMove(from, to) {
  clearHighlights();
  const $b = $("board");
  const sf = $b.querySelector(".square-" + from);
  const st = $b.querySelector(".square-" + to);
  if (sf) sf.classList.add("highlight-from");
  if (st) st.classList.add("highlight-to");
}

function clearHighlights() {
  document.querySelectorAll(".highlight-from, .highlight-to")
    .forEach((el) => el.classList.remove("highlight-from", "highlight-to"));
}

function syncFen() { els.fenInput.value = game.fen(); els.turnSelect.value = game.turn(); }

function afterPositionChange() {
  syncFen();
  els.bestMove.textContent = "—"; els.pv.textContent = "—";
  updateEvalBar(0, null);
  setStatus("Ready"); clearHighlights();
}

/* ============================================================
   UI wiring
   ============================================================ */
function setupLegendSelect() {
  const sel = $("legend-select");
  LEGENDS.forEach((l, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = l.name; sel.appendChild(o);
  });
  const showStyle = () => {
    const l = LEGENDS[parseInt(sel.value, 10)] || LEGENDS[0];
    const src = l.source === "player" ? "Source: their real Lichess games" : "Source: masters game database";
    $("legend-style").innerHTML =
      `<div class="players">${l.name}</div><div style="margin-top:6px">${l.note}</div>` +
      `<div class="sub" style="margin-top:6px">${src}</div>`;
  };
  sel.addEventListener("change", showStyle);
  showStyle();
  $("btn-newgame").addEventListener("click", newGame);
  $("btn-hint").addEventListener("click", hint);
}

function setup() {
  board = Chessboard("board", {
    draggable: true, position: "start",
    pieceTheme: "assets/pieces/{piece}.png",
    onDragStart, onDrop, onSnapEnd,
  });
  window.addEventListener("resize", () => board.resize());

  els.analyzeBtn.addEventListener("click", analyze);
  els.stopBtn.addEventListener("click", stopAnalysis);
  $("btn-flip").addEventListener("click", () => board.flip());
  $("btn-undo").addEventListener("click", () => {
    if (mode === "play") { game.undo(); game.undo(); } else { game.undo(); }
    board.position(game.fen()); afterPositionChange();
  });
  $("btn-new").addEventListener("click", () => {
    mode = "analyze"; playGen++; engineTask = null;
    game.reset(); board.orientation("white"); board.position("start");
    afterPositionChange();
    setPlayStatus("Pick a legend and press New Game.");
  });
  $("btn-load").addEventListener("click", () => {
    const fen = els.fenInput.value.trim();
    if (game.load(fen)) { board.position(game.fen()); afterPositionChange(); }
    else setStatus("Invalid FEN");
  });
  $("btn-copy").addEventListener("click", () => {
    navigator.clipboard.writeText(game.fen()); setStatus("FEN copied");
  });
  els.turnSelect.addEventListener("change", () => {
    const parts = game.fen().split(" "); parts[1] = els.turnSelect.value;
    if (game.load(parts.join(" "))) board.position(game.fen());
  });

  syncFen();
  setupLegendSelect();
  setStatus("Ready");
  setPlayStatus("Pick a legend and press New Game.");
  loadVisitorCount();
  setupInsights();
  initEngine();                                 // warms up quietly for offline fallback
}

/* ---------- Visitor counter (free, no backend) ---------- */
const VISIT_BASE = "https://abacus.jasoncameron.dev";
const VISIT_NS = "chess-review-sudip490";
const VISIT_KEY = "visits";

function loadVisitorCount() {
  const el = $("visitor-count");
  if (!el) return;
  // Count each browser once (unique-ish visitors); just read the total afterwards.
  const seen = localStorage.getItem("cr_visited");
  const url = seen ? `${VISIT_BASE}/get/${VISIT_NS}/${VISIT_KEY}`
                   : `${VISIT_BASE}/hit/${VISIT_NS}/${VISIT_KEY}`;
  fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && typeof d.value === "number") {
        el.textContent = "👁 " + d.value.toLocaleString() + " visitors";
        if (!seen) localStorage.setItem("cr_visited", "1");
      } else {
        el.style.display = "none";
      }
    })
    .catch(() => { el.style.display = "none"; });
}

/* ============================================================
   Chess.com Insights — type a username, get recent games + overview
   Uses the free Chess.com Published-Data API (no key, CORS-enabled):
     /pub/player/{user}            -> profile
     /pub/player/{user}/stats      -> current ratings
     /pub/player/{user}/games/archives           -> monthly archive URLs
     /pub/player/{user}/games/{YYYY}/{MM}         -> games for that month
   ============================================================ */
const CC_API = "https://api.chess.com/pub";

let ccGames = [];          // all loaded games (normalized), newest first
let ccShown = 0;           // how many of ccGames are currently rendered
const CC_PAGE = 25;

function setupInsights() {
  const goBtn = $("cc-go");
  const input = $("cc-username");
  if (!goBtn || !input) return;
  goBtn.addEventListener("click", runInsights);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") runInsights(); });
  $("cc-more").addEventListener("click", () => renderGames(ccShown + CC_PAGE));
}

function ccSetStatus(msg, isError) {
  const el = $("cc-status");
  el.textContent = msg || "";
  el.classList.toggle("error", !!isError);
}

async function ccFetch(url) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function runInsights() {
  const raw = $("cc-username").value.trim().toLowerCase().replace(/^@/, "");
  if (!raw) { ccSetStatus("Enter a username first.", true); return; }
  const months = parseInt($("cc-months").value, 10) || 3;

  // reset UI
  ["cc-profile", "cc-ratings", "cc-overview", "cc-games-wrap"].forEach((id) => ($(id).hidden = true));
  ccGames = []; ccShown = 0;
  $("cc-go").disabled = true;
  ccSetStatus(`Looking up “${raw}”…`);

  const profile = await ccFetch(`${CC_API}/player/${encodeURIComponent(raw)}`);
  if (!profile || !profile.username) {
    ccSetStatus(`No Chess.com player found for “${raw}”.`, true);
    $("cc-go").disabled = false;
    return;
  }

  const [stats, archives] = await Promise.all([
    ccFetch(`${CC_API}/player/${encodeURIComponent(raw)}/stats`),
    ccFetch(`${CC_API}/player/${encodeURIComponent(raw)}/games/archives`),
  ]);

  renderProfile(profile);
  if (stats) renderRatings(stats);

  // Load the most recent N monthly archives.
  const list = (archives && Array.isArray(archives.archives)) ? archives.archives.slice(-months) : [];
  if (!list.length) {
    ccSetStatus("This player has no public games on record.", false);
    $("cc-go").disabled = false;
    return;
  }
  ccSetStatus(`Loading games from the last ${list.length} month(s)…`);

  const monthly = await Promise.all(list.reverse().map((u) => ccFetch(u)));
  const all = [];
  for (const m of monthly) if (m && Array.isArray(m.games)) all.push(...m.games);

  ccGames = all
    .map((g) => normalizeGame(g, raw))
    .filter(Boolean)
    .sort((a, b) => b.endTime - a.endTime);

  if (!ccGames.length) {
    ccSetStatus("No standard games found in that range.", false);
    $("cc-go").disabled = false;
    return;
  }

  ccSetStatus(`Loaded ${ccGames.length} games for ${profile.username}.`);
  renderOverview(ccGames, raw);
  $("cc-games-count").textContent = `(${ccGames.length})`;
  $("cc-games-wrap").hidden = false;
  renderGames(CC_PAGE);
  $("cc-go").disabled = false;
}

/* ---------- Normalize a Chess.com game into what we need ---------- */
function normalizeGame(g, user) {
  if (!g || !g.white || !g.black) return null;
  if (g.rules && g.rules !== "chess") return null;   // skip variants (chess960, bughouse, …)
  const meIsWhite = (g.white.username || "").toLowerCase() === user;
  const me = meIsWhite ? g.white : g.black;
  const opp = meIsWhite ? g.black : g.white;
  if (!me || !opp) return null;

  let outcome, reason;
  if (me.result === "win") { outcome = "win"; reason = "won"; }
  else if (["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"].includes(me.result)) {
    outcome = "draw"; reason = me.result;
  } else { outcome = "loss"; reason = me.result; }

  return {
    outcome, reason,
    oppResult: opp.result,            // how the opponent finished (for win breakdowns)
    color: meIsWhite ? "white" : "black",
    myRating: me.rating || 0,
    oppName: opp.username || "?",
    oppRating: opp.rating || 0,
    timeClass: g.time_class || "—",
    url: g.url || null,
    endTime: (g.end_time || 0) * 1000,
    opening: openingFromPgn(g.pgn),
  };
}

function openingFromPgn(pgn) {
  if (!pgn) return null;
  const m = pgn.match(/\[ECOUrl "https:\/\/www\.chess\.com\/openings\/([^"]+)"\]/);
  if (m) {
    let slug = decodeURIComponent(m[1]);
    slug = slug.split("...")[0];          // drop the "...moves" tail
    slug = slug.replace(/-\d+\..*$/, ""); // drop "-3.Nf3…" move-number tails
    slug = slug.replace(/-?\d+(\.\d+)?$/, ""); // drop a trailing variation number
    return slug.replace(/-/g, " ").trim();
  }
  const eco = pgn.match(/\[ECO "([^"]+)"\]/);
  return eco ? eco[1] : null;
}

/* ---------- Rendering ---------- */
function renderProfile(p) {
  const el = $("cc-profile");
  const avatar = p.avatar || "https://www.chess.com/bundles/web/images/user-image.007dad08.svg";
  const bits = [];
  if (p.title) bits.push(`<strong style="color:var(--good)">${p.title}</strong>`);
  if (p.country) bits.push(p.country.split("/").pop());
  if (typeof p.followers === "number") bits.push(`${p.followers.toLocaleString()} followers`);
  if (p.joined) bits.push("Joined " + new Date(p.joined * 1000).getFullYear());
  if (p.last_online) bits.push("Last online " + new Date(p.last_online * 1000).toLocaleDateString());

  el.innerHTML =
    `<img src="${avatar}" alt="" onerror="this.style.display='none'" />` +
    `<div>` +
    `<div class="name"><a href="${p.url}" target="_blank" rel="noopener">${p.username}</a></div>` +
    `<div class="meta">${bits.join(" · ") || "—"}</div>` +
    `</div>`;
  el.hidden = false;
}

function renderRatings(stats) {
  const el = $("cc-ratings");
  const cards = [];
  const add = (label, obj) => {
    if (obj && obj.last && obj.last.rating) {
      const rec = obj.record || {};
      const sub = (rec.win != null) ? `${rec.win}W ${rec.loss || 0}L ${rec.draw || 0}D` : "";
      cards.push(`<div class="cc-rating-card"><div class="rc-label">${label}</div>` +
                 `<div class="rc-value">${obj.last.rating}</div>` +
                 `<div class="rc-sub">${sub}</div></div>`);
    }
  };
  add("Bullet", stats.chess_bullet);
  add("Blitz", stats.chess_blitz);
  add("Rapid", stats.chess_rapid);
  add("Daily", stats.chess_daily);
  if (stats.tactics && stats.tactics.highest)
    cards.push(`<div class="cc-rating-card"><div class="rc-label">Puzzles (best)</div>` +
               `<div class="rc-value">${stats.tactics.highest.rating}</div><div class="rc-sub"></div></div>`);

  if (!cards.length) { el.hidden = true; return; }
  el.innerHTML = cards.join("");
  el.hidden = false;
}

function pct(n, total) { return total ? Math.round((n / total) * 100) : 0; }

function renderOverview(games, user) {
  const el = $("cc-overview");
  const total = games.length;
  let w = 0, l = 0, d = 0;
  const byColor = { white: { w: 0, t: 0 }, black: { w: 0, t: 0 } };
  const byClass = {};
  const openings = {};
  const lossReasons = {};
  const winReasons = {};

  for (const g of games) {
    if (g.outcome === "win") w++; else if (g.outcome === "loss") l++; else d++;
    byColor[g.color].t++;
    if (g.outcome === "win") byColor[g.color].w++;
    const c = g.timeClass;
    byClass[c] = byClass[c] || { w: 0, l: 0, d: 0, t: 0 };
    byClass[c].t++; byClass[c][g.outcome === "win" ? "w" : g.outcome === "loss" ? "l" : "d"]++;
    if (g.opening) openings[g.opening] = (openings[g.opening] || 0) + 1;
    if (g.outcome === "loss") lossReasons[g.reason] = (lossReasons[g.reason] || 0) + 1;
    if (g.outcome === "win" && g.oppResult) winReasons[g.oppResult] = (winReasons[g.oppResult] || 0) + 1;
  }

  const winRate = pct(w, total);
  const topOpenings = Object.entries(openings).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topClasses = Object.entries(byClass).sort((a, b) => b[1].t - a[1].t);
  const reasonLabels = {
    checkmated: "Checkmated", resigned: "Resigned", timeout: "Lost on time",
    abandoned: "Abandoned", lose: "Lost", kingofthehill: "King of the hill", threecheck: "Three-check",
  };
  const winLabels = {
    checkmated: "By checkmate", resigned: "Opponent resigned", timeout: "Opponent lost on time",
    abandoned: "Opponent abandoned", kingofthehill: "King of the hill", threecheck: "Three-check",
  };
  const topReasons = Object.entries(lossReasons).sort((a, b) => b[1] - a[1]);
  const topWins = Object.entries(winReasons).sort((a, b) => b[1] - a[1]);

  const statRow =
    `<div class="cc-stat-row">` +
    `<div class="cc-stat"><div class="s-value">${total}</div><div class="s-label">Games</div></div>` +
    `<div class="cc-stat"><div class="s-value s-win">${w}</div><div class="s-label">Wins</div></div>` +
    `<div class="cc-stat"><div class="s-value s-draw">${d}</div><div class="s-label">Draws</div></div>` +
    `<div class="cc-stat"><div class="s-value s-loss">${l}</div><div class="s-label">Losses</div></div>` +
    `<div class="cc-stat"><div class="s-value">${winRate}%</div><div class="s-label">Win rate</div></div>` +
    `</div>`;

  const wdlBar =
    `<div class="cc-wdl-bar">` +
    `<div class="b-win" style="width:${pct(w, total)}%">${pct(w, total) >= 8 ? pct(w, total) + "%" : ""}</div>` +
    `<div class="b-draw" style="width:${pct(d, total)}%">${pct(d, total) >= 8 ? pct(d, total) + "%" : ""}</div>` +
    `<div class="b-loss" style="width:${pct(l, total)}%">${pct(l, total) >= 8 ? pct(l, total) + "%" : ""}</div>` +
    `</div>`;

  const colorPanel =
    `<div class="cc-panel"><h4>By color (win rate)</h4><div class="cc-bars">` +
    ["white", "black"].map((c) => barLine(
      `As ${c}`, pct(byColor[c].w, byColor[c].t), `${pct(byColor[c].w, byColor[c].t)}% · ${byColor[c].t}`
    )).join("") +
    `</div></div>`;

  const classPanel =
    `<div class="cc-panel"><h4>By time control</h4><div class="cc-bars">` +
    topClasses.map(([name, s]) => barLine(
      name.charAt(0).toUpperCase() + name.slice(1), pct(s.w, s.t), `${pct(s.w, s.t)}% · ${s.t}`
    )).join("") +
    `</div></div>`;

  const openingsPanel = topOpenings.length
    ? `<div class="cc-panel"><h4>Most played openings</h4><div class="cc-bars">` +
      topOpenings.map(([name, n]) => barLine(name, pct(n, total), String(n))).join("") +
      `</div></div>`
    : "";

  const winsPanel = topWins.length
    ? `<div class="cc-panel"><h4>How wins happened</h4><div class="cc-bars">` +
      topWins.map(([r, n]) => barLine(winLabels[r] || r, pct(n, w), String(n))).join("") +
      `</div></div>`
    : "";

  const reasonsPanel = topReasons.length
    ? `<div class="cc-panel"><h4>How losses happened</h4><div class="cc-bars">` +
      topReasons.map(([r, n]) => barLine(reasonLabels[r] || r, pct(n, l), String(n))).join("") +
      `</div></div>`
    : "";

  el.innerHTML =
    statRow + wdlBar +
    `<div class="cc-two-col">${colorPanel}${classPanel}</div>` +
    `<div class="cc-two-col">${winsPanel}${reasonsPanel}</div>` +
    (openingsPanel ? `<div class="cc-two-col">${openingsPanel}</div>` : "");
  el.hidden = false;
}

function barLine(name, widthPct, numText) {
  return `<div class="cc-bar-line"><span class="bl-name" title="${name}">${name}</span>` +
         `<div class="cc-bar-track"><div style="width:${Math.max(2, widthPct)}%"></div></div>` +
         `<span class="bl-num">${numText}</span></div>`;
}

function renderGames(count) {
  const el = $("cc-games");
  ccShown = Math.min(count, ccGames.length);
  const reasonShort = {
    won: "won", checkmated: "checkmate", resigned: "resign", timeout: "time",
    agreed: "agreed", repetition: "repetition", stalemate: "stalemate",
    insufficient: "insufficient", "50move": "50-move", timevsinsufficient: "time vs ins.",
    abandoned: "abandoned",
  };
  el.innerHTML = ccGames.slice(0, ccShown).map((g) => {
    const cls = g.outcome === "win" ? "s-win" : g.outcome === "loss" ? "s-loss" : "s-draw";
    const tag = g.outcome === "win" ? "W" : g.outcome === "loss" ? "L" : "D";
    const date = g.endTime ? new Date(g.endTime).toLocaleDateString() : "";
    const link = g.url ? `<a class="g-link" href="${g.url}" target="_blank" rel="noopener">view ↗</a>` : "";
    return `<div class="cc-game">` +
      `<span class="g-result ${cls}">${tag}</span>` +
      `<span class="g-opp">vs ${g.oppName} <span class="g-sub">(${g.oppRating || "?"})</span>` +
      `<div class="g-reason">${g.color} · ${reasonShort[g.reason] || g.reason} · ${date}</div></span>` +
      `<span class="g-class">${g.timeClass}</span>` +
      `${link}</div>`;
  }).join("");
  $("cc-more").hidden = ccShown >= ccGames.length;
}

window.addEventListener("DOMContentLoaded", setup);
