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

// The Lichess opening explorer may answer with a single JSON object OR stream
// NDJSON (one object per line, the last being the final result — the player
// index is built on demand). Read it all and return the last valid object.
async function fetchExplorer(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const text = (await r.text()).trim();
    if (!text) return null;
    const lines = text.split(/\r?\n+/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch (e) { /* keep scanning back */ }
    }
    return null;
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
    if (!checkGameEnd()) setPlayStatus("Your move.");
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

function renderEval(info, sourceLabel) {
  els.depth.textContent = (info.depth || "—") + (sourceLabel ? " (" + sourceLabel + ")" : "");
  els.eval.textContent = info.scoreText;
  els.eval.style.color = info.scoreCp >= 0 ? "var(--good)" : "var(--bad)";
  els.evalFill.style.width = (100 / (1 + Math.exp(-info.scoreCp / 400))).toFixed(1) + "%";

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
function dbUrl(fen, legendColor) {
  const f = encodeURIComponent(fen);
  if (currentLegend.source === "player") {
    const c = legendColor === "w" ? "white" : "black";
    return `${EXPLORER}/player?player=${encodeURIComponent(currentLegend.handle)}&color=${c}&fen=${f}&recentGames=0&moves=12`;
  }
  return `${EXPLORER}/masters?fen=${f}&moves=12&topGames=0`;
}

async function queryDb(fen, legendColor) {
  const data = await fetchExplorer(dbUrl(fen, legendColor), 9000);
  if (!data || !Array.isArray(data.moves) || !data.moves.length) return null;
  return data.moves;
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

  if (game.turn() !== myColor) requestLegendMove();
  else setPlayStatus(`Your move — ${currentLegend.name} is waiting.`);
}

async function requestLegendMove() {
  const myGen = playGen;
  const legendColor = (myColor === "w") ? "b" : "w";
  engineTask = "play";                          // block the user from moving
  setPlayStatus(`${currentLegend.name} is consulting the database…`);

  let moves = null;
  try { moves = await queryDb(game.fen(), legendColor); } catch (e) { moves = null; }
  if (myGen !== playGen) return;                // a new game started meanwhile

  if (moves && moves.length) {
    const chosen = pickDbMove(moves);
    const n = gamesCount(chosen);
    const mv = game.move(uciToMove(chosen.uci));
    engineTask = null;
    if (mv) {
      board.position(game.fen()); highlightMove(mv.from, mv.to);
      logPlay(currentLegend.name, `${mv.san}  ·  ${n} game${n === 1 ? "" : "s"}`);
      syncFen();
    }
    if (!checkGameEnd()) setPlayStatus(`Your move — ${currentLegend.name} answered from real games.`);
  } else {
    setPlayStatus(`Past ${currentLegend.name}'s known games — engine plays on…`);
    engineFallbackMove();
  }
}

function engineFallbackMove() {
  if (!enginePrimed) { setPlayStatus("Loading engine for continuation…"); setTimeout(engineFallbackMove, 300); return; }
  engineTask = "play";
  setSkill(currentLegend.skill || 20);
  send("position fen " + game.fen());
  send("go movetime 1000");
  armWatchdog(5000);
}

async function hint() {
  if (mode !== "play") { setPlayStatus("Start a game first."); return; }
  if (engineTask || game.turn() !== myColor) return;
  setPlayStatus(`Checking ${currentLegend.name}'s database…`);

  const moves = await queryDb(game.fen(), myColor);
  if (moves && moves.length) {
    const top = moves[0];
    const tmp = new Chess(game.fen());
    const mv = tmp.move(uciToMove(top.uci));
    setPlayStatus(`💡 ${currentLegend.name} played ${mv ? mv.san : top.uci} here (${gamesCount(top)} games).`);
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

window.addEventListener("DOMContentLoaded", setup);
